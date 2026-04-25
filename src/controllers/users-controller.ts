import type { FastifyPluginAsync } from "fastify";
import { getAllUsers, createUser, updateUserPassword, deleteUser, updateUserRole } from "../repositories/user-repository.js";
import { insertAuditLog } from "../repositories/audit-repository.js";
import type { AuthUser, UserRole } from "../services/authz.js";

const MIN_USER_PASSWORD_LENGTH = 12;

interface CreateUserBody {
  username?: unknown;
  password?: unknown;
  role?: UserRole;
}

interface PasswordBody {
  password?: unknown;
}

interface RoleBody {
  role?: UserRole;
}

interface IdParams {
  id: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function currentUser(req: { user?: unknown }): AuthUser {
  return req.user as AuthUser;
}

function isUserRole(value: unknown): value is UserRole {
  return value === "viewer" || value === "editor" || value === "admin";
}

const createUserSchema = {
  type: "object",
  additionalProperties: false,
  required: ["username", "password"],
  properties: {
    username: { type: "string", minLength: 1, maxLength: 64 },
    password: { type: "string", minLength: MIN_USER_PASSWORD_LENGTH, maxLength: 256 },
    role: { type: "string", enum: ["viewer", "editor", "admin"] },
  },
} as const;

const passwordSchema = {
  type: "object",
  additionalProperties: false,
  required: ["password"],
  properties: {
    password: { type: "string", minLength: MIN_USER_PASSWORD_LENGTH, maxLength: 256 },
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

  app.post<{ Body: CreateUserBody }>("/", { schema: { body: createUserSchema } }, async (req, reply) => {
    const { username, password, role } = req.body ?? {};
    if (!isNonEmptyString(username) || !isNonEmptyString(password)) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Missing username or password" } });
    }
    if (password.trim().length < MIN_USER_PASSWORD_LENGTH) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: `Password must be at least ${MIN_USER_PASSWORD_LENGTH} characters` } });
    }

    try {
      await createUser(username.trim(), password, role ?? "viewer");
      await insertAuditLog(currentUser(req).username, "Add User", `Created user: ${username}`);
      return { ok: true };
    } catch {
      return reply.code(400).send({ error: { code: "CONFLICT", message: "Cannot create user. Username might already exist." } });
    }
  });

  app.put<{ Params: IdParams; Body: PasswordBody }>("/:id/password", { schema: { params: idParamSchema, body: passwordSchema } }, async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    const { password } = req.body ?? {};
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid user id" } });
    if (!isNonEmptyString(password)) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Missing password" } });
    if (password.trim().length < MIN_USER_PASSWORD_LENGTH) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: `Password must be at least ${MIN_USER_PASSWORD_LENGTH} characters` } });

    try {
      await updateUserPassword(id, password);
      await insertAuditLog(currentUser(req).username, "Update User", `Changed password for user ID: ${id}`);
      return { ok: true };
    } catch {
      return reply.code(400).send({ error: { code: "UPDATE_FAILED", message: "Cannot change password" } });
    }
  });

  app.put<{ Params: IdParams; Body: RoleBody }>("/:id/role", { schema: { params: idParamSchema, body: roleSchema } }, async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    const { role } = req.body ?? {};
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid user id" } });
    if (!isUserRole(role)) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid role" } });
    if (currentUser(req).id === id) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Cannot change your own role" } });

    try {
      await updateUserRole(id, role);
      await insertAuditLog(currentUser(req).username, "Update Role", `Changed role for user ID: ${id} to ${role}`);
      return { ok: true };
    } catch {
      return reply.code(400).send({ error: { code: "UPDATE_FAILED", message: "Cannot change role" } });
    }
  });

  app.delete<{ Params: IdParams }>("/:id", { schema: { params: idParamSchema } }, async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid user id" } });
    if (currentUser(req).id === id) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Cannot delete yourself" } });

    await deleteUser(id);
    await insertAuditLog(currentUser(req).username, "Delete User", `Deleted user ID: ${id}`);
    return { ok: true };
  });
};
