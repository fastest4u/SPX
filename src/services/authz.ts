export type UserRole = "admin" | "user";

export type AuthUser = {
  id: number;
  username: string;
  role: UserRole;
};

const ROLE_ORDER: UserRole[] = ["user", "admin"];

export function normalizeRole(value: unknown): UserRole {
  return value === "admin" ? "admin" : "user";
}

export function hasRole(userRole: UserRole, required: UserRole): boolean {
  return ROLE_ORDER.indexOf(userRole) >= ROLE_ORDER.indexOf(required);
}
