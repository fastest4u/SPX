export const DB_PRINCIPAL_BOOTSTRAP_ROLES = Object.freeze([
  "gate6-control",
  "gate6-monitor",
  "observer",
]);

export const PRODUCTION_DB_ROLE_ORDER = Object.freeze([
  "realtime-service",
  "line-service",
  "notification-service",
  "worker-ifn-split",
  "worker-ptwl-split",
  "web-api",
  "phase3-control",
  "migrator",
]);

export const PRODUCTION_DB_ROLE_SCOPE = Object.freeze({
  "realtime-service": "realtime",
  "line-service": "line",
  "notification-service": "notification",
  "worker-ifn-split": "worker-ifn",
  "worker-ptwl-split": "worker-ptwl",
  "web-api": "web",
  "phase3-control": "phase3-control",
  migrator: "migrator",
});

const EXACT_ACCOUNT_HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\d{1,3}(?:\.\d{1,3}){3})$/;

export function productionAccountHost(descriptor, role) {
  if (
    descriptor?.environment !== "production"
    || descriptor?.database?.name !== "SPX"
    || descriptor.database.accountHosts === null
    || typeof descriptor.database.accountHosts !== "object"
    || Array.isArray(descriptor.database.accountHosts)
  ) throw new Error("signed production database descriptor is invalid");
  const host = descriptor.database.accountHosts[role];
  if (typeof host !== "string" || !EXACT_ACCOUNT_HOST.test(host) || /[%_/@\\\s]/.test(host)) {
    throw new Error(`signed database account host is invalid for ${role}`);
  }
  return host;
}

export function assertKnownProductionDbRole(role) {
  if (![...DB_PRINCIPAL_BOOTSTRAP_ROLES, ...PRODUCTION_DB_ROLE_ORDER].includes(role)) {
    throw new Error("unknown production DB role");
  }
}
