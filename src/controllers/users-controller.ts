import type { FastifyPluginAsync } from "fastify";
import { getAllUsers, createUser, updateUserPassword, deleteUser, updateUserRole } from "../repositories/user-repository.js";
import { insertAuditLog } from "../repositories/audit-repository.js";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const createUserSchema = {
  type: "object",
  additionalProperties: false,
  required: ["username", "password"],
  properties: {
    username: { type: "string", minLength: 1, maxLength: 64 },
    password: { type: "string", minLength: 8, maxLength: 256 },
    role: { type: "string", enum: ["viewer", "editor", "admin"] },
  },
} as const;

const passwordSchema = {
  type: "object",
  additionalProperties: false,
  required: ["password"],
  properties: {
    password: { type: "string", minLength: 8, maxLength: 256 },
  },
} as const;

const idParamSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "integer", minimum: 0 },
  },
} as const;

const roleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["role"],
  properties: {
    role: { type: "string", enum: ["viewer", "editor", "admin"] },
  },
} as const;

export const usersController: FastifyPluginAsync = async (app) => {
  app.get("/", async () => {
    return await getAllUsers();
  });

  app.post("/", { schema: { body: createUserSchema } }, async (req: any, reply) => {
    const { username, password, role } = req.body ?? {};
    if (!isNonEmptyString(username) || !isNonEmptyString(password)) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Missing username or password" } });
    }

    try {
      await createUser(username.trim(), password, role ?? "viewer");
      await insertAuditLog(req.user.username, "Add User", `Created user: ${username}`);
      return { ok: true };
    } catch {
      return reply.code(400).send({ error: { code: "CONFLICT", message: "Cannot create user. Username might already exist." } });
    }
  });

  app.put("/:id/password", { schema: { params: idParamSchema, body: passwordSchema } }, async (req: any, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    const { password } = req.body ?? {};
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid user id" } });
    if (!isNonEmptyString(password)) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Missing password" } });

    try {
      await updateUserPassword(id, password);
      await insertAuditLog(req.user.username, "Update User", `Changed password for user ID: ${id}`);
      return { ok: true };
    } catch {
      return reply.code(400).send({ error: { code: "UPDATE_FAILED", message: "Cannot change password" } });
    }
  });

  app.put("/:id/role", { schema: { params: idParamSchema, body: roleSchema } }, async (req: any, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    const { role } = req.body ?? {};
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid user id" } });
    if (req.user.id === id) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Cannot change your own role" } });

    try {
      await updateUserRole(id, role);
      await insertAuditLog(req.user.username, "Update Role", `Changed role for user ID: ${id} to ${role}`);
      return { ok: true };
    } catch {
      return reply.code(400).send({ error: { code: "UPDATE_FAILED", message: "Cannot change role" } });
    }
  });

  app.delete("/:id", { schema: { params: idParamSchema } }, async (req: any, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid user id" } });
    if (req.user.id === id) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Cannot delete yourself" } });

    await deleteUser(id);
    await insertAuditLog(req.user.username, "Delete User", `Deleted user ID: ${id}`);
    return { ok: true };
  });
};
