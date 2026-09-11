import assert from "node:assert/strict";
import type {
  ProviderAuthErrorCode,
  ProviderAuthLease,
  ProviderAuthRecord,
  ProviderAuthState,
  ProviderCredentials,
  ProviderSession,
} from "../src/models/provider-auth.js";
import { ProviderAuthError } from "../src/services/provider-auth/client.js";
import { createProviderAuthService } from "../src/services/provider-auth/session-service.js";

function record(overrides: Partial<ProviderAuthRecord> = {}): ProviderAuthRecord {
  return {
    teamId: 1,
    email: "team@example.test",
    hasPassword: true,
    status: "connected",
    lastLoginAt: "2030-09-11T07:00:00.000Z",
    expiresAt: "2030-09-11T08:04:00.000Z",
    errorCode: null,
    retryAt: null,
    password: "saved-password",
    cookie: "spx_uk=old-session",
    deviceId: "0123456789abcdef0123456789abcdef",
    epoch: 4,
    failures: 0,
    enabled: true,
    storedStatus: "connected",
    ...overrides,
  };
}

function createRepository(initial: ProviderAuthRecord | null) {
  let stored = initial ? { ...initial } : null;
  let leased = false;
  let leaseCount = 0;
  const failures: Array<{
    status: ProviderAuthState;
    errorCode: ProviderAuthErrorCode;
    retryAt: string | null;
    failures: number;
  }> = [];

  return {
    get leaseCount() { return leaseCount; },
    failures,
    set(value: ProviderAuthRecord | null) { stored = value ? { ...value } : null; },
    async getTeamProviderAuth() { return stored ? { ...stored } : null; },
    async acquireTeamProviderAuthLease(teamId: number): Promise<ProviderAuthLease | null> {
      if (!stored || stored.teamId !== teamId || leased) return null;
      leased = true;
      leaseCount += 1;
      return { teamId, token: `lease-${leaseCount}`, epoch: stored.epoch };
    },
    async commitTeamProviderAuth(
      lease: ProviderAuthLease,
      credentials: ProviderCredentials,
      session: ProviderSession,
      now: Date,
    ) {
      if (!stored || !leased || lease.epoch !== stored.epoch) return false;
      stored = {
        ...stored,
        email: credentials.email.trim().toLowerCase(),
        password: credentials.password,
        hasPassword: true,
        cookie: session.cookie,
        deviceId: session.deviceId,
        expiresAt: session.expiresAt,
        lastLoginAt: now.toISOString(),
        epoch: stored.epoch + 1,
        failures: 0,
        retryAt: null,
        errorCode: null,
        status: "connected",
        storedStatus: "connected",
      };
      leased = false;
      return true;
    },
    async failTeamProviderAuth(
      lease: ProviderAuthLease,
      failure: {
        status: ProviderAuthState;
        errorCode: ProviderAuthErrorCode;
        retryAt: string | null;
        failures: number;
      },
    ) {
      if (!stored || !leased || lease.epoch !== stored.epoch) return false;
      failures.push(failure);
      stored = { ...stored, ...failure, storedStatus: failure.status };
      leased = false;
      return true;
    },
    async releaseTeamProviderAuthLease(lease: ProviderAuthLease) {
      if (!stored || !leased || lease.epoch !== stored.epoch) return false;
      leased = false;
      return true;
    },
  };
}

const now = new Date("2030-09-11T08:00:00.000Z");
const nextSession: ProviderSession = {
  cookie: "spx_uk=new-session",
  deviceId: "0123456789abcdef0123456789abcdef",
  expiresAt: "2030-09-11T10:00:00.000Z",
};

