import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { getUserByUsername, verifyPassword } from "../repositories/user-repository.js";
import { insertAuditLog } from "../repositories/audit-repository.js";
import { revokeJti } from "../repositories/jwt-blacklist-repository.js";
import { env } from "../config/env.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { isAuthTokenPayload, resolveAuthUserFromJwtPayload } from "../services/auth-session.js";

interface LoginBody {
  username: string;
  password: string;
}

const loginSchema = {
  type: "object" as const,
  additionalProperties: false,
  required: ["username", "password"],
  properties: {
    username: { type: "string" as const, minLength: 1, maxLength: 50 },
    password: { type: "string" as const, minLength: 1, maxLength: 256 },
  },
};

const TOKEN_TTL_SECONDS = 86_400; // 1 day

interface AuthTokenPayload {
  username: string;
  id: number;
  role: string;
  jti: string;
  authVersion?: number;
  iat?: number;
  exp?: number;
}

function setAuthCookie(reply: { setCookie: (name: string, value: string, options: object) => void }, token: string): void {
  reply.setCookie("token", token, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: env.NODE_ENV === "production",
    signed: true,
    maxAge: TOKEN_TTL_SECONDS,
  });
}

export const authController: FastifyPluginAsync = async (app) => {
  app.post<{ Body: LoginBody }>("/login", { schema: { body: loginSchema } }, async (req, reply) => {
    const { username, password } = req.body;

    const user = await getUserByUsername(username);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return sendError(reply, 401, "INVALID_CREDENTIALS", "Invalid username or password");
    }

    const jti = randomUUID();
    const token = await reply.jwtSign(
      { username: user.username, id: user.id, role: user.role, authVersion: user.authVersion ?? 0, jti },
      { expiresIn: `${TOKEN_TTL_SECONDS}s` },
    );

    setAuthCookie(reply, token);
    await insertAuditLog(user.username, "Login", "User logged in");

    const isFormPost = req.headers["content-type"]?.includes("application/x-www-form-urlencoded");
    if (isFormPost) {
      return reply.redirect("/");
    }

    // Do NOT return the JWT in the body. Cookie is httpOnly + signed; the body
    // payload only carries non-sensitive identity info for the SPA.
    return sendSuccess(reply, { id: user.id, username: user.username, role: user.role }, "Login successful", 200);
  });

  app.post("/logout", async (req, reply) => {
    if (req.cookies.token) {
      try {
        const decoded = await req.jwtVerify({ onlyCookie: true });
        if (isAuthTokenPayload(decoded)) {
          await insertAuditLog(decoded.username, "Logout", "User logged out");
          if (decoded.jti && typeof decoded.exp === "number") {
            await revokeJti(decoded.jti, decoded.exp * 1000);
          }
        }
      } catch {
        // ignore invalid token on logout
      }
    }
    reply.clearCookie("token", { path: "/" });
    return sendSuccess(reply, null, "Logout successful");
  });

  /** Refresh JWT — issues a new jti and revokes the old one. */
  app.post("/refresh", async (req, reply) => {
    try {
      const decoded = await req.jwtVerify({ onlyCookie: true });
      const currentUser = await resolveAuthUserFromJwtPayload(decoded);
      const tokenPayload = decoded as AuthTokenPayload;

      // Revoke the old jti so the previous token can't be reused.
      if (tokenPayload.jti && typeof tokenPayload.exp === "number") {
        await revokeJti(tokenPayload.jti, tokenPayload.exp * 1000);
      }

      const newJti = randomUUID();
      const token = await reply.jwtSign(
        { username: currentUser.username, id: currentUser.id, role: currentUser.role, authVersion: tokenPayload.authVersion ?? 0, jti: newJti },
        { expiresIn: `${TOKEN_TTL_SECONDS}s` },
      );
      setAuthCookie(reply, token);
      return sendSuccess(reply, null, "Token refreshed");
    } catch {
      return sendError(reply, 401, "TOKEN_EXPIRED", "Token expired. Please login again.");
    }
  });

  /** Get current user info */
  app.get("/me", async (req, reply) => {
    try {
      const decoded = await req.jwtVerify({ onlyCookie: true });
      const currentUser = await resolveAuthUserFromJwtPayload(decoded);
      return sendSuccess(reply, { id: currentUser.id, username: currentUser.username, role: currentUser.role });
    } catch (error) {
      if (error instanceof Error && "errorCode" in error && (error as { errorCode?: string }).errorCode === "TOKEN_REVOKED") {
        return sendError(reply, 401, "TOKEN_REVOKED", "Token revoked");
      }
      return sendError(reply, 401, "UNAUTHORIZED", "Not authenticated");
    }
  });
};
