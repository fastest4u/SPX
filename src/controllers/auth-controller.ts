import type { FastifyPluginAsync } from "fastify";
import { getUserByUsername, verifyPassword } from "../repositories/user-repository.js";
import { insertAuditLog } from "../repositories/audit-repository.js";
import { env } from "../config/env.js";
import type { AuthUser } from "../services/authz.js";
import { sendSuccess, sendError } from "../utils/response.js";

interface LoginBody {
  username: string;
  password: string;
}

const loginSchema = {
  type: "object" as const,
  additionalProperties: false,
  required: ["username", "password"],
  properties: {
    username: { type: "string" as const, minLength: 1, maxLength: 64 },
    password: { type: "string" as const, minLength: 1, maxLength: 256 },
  },
};

function isAuthUser(value: unknown): value is AuthUser {
  return typeof value === "object"
    && value !== null
    && "username" in value
    && typeof (value as Record<string, unknown>).username === "string";
}

export const authController: FastifyPluginAsync = async (app) => {
  app.post<{ Body: LoginBody }>("/login", { schema: { body: loginSchema } }, async (req, reply) => {
    const { username, password } = req.body;

    const user = await getUserByUsername(username);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return sendError(reply, 401, "INVALID_CREDENTIALS", "Invalid username or password");
    }

    const token = await reply.jwtSign({ username: user.username, id: user.id, role: user.role }, { expiresIn: "1d" });

    reply.setCookie("token", token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: env.NODE_ENV === "production",
      signed: true,
      maxAge: 86400,
    });

    await insertAuditLog(user.username, "Login", "User logged in");

    const isFormPost = req.headers["content-type"]?.includes("application/x-www-form-urlencoded");
    if (isFormPost) {
      return reply.redirect("/");
    }
    return sendSuccess(reply, { token }, "Login successful", 200);
  });

  app.post("/logout", async (req, reply) => {
    const token = req.cookies.token;
    if (token) {
      try {
        const decoded = await req.jwtVerify({ onlyCookie: true });
        if (isAuthUser(decoded)) {
          await insertAuditLog(decoded.username, "Logout", "User logged out");
        }
      } catch {
        // ignore invalid token on logout
      }
    }
    reply.clearCookie("token", { path: "/" });
    return sendSuccess(reply, null, "Logout successful");
  });

  /** Refresh JWT token — extends session without re-entering credentials */
  app.post("/refresh", async (req, reply) => {
    try {
      await req.jwtVerify({ onlyCookie: true });
      const user = req.user as AuthUser;

      const token = await reply.jwtSign(
        { username: user.username, id: user.id, role: user.role },
        { expiresIn: "1d" }
      );

      reply.setCookie("token", token, {
        path: "/",
        httpOnly: true,
        sameSite: "strict",
        secure: env.NODE_ENV === "production",
        signed: true,
        maxAge: 86400,
      });

      return sendSuccess(reply, null, "Token refreshed");
    } catch {
      return sendError(reply, 401, "TOKEN_EXPIRED", "Token expired. Please login again.");
    }
  });

  /** Get current user info */
  app.get("/me", async (req, reply) => {
    try {
      await req.jwtVerify({ onlyCookie: true });
      const user = req.user as AuthUser;
      return sendSuccess(reply, { id: user.id, username: user.username, role: user.role });
    } catch {
      return sendError(reply, 401, "UNAUTHORIZED", "Not authenticated");
    }
  });
};
