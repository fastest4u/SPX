import { getUserAuthStateById } from "../repositories/user-repository.js";
import { isJtiRevoked } from "../repositories/jwt-blacklist-repository.js";
import { AppError } from "../utils/errors.js";
import type { AuthUser } from "./authz.js";

export interface AuthTokenPayload {
  id: number;
  username: string;
  role: string;
  teamId?: number | null;
  jti?: string;
  authVersion?: number;
  exp?: number;
}

export function isAuthTokenPayload(value: unknown): value is AuthTokenPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.username === "string" && typeof v.id === "number" && typeof v.role === "string";
}

export async function resolveAuthUserFromJwtPayload(decoded: unknown): Promise<AuthUser> {
  if (!isAuthTokenPayload(decoded)) {
    throw new AppError("Invalid token", 401, "TOKEN_INVALID");
  }

  if (decoded.jti && (await isJtiRevoked(decoded.jti))) {
    throw new AppError("Token revoked", 401, "TOKEN_REVOKED");
  }

  const current = await getUserAuthStateById(decoded.id);
  if (!current) {
    throw new AppError("Token revoked", 401, "TOKEN_REVOKED");
  }

  const tokenAuthVersion = typeof decoded.authVersion === "number" ? decoded.authVersion : 0;
  if (tokenAuthVersion !== current.authVersion) {
    throw new AppError("Token revoked", 401, "TOKEN_REVOKED");
  }

  return { id: current.id, username: current.username, role: current.role, teamId: current.teamId };
}
