import type { FastifyPluginAsync } from "fastify";
import { getAllUsers, createUser, updateUserPassword, deleteUser, updateUserRole } from "../repositories/user-repository.js";
import { insertAuditLog } from "../repositories/audit-repository.js";
import type { AuthUser, UserRole } from "../services/authz.js";
import { sendSuccess, sendError } from "../utils/response.js";

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
  return value === "user" || value === "admin";
}

const createUserSchema = {
  type: "object",
  additionalProperties: false,
  required: ["username", "password"],
  properties: {
    username: { type: "string", minLength: 1, maxLength: 64 },
    password: { type: "string", minLength: MIN_USER_PASSWORD_LENGTH, maxLength: 256 },
    role: { type: "string", enum: ["user", "admin"] },
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
    role: { type: "string", enum: ["user", "admin"] },
  },
} as const;

export const usersController: FastifyPluginAsync = async (app) => {
  app.get("/", async (req, reply) => {
    const users = await getAllUsers();
    return sendSuccess(reply, users);
  });

  app.post<{ Body: CreateUserBody }>("/", { schema: { body: createUserSchema } }, async (req, reply) => {
    const { username, password, role } = req.body ?? {};
    if (!isNonEmptyString(username) || !isNonEmptyString(password)) {
      return sendError(reply, 400, "VALIDATION_ERROR", "Missing username or password");
    }
    if (password.trim().length < MIN_USER_PASSWORD_LENGTH) {
      return sendError(reply, 400, "VALIDATION_ERROR", `Password must be at least ${MIN_USER_PASSWORD_LENGTH} characters`);
    }

    try {
      await createUser(username.trim(), password, role ?? "user");
      await insertAuditLog(currentUser(req).username, "Add User", `Created user: ${username}`);
      return sendSuccess(reply, null, "User created successfully", 201);
    } catch {
      return sendError(reply, 400, "CONFLICT", "Cannot create user. Username might already exist.");
    }
  });

  app.put<{ Params: IdParams; Body: PasswordBody }>("/:id/password", { schema: { params: idParamSchema, body: passwordSchema } }, async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    const { password } = req.body ?? {};
    if (!Number.isInteger(id) || id < 0) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid user id");
    if (!isNonEmptyString(password)) return sendError(reply, 400, "VALIDATION_ERROR", "Missing password");
    if (password.trim().length < MIN_USER_PASSWORD_LENGTH) return sendError(reply, 400, "VALIDATION_ERROR", `Password must be at least ${MIN_USER_PASSWORD_LENGTH} characters`);

    try {
      await updateUserPassword(id, password);
      await insertAuditLog(currentUser(req).username, "Update User", `Changed password for user ID: ${id}`);
      return sendSuccess(reply, null, "Password updated successfully");
    } catch {
      return sendError(reply, 400, "UPDATE_FAILED", "Cannot change password");
    }
  });

  app.put<{ Params: IdParams; Body: RoleBody }>("/:id/role", { schema: { params: idParamSchema, body: roleSchema } }, async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    const { role } = req.body ?? {};
    if (!Number.isInteger(id) || id < 0) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid user id");
    if (!isUserRole(role)) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid role");
    if (currentUser(req).id === id) return sendError(reply, 400, "VALIDATION_ERROR", "Cannot change your own role");

    try {
      await updateUserRole(id, role);
      await insertAuditLog(currentUser(req).username, "Update Role", `Changed role for user ID: ${id} to ${role}`);
      return sendSuccess(reply, null, "Role updated successfully");
    } catch {
      return sendError(reply, 400, "UPDATE_FAILED", "Cannot change role");
    }
  });

  app.delete<{ Params: IdParams }>("/:id", { schema: { params: idParamSchema } }, async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 0) return sendError(reply, 400, "VALIDATION_ERROR", "Invalid user id");
    if (currentUser(req).id === id) return sendError(reply, 400, "VALIDATION_ERROR", "Cannot delete yourself");

    await deleteUser(id);
    await insertAuditLog(currentUser(req).username, "Delete User", `Deleted user ID: ${id}`);
    return sendSuccess(reply, null, "User deleted successfully");
  });
};
