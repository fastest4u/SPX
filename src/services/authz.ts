export type UserRole = "admin" | "editor" | "viewer";

export type AuthUser = {
  id: number;
  username: string;
  role: UserRole;
};

const ROLE_ORDER: UserRole[] = ["viewer", "editor", "admin"];

export function normalizeRole(value: unknown): UserRole {
  return value === "admin" || value === "editor" || value === "viewer" ? value : "viewer";
}

export function hasRole(userRole: UserRole, required: UserRole): boolean {
  return ROLE_ORDER.indexOf(userRole) >= ROLE_ORDER.indexOf(required);
}
