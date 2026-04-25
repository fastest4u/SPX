import type { FastifyPluginAsync } from "fastify";
import { getUserByUsername, verifyPassword } from "../repositories/user-repository.js";
import { insertAuditLog } from "../repositories/audit-repository.js";
import { env } from "../config/env.js";
import type { AuthUser } from "../services/authz.js";

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

function isAuthUser(value: unknown): value is AuthUser {
  return typeof value === "object"
    && value !== null
    && "username" in value
    && typeof (value as { username?: unknown }).username === "string";
}

export const authController: FastifyPluginAsync = async (app) => {
  app.post<{ Body: LoginBody }>("/login", async (req, reply) => {
    const { username, password } = req.body;

    if (typeof username !== "string" || typeof password !== "string" || username.trim() === "" || password.trim() === "") {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Username and password are required" } });
    }

    const user = await getUserByUsername(username);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return reply.code(401).send({ error: { code: "INVALID_CREDENTIALS", message: "Invalid username or password" } });
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
    return { ok: true };
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
    return { ok: true };
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

      return { ok: true };
    } catch {
      return reply.code(401).send({ error: { code: "TOKEN_EXPIRED", message: "Token expired. Please login again." } });
    }
  });

  /** Get current user info */
  app.get("/me", async (req, reply) => {
    try {
      await req.jwtVerify({ onlyCookie: true });
      const user = req.user as AuthUser;
      return { ok: true, user: { id: user.id, username: user.username, role: user.role } };
    } catch {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    }
  });
};
