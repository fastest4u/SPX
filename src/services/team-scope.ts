import { AppError } from "../utils/errors.js";
import type { AuthUser } from "./authz.js";

export function requireRequestUser(req: { user?: unknown }): AuthUser {
  const user = req.user as AuthUser | undefined;
  if (!user) throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  return user;
}

export function requireTeamUser(req: { user?: unknown }): number {
  const user = requireRequestUser(req);
  if (user.role !== "user" || typeof user.teamId !== "number") {
    throw new AppError("Team scope is required", 400, "TEAM_REQUIRED");
  }
  return user.teamId;
}

export function resolveScopedTeamId(req: { user?: unknown }, explicitTeamId?: number): number {
  const user = requireRequestUser(req);
  if (user.role === "admin") {
    if (typeof explicitTeamId !== "number") {
      throw new AppError("Admin requests must include teamId", 400, "TEAM_REQUIRED");
    }
    return explicitTeamId;
  }
  if (typeof user.teamId !== "number") {
    throw new AppError("Team scope is required", 400, "TEAM_REQUIRED");
  }
  return user.teamId;
}