async function main(): Promise<void> {
{
  const repository = createRepository(record());
  const loginInputs: Array<{ credentials: ProviderCredentials; deviceId?: string }> = [];
  const service = createProviderAuthService({
    repository,
    clock: () => now,
    client: {
      login: async (credentials, options) => {
        loginInputs.push({ credentials, deviceId: options.deviceId });
        return nextSession;
      },
      check: async () => ({ status: "valid" }),
    },
  });

  const refreshed = await service.ensure(1);
  assert.equal(refreshed?.epoch, 5, "known expiry within five minutes must refresh");
  assert.deepEqual(loginInputs, [{
    credentials: { email: "team@example.test", password: "saved-password" },
    deviceId: "0123456789abcdef0123456789abcdef",
  }]);
}

{
  const repository = createRepository(record({ enabled: false }));
  let loginCalls = 0;
  let checkCalls = 0;
  const service = createProviderAuthService({
    repository,
    clock: () => now,
    client: {
      login: async () => { loginCalls += 1; return nextSession; },
      check: async () => { checkCalls += 1; return { status: "expired", errorCode: "session_expired" }; },
    },
  });
  assert.equal((await service.ensure(1))?.epoch, 4);
  assert.equal(await service.recover(1, 4), false);
  assert.equal(loginCalls, 0, "disabled teams must not refresh automatically");
  assert.equal(checkCalls, 0, "disabled teams must not begin reactive automatic recovery");
}

{
  const repository = createRepository(record({ email: "", password: "", hasPassword: false, status: "manual" }));
  let loginCalls = 0;
  const service = createProviderAuthService({
    repository,
    clock: () => now,
    client: {
      login: async () => { loginCalls += 1; return nextSession; },
      check: async () => ({ status: "expired", errorCode: "session_expired" }),
    },
  });
  assert.equal((await service.ensure(1))?.status, "manual");
  assert.equal(await service.recover(1, 4), false);
  assert.equal(loginCalls, 0, "manual teams without saved credentials must never auto-login");
}

{
  const repository = createRepository(record({ expiresAt: "2030-09-11T09:00:00.000Z" }));
  let loginCalls = 0;
  const service = createProviderAuthService({
    repository,
    clock: () => now,
    client: {
      login: async () => { loginCalls += 1; return nextSession; },
      check: async () => ({ status: "valid" }),
    },
  });
  assert.equal((await service.ensure(1))?.epoch, 4);
  assert.equal(loginCalls, 0, "sessions outside the five-minute margin must remain unchanged");
}

{
  const repository = createRepository(record({ lastLoginAt: null }));
  let clock = new Date(now);
  let loginCalls = 0;
  const client = {
    login: async () => { loginCalls += 1; return nextSession; },
    check: async () => ({ status: "valid" } as const),
  };
  const firstProcess = createProviderAuthService({ repository, clock: () => clock, client });
  const secondProcess = createProviderAuthService({ repository, clock: () => clock, client });
  await firstProcess.connect(1, { email: "team@example.test", password: "first-password" });
  clock = new Date("2030-09-11T08:00:10.000Z");
  await assert.rejects(
    secondProcess.reconnect(1),
    (error: unknown) => error instanceof ProviderAuthError
      && error.code === "rate_limited"
      && error.retryAfterMs === 20_000,
  );
  assert.equal(loginCalls, 1, "successful manual login must persist a cross-process cooldown");
  clock = new Date("2030-09-11T08:00:30.000Z");
  await secondProcess.reconnect(1);
  assert.equal(loginCalls, 2);
}

{
  const base = createRepository(record({ email: "old@example.test", password: "old-password", epoch: 4 }));
  let advanced = false;
  const repository = {
    ...base,
    async acquireTeamProviderAuthLease(teamId: number) {
      if (!advanced) {
        advanced = true;
        base.set(record({ email: "new@example.test", password: "new-password", epoch: 5 }));
      }
      return base.acquireTeamProviderAuthLease(teamId);
    },
  };
  const loginInputs: ProviderCredentials[] = [];
  const service = createProviderAuthService({
    repository,
    clock: () => now,
    client: {
      login: async (credentials) => { loginInputs.push(credentials); return nextSession; },
      check: async () => ({ status: "valid" }),
    },
  });
  assert.equal((await service.reconnect(1))?.epoch, 6);
  assert.deepEqual(loginInputs, [{ email: "new@example.test", password: "new-password" }]);
}

{
  const base = createRepository(record({ enabled: true, epoch: 4 }));
  let disabled = false;
  const repository = {
    ...base,
    async acquireTeamProviderAuthLease(teamId: number) {
      if (!disabled) {
        disabled = true;
        base.set(record({ enabled: false, epoch: 5 }));
      }
      return base.acquireTeamProviderAuthLease(teamId);
    },
  };
  let loginCalls = 0;
  const service = createProviderAuthService({
    repository,
    clock: () => now,
    client: {
      login: async () => { loginCalls += 1; return nextSession; },
      check: async () => ({ status: "expired", errorCode: "session_expired" }),
    },
  });
  assert.equal((await service.ensure(1))?.enabled, false);
  assert.equal(loginCalls, 0, "a disable that wins before lease acquisition must suppress login");
  assert.ok(await base.acquireTeamProviderAuthLease(1), "a handled suppression must release its lease immediately");
}

{
  const base = createRepository(record({ epoch: 4 }));
  let advanced = false;
  const repository = {
    ...base,
    async acquireTeamProviderAuthLease(teamId: number) {
      if (!advanced) {
        advanced = true;
        base.set(record({ epoch: 5, expiresAt: "2030-09-11T10:00:00.000Z" }));
      }
      return base.acquireTeamProviderAuthLease(teamId);
    },
  };
  let loginCalls = 0;
  const service = createProviderAuthService({
    repository,
    clock: () => now,
    client: {
      login: async () => { loginCalls += 1; return nextSession; },
      check: async () => ({ status: "expired", errorCode: "session_expired" }),
    },
  });
  assert.equal((await service.ensure(1))?.epoch, 5);
  assert.equal(loginCalls, 0, "automatic auth must reuse an epoch advanced before lease acquisition");
  assert.ok(await base.acquireTeamProviderAuthLease(1), "advanced-trigger suppression must release its lease");
}

for (const replacement of [
  record({ storedStatus: "attention", status: "connecting", retryAt: null }),
  record({ storedStatus: "connected", status: "connected", expiresAt: "2030-09-11T10:00:00.000Z" }),
]) {
  const base = createRepository(record({ epoch: 4 }));
  let replaced = false;
  const repository = {
    ...base,
    async acquireTeamProviderAuthLease(teamId: number) {
      if (!replaced) {
        replaced = true;
        base.set(replacement);
      }
      return base.acquireTeamProviderAuthLease(teamId);
    },
  };
  let loginCalls = 0;
  const service = createProviderAuthService({
    repository,
    clock: () => now,
    client: {
      login: async () => { loginCalls += 1; return nextSession; },
      check: async () => ({ status: "expired", errorCode: "session_expired" }),
    },
  });
  await service.ensure(1);
  assert.equal(loginCalls, 0, "automatic auth must recheck durable attention and expiry under its lease");
  assert.ok(await base.acquireTeamProviderAuthLease(1), "ineligible-trigger suppression must release its lease");
}

{
  const base = createRepository(record({ epoch: 4 }));
  let advanced = false;
  const repository = {
    ...base,
    async acquireTeamProviderAuthLease(teamId: number) {
      if (!advanced) {
        advanced = true;
        base.set(record({ epoch: 5, cookie: "spx_uk=other-process-session" }));
      }
      return base.acquireTeamProviderAuthLease(teamId);
    },
  };
  let loginCalls = 0;
  const service = createProviderAuthService({
    repository,
    clock: () => now,
    client: {
      login: async () => { loginCalls += 1; return nextSession; },
      check: async () => ({ status: "expired", errorCode: "session_expired" }),
    },
  });
  assert.equal(await service.recover(1, 4), true);
  assert.equal(loginCalls, 0, "reactive auth must reuse an epoch advanced before lease acquisition");
  assert.ok(await base.acquireTeamProviderAuthLease(1), "reactive advanced-trigger suppression must release its lease");
}

{
  const repository = createRepository(record());
  let loginCalls = 0;
  const service = createProviderAuthService({
    repository,
    clock: () => now,
    client: {
      login: async () => {
        loginCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return nextSession;
      },
      check: async () => ({ status: "expired", errorCode: "session_expired" }),
    },
  });
  const oldEpoch = 4;
  const recovered = await Promise.all([service.recover(1, oldEpoch), service.recover(1, oldEpoch)]);
  assert.deepEqual(recovered, [true, true]);
  assert.equal(loginCalls, 1, "simultaneous rejected-session recovery must be single flight");
  assert.equal((await repository.getTeamProviderAuth())?.epoch, oldEpoch + 1);
}

{
  const repository = createRepository(record());
  let finishLogin: ((session: ProviderSession) => void) | undefined;
  const service = createProviderAuthService({
    repository,
    clock: () => now,
    client: {
      login: async () => new Promise<ProviderSession>((resolve) => { finishLogin = resolve; }),
      check: async () => ({ status: "valid" }),
    },
  });
  const first = service.connect(1, { email: "one@example.test", password: "candidate-one" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(
    service.connect(1, { email: "two@example.test", password: "candidate-two" }),
    (error: unknown) => error instanceof ProviderAuthError && error.code === "busy",
  );
  assert.ok(finishLogin);
  finishLogin(nextSession);
  assert.equal((await first)?.epoch, 5);
}

{
  const repository = createRepository(record());
  let loginCalls = 0;
  const service = createProviderAuthService({
    repository,
    clock: () => now,
    client: {
      login: async () => { loginCalls += 1; return nextSession; },
      check: async () => ({ status: "valid" }),
    },
  });
  assert.equal(await service.recover(1, 4), true);
  assert.equal(loginCalls, 0, "a healthy identity probe must not trigger login");
}

{
  const repository = createRepository(record());
  let loginCalls = 0;
  const service = createProviderAuthService({
    repository,
    clock: () => now,
    client: {
      login: async () => { loginCalls += 1; return nextSession; },
      check: async () => ({ status: "unavailable", errorCode: "provider_unavailable", retryAfterMs: null }),
    },
  });
  assert.equal(await service.recover(1, 4), false);
  assert.equal(loginCalls, 0, "gateway/network uncertainty must not trigger login");
}

{
  const repository = createRepository(record({ epoch: 5 }));
  let checkCalls = 0;
  const service = createProviderAuthService({
    repository,
    clock: () => now,
    client: {
      login: async () => nextSession,
      check: async () => { checkCalls += 1; return { status: "expired", errorCode: "session_expired" }; },
    },
  });
  assert.equal(await service.recover(1, 4), true);
  assert.equal(checkCalls, 0, "an epoch advanced by another owner must be reloaded without probing stale state");
}

{
  const prior = record({ cookie: "spx_uk=known-good", email: "old@example.test", password: "old-password" });
  const repository = createRepository(prior);
  let clock = new Date(now);
  const loginInputs: ProviderCredentials[] = [];
  const service = createProviderAuthService({
    repository,
    clock: () => clock,
    client: {
      login: async (credentials) => {
        loginInputs.push(credentials);
        if (loginInputs.length === 1) throw new ProviderAuthError("invalid_credentials");
        return nextSession;
      },
      check: async () => ({ status: "valid" }),
    },
  });
  await assert.rejects(
    service.connect(1, { email: "candidate@example.test", password: "candidate-password" }),
    (error: unknown) => error instanceof ProviderAuthError && error.code === "invalid_credentials",
  );
  const after = await repository.getTeamProviderAuth();
  assert.equal(after?.email, prior.email);
  assert.equal(after?.password, prior.password);
  assert.equal(after?.cookie, prior.cookie);
  assert.equal(repository.failures.at(-1)?.status, "connected");
  assert.equal(repository.failures.at(-1)?.retryAt, "2030-09-11T08:00:30.000Z");
  clock = new Date("2030-09-11T08:00:31.000Z");
  const renewed = await service.ensure(1);
  assert.equal(renewed?.epoch, prior.epoch + 1);
  assert.deepEqual(loginInputs.at(-1), { email: prior.email, password: prior.password });
}

for (const prior of [
  record({ storedStatus: "attention", status: "attention", retryAt: null }),
  record({
    storedStatus: "manual",
    status: "manual",
    email: "",
    password: "",
    hasPassword: false,
    cookie: "",
    deviceId: "",
    retryAt: null,
  }),
]) {
  const repository = createRepository(prior);
  const service = createProviderAuthService({
    repository,
    clock: () => now,
    client: {
      login: async () => { throw new ProviderAuthError("invalid_credentials"); },
      check: async () => ({ status: "valid" }),
    },
  });
  await assert.rejects(
    service.connect(1, { email: "candidate@example.test", password: "candidate-password" }),
    (error: unknown) => error instanceof ProviderAuthError && error.code === "invalid_credentials",
  );
  assert.equal(repository.failures.at(-1)?.status, "attention");
}

{
  const repository = createRepository(record({ failures: 3 }));
  const service = createProviderAuthService({
    repository,
    clock: () => now,
    client: {
      login: async () => { throw new ProviderAuthError("provider_unavailable", 280_000); },
      check: async () => ({ status: "expired", errorCode: "session_expired" }),
    },
  });
  assert.equal(await service.recover(1, 4), false);
  assert.deepEqual(repository.failures.at(-1), {
    status: "retry_wait",
    errorCode: "provider_unavailable",
    retryAt: "2030-09-11T08:04:40.000Z",
    failures: 4,
  });
}

{
  const prior = record({
    storedStatus: "retry_wait",
    status: "retry_wait",
    retryAt: "2030-09-11T07:59:59.000Z",
    failures: 1,
    cookie: "spx_uk=retained-transient-session",
  });
  const repository = createRepository(prior);
  let clock = new Date(now);
  const loginInputs: ProviderCredentials[] = [];
  const service = createProviderAuthService({
    repository,
    clock: () => clock,
    client: {
      login: async (credentials) => {
        loginInputs.push(credentials);
        if (loginInputs.length === 1) throw new ProviderAuthError("invalid_credentials");
        return nextSession;
      },
      check: async () => ({ status: "valid" }),
    },
  });
  await assert.rejects(
    service.connect(1, { email: "mistyped@example.test", password: "mistyped-password" }),
    (error: unknown) => error instanceof ProviderAuthError && error.code === "invalid_credentials",
  );
  assert.equal(repository.failures.at(-1)?.status, "retry_wait");
  clock = new Date("2030-09-11T08:01:01.000Z");
  const renewed = await service.ensure(1);
  assert.equal(renewed?.epoch, prior.epoch + 1);
  assert.deepEqual(loginInputs.at(-1), { email: prior.email, password: prior.password });
}

{
  const repository = createRepository(record({ retryAt: "2030-09-11T08:00:20.000Z" }));
  const service = createProviderAuthService({
    repository,
    clock: () => now,
    client: {
      login: async () => nextSession,
      check: async () => ({ status: "expired", errorCode: "session_expired" }),
    },
  });
  await assert.rejects(
    service.reconnect(1),
    (error: unknown) => error instanceof ProviderAuthError
      && error.code === "rate_limited"
      && error.retryAfterMs === 20_000,
  );
}

console.log("provider-auth-session: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
