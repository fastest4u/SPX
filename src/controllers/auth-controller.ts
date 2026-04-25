import type { FastifyPluginAsync } from "fastify";
import { getUserByUsername, verifyPassword } from "../repositories/user-repository.js";
import { insertAuditLog } from "../repositories/audit-repository.js";
import { env } from "../config/env.js";

export const authController: FastifyPluginAsync = async (app) => {
  app.post("/login", async (req, reply) => {
    const { username, password } = req.body as any;

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
    return { ok: true };
  });

  app.post("/logout", async (req: any, reply) => {
    const token = req.cookies.token;
    if (token) {
      try {
        const decoded: any = await req.jwtVerify({ onlyCookie: true });
        await insertAuditLog(decoded.username, "Logout", "User logged out");
      } catch {
        // ignore invalid token on logout
      }
    }
    reply.clearCookie("token", { path: "/" });
    return { ok: true };
  });
};
