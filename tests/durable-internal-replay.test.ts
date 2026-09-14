import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Fastify from "fastify";

process.env.DB_MODE = "memory";
process.env.NODE_ENV = "test";

const execFileAsync = promisify(execFile);

async function testDatabaseReplaySurvivesGuardRestart(): Promise<void> {
  const [{ DurableInternalRequestReplayGuard }, { closePool }, { resetMemoryDb }] = await Promise.all([
    import("../src/repositories/internal-request-replay-repository.js"),
    import("../src/db/client.js"),
    import("../src/db/client-memory.js"),
  ]);
  resetMemoryDb();
  const now = new Date("2026-07-10T12:00:00.000Z");
  const input = {
    nodeId: "worker-ifn-01",
    requestId: "restart-proof-request-01",
    signedTimestamp: now.toISOString(),
    partition: "notification-events",
    now,
  } as const;

  const firstProcess = new DurableInternalRequestReplayGuard();
  assert.deepEqual(await firstProcess.consume(input), { ok: true });

  const restartedProcess = new DurableInternalRequestReplayGuard();
  assert.deepEqual(await restartedProcess.consume(input), { ok: false, reason: "replay" });

  await closePool();
  resetMemoryDb();
}

async function testDatabaseReplayStoreFailsClosed(): Promise<void> {
  const { DurableInternalRequestReplayGuard } = await import(
    "../src/repositories/internal-request-replay-repository.js"
  );
  const now = new Date("2026-07-10T12:00:00.000Z");
  const guard = new DurableInternalRequestReplayGuard({
    store: {
      consume: async () => {
        throw new Error("database credentials and request material must not escape");
      },
    },
  });

  assert.deepEqual(await guard.consume({
    nodeId: "worker-ifn-01",
    requestId: "unavailable-request-01",
    signedTimestamp: now.toISOString(),
    partition: "notification-events",
    now,
  }), { ok: false, reason: "capacity" });
}

async function testDatabaseReplayUniquenessIsAtomic(): Promise<void> {
  const [{ DurableInternalRequestReplayGuard }, { closePool }, { resetMemoryDb }] = await Promise.all([
    import("../src/repositories/internal-request-replay-repository.js"),
    import("../src/db/client.js"),
    import("../src/db/client-memory.js"),
  ]);
  resetMemoryDb();
  const now = new Date("2026-07-10T12:00:00.000Z");
  const results = await Promise.all(Array.from({ length: 8 }, () => (
    new DurableInternalRequestReplayGuard().consume({
      nodeId: "worker-atomic-01",
      requestId: "atomic-database-request-01",
      signedTimestamp: now.toISOString(),
      partition: "notification-events",
      now,
    })
  )));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok && result.reason === "replay").length, 7);
  await closePool();
  resetMemoryDb();
}

async function testFileReplaySurvivesGuardRestartWithoutRawIdentifiers(): Promise<void> {
  const { FileInternalRequestReplayGuard } = await import(
    "../src/services/file-internal-request-replay.js"
  );
  const root = await mkdtemp(join(tmpdir(), "spx-replay-ledger-"));
  const ledgerDir = join(root, "ledger");
  const now = new Date("2026-07-10T12:00:00.000Z");
  const input = {
    nodeId: "line-service-sensitive-node",
    requestId: "sensitive-restart-request-id",
    signedTimestamp: now.toISOString(),
    partition: "ocr-read",
    now,
  } as const;

  try {
    const firstProcess = new FileInternalRequestReplayGuard({ ledgerDir });
    assert.deepEqual(await firstProcess.consume(input), { ok: true });

    const restartedProcess = new FileInternalRequestReplayGuard({ ledgerDir });
    assert.deepEqual(await restartedProcess.consume(input), { ok: false, reason: "replay" });

    const entries = await readdir(ledgerDir);
    assert.equal(entries.length, 1);
    assert.match(entries[0] ?? "", /^[a-f0-9]{64}\.replay$/);
    const serialized = `${entries.join("\n")}\n${await readFile(join(ledgerDir, entries[0]!), "utf8")}`;
    assert.doesNotMatch(serialized, /sensitive-restart-request-id|line-service-sensitive-node/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testFileReplayLedgerIsBoundedAndFailsClosed(): Promise<void> {
  const { FileInternalRequestReplayGuard } = await import(
    "../src/services/file-internal-request-replay.js"
  );
  const root = await mkdtemp(join(tmpdir(), "spx-replay-capacity-"));
  const now = new Date("2026-07-10T12:00:00.000Z");
  const guard = new FileInternalRequestReplayGuard({ ledgerDir: join(root, "ledger"), maxEntries: 1 });

  try {
    assert.deepEqual(await guard.consume({
      nodeId: "line-service-01",
      requestId: "capacity-request-01",
      signedTimestamp: now.toISOString(),
      partition: "ocr-read",
      now,
    }), { ok: true });
    assert.deepEqual(await guard.consume({
      nodeId: "line-service-01",
      requestId: "capacity-request-02",
      signedTimestamp: now.toISOString(),
      partition: "ocr-read",
      now,
    }), { ok: false, reason: "capacity" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testFileReplayUniquenessIsAtomicAcrossInstances(): Promise<void> {
  const { FileInternalRequestReplayGuard } = await import(
    "../src/services/file-internal-request-replay.js"
  );
  const root = await mkdtemp(join(tmpdir(), "spx-replay-atomic-"));
  const now = new Date("2026-07-10T12:00:00.000Z");
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => (
      new FileInternalRequestReplayGuard({ ledgerDir: join(root, "ledger") }).consume({
        nodeId: "line-service-atomic-01",
        requestId: "atomic-file-request-01",
        signedTimestamp: now.toISOString(),
        partition: "ocr-read",
        now,
      })
    )));
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok && result.reason === "replay").length, 7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testFileReplayPublishesAtomicallyWithSecurePermissions(): Promise<void> {
  const { FileInternalRequestReplayGuard, isSecureReplayPathMode } = await import(
    "../src/services/file-internal-request-replay.js"
  );
  assert.equal(isSecureReplayPathMode(0o700, "directory"), true);
  assert.equal(isSecureReplayPathMode(0o755, "directory"), false);
  assert.equal(isSecureReplayPathMode(0o600, "file"), true);
  assert.equal(isSecureReplayPathMode(0o700, "file"), false);
  assert.equal(isSecureReplayPathMode(0o644, "file"), false);

  const source = await readFile(
    join(process.cwd(), "src/services/file-internal-request-replay.ts"),
    "utf8",
  );
  assert.match(source, /await link\(temporaryPath, path\)/);
  assert.match(source, /constants\.O_RDONLY \| constants\.O_NOFOLLOW \| constants\.O_NONBLOCK/);
  assert.doesNotMatch(
    source,
    /open\(\s*path,\s*constants\.O_CREAT\s*\|\s*constants\.O_EXCL/,
    "the final replay path must not be visible before its contents are synced",
  );

  const root = await mkdtemp(join(tmpdir(), "spx-replay-secure-"));
  const ledgerDir = join(root, "ledger");
  const now = new Date("2026-07-10T12:00:00.000Z");
  try {
    const guard = new FileInternalRequestReplayGuard({ ledgerDir });
    assert.deepEqual(await guard.consume({
      nodeId: "line-service-secure-01",
      requestId: "secure-file-request-01",
      signedTimestamp: now.toISOString(),
      partition: "ocr-read",
      now,
    }), { ok: true });
    const entries = await readdir(ledgerDir);
    assert.equal(entries.length, 1);
    assert.match(entries[0] ?? "", /^[a-f0-9]{64}\.replay$/);
    if (process.platform !== "win32") {
      assert.equal((await stat(ledgerDir)).mode & 0o777, 0o700);
      assert.equal((await stat(join(ledgerDir, entries[0]!))).mode & 0o777, 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testFileReplayFailsClosedOnInsecurePermissions(): Promise<void> {
  if (process.platform === "win32") return;
  const { FileInternalRequestReplayGuard } = await import(
    "../src/services/file-internal-request-replay.js"
  );
  const root = await mkdtemp(join(tmpdir(), "spx-replay-insecure-"));
  const ledgerDir = join(root, "ledger");
  const now = new Date("2026-07-10T12:00:00.000Z");
  try {
    await mkdir(ledgerDir, { mode: 0o700 });
    await chmod(ledgerDir, 0o755);
    const insecureDirectoryGuard = new FileInternalRequestReplayGuard({ ledgerDir });
    assert.deepEqual(await insecureDirectoryGuard.consume({
      nodeId: "line-service-insecure-01",
      requestId: "insecure-directory-request-01",
      signedTimestamp: now.toISOString(),
      partition: "ocr-read",
      now,
    }), { ok: false, reason: "capacity" });
    assert.deepEqual(await readdir(ledgerDir), []);

    await chmod(ledgerDir, 0o700);
    const secureGuard = new FileInternalRequestReplayGuard({ ledgerDir });
    const input = {
      nodeId: "line-service-insecure-01",
      requestId: "insecure-entry-request-01",
      signedTimestamp: now.toISOString(),
      partition: "ocr-read",
      now,
    } as const;
    assert.deepEqual(await secureGuard.consume(input), { ok: true });
    const [entry] = await readdir(ledgerDir);
    await chmod(join(ledgerDir, entry!), 0o644);
    assert.deepEqual(
      await new FileInternalRequestReplayGuard({ ledgerDir }).consume(input),
      { ok: false, reason: "capacity" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testFileReplayCleansBoundedOrphanTempFiles(): Promise<void> {
  const { FileInternalRequestReplayGuard } = await import(
    "../src/services/file-internal-request-replay.js"
  );
  const root = await mkdtemp(join(tmpdir(), "spx-replay-orphan-"));
  const ledgerDir = join(root, "ledger");
  const now = new Date();
  const orphanNames = [
    `.${"a".repeat(64)}.${"b".repeat(24)}.tmp`,
    `.${"c".repeat(64)}.${"d".repeat(24)}.tmp`,
  ];
  try {
    await mkdir(ledgerDir, { mode: 0o700 });
    const staleTime = new Date(now.getTime() - 300_000);
    for (const orphanName of orphanNames) {
      const orphanPath = join(ledgerDir, orphanName);
      await writeFile(orphanPath, "", { mode: 0o600 });
      await utimes(orphanPath, staleTime, staleTime);
    }

    const guard = new FileInternalRequestReplayGuard({
      ledgerDir,
      cleanupBatchSize: 1,
      maxEntries: 1,
    });
    assert.deepEqual(await guard.consume({
      nodeId: "line-service-orphan-01",
      requestId: "orphan-cleanup-request-01",
      signedTimestamp: now.toISOString(),
      partition: "ocr-read",
      now,
    }), { ok: true });
    const entries = await readdir(ledgerDir);
    assert.equal(
      entries.filter((entry) => entry.endsWith(".tmp")).length,
      1,
      "orphan cleanup must be bounded by cleanupBatchSize",
    );
    assert.equal(entries.filter((entry) => entry.endsWith(".replay")).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testFileReplayRejectsNamedPipeWithoutBlocking(): Promise<void> {
  if (process.platform !== "linux") return;
  const [{ FileInternalRequestReplayGuard }, { prepareInternalRequestReplay }] = await Promise.all([
    import("../src/services/file-internal-request-replay.js"),
    import("../src/services/internal-auth.js"),
  ]);
  const root = await mkdtemp(join(tmpdir(), "spx-replay-pipe-"));
  const ledgerDir = join(root, "ledger");
  const now = new Date();
  const input = {
    nodeId: "line-service-pipe-01",
    requestId: "named-pipe-request-01",
    signedTimestamp: now.toISOString(),
    partition: "ocr-read",
    now,
  } as const;
  const prepared = prepareInternalRequestReplay(input, 120_000);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("expected valid replay input");

  try {
    await mkdir(ledgerDir, { mode: 0o700 });
    const pipePath = join(ledgerDir, `${prepared.value.fingerprint}.replay`);
    await execFileAsync("mkfifo", [pipePath]);
    await chmod(pipePath, 0o600);
    let timeout: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      new FileInternalRequestReplayGuard({ ledgerDir }).consume(input),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), 1_000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    assert.notEqual(result, "timeout", "opening a named pipe must not block the replay guard");
    assert.deepEqual(result, { ok: false, reason: "capacity" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testFileReplayRejectsSymlinkedLedgerDirectory(): Promise<void> {
  const { FileInternalRequestReplayGuard } = await import(
    "../src/services/file-internal-request-replay.js"
  );
  const root = await mkdtemp(join(tmpdir(), "spx-replay-symlink-"));
  const actualDir = join(root, "actual");
  const ledgerDir = join(root, "ledger");
  await mkdir(actualDir);
  await symlink(actualDir, ledgerDir, "junction");
  const now = new Date("2026-07-10T12:00:00.000Z");
  try {
    const guard = new FileInternalRequestReplayGuard({ ledgerDir });
    assert.deepEqual(await guard.consume({
      nodeId: "line-service-symlink-01",
      requestId: "symlink-ledger-request-01",
      signedTimestamp: now.toISOString(),
      partition: "ocr-read",
      now,
    }), { ok: false, reason: "capacity" });
    assert.deepEqual(await readdir(actualDir), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testRealtimeControllerRejectsReplayAfterRestart(): Promise<void> {
  const [
    { internalRealtimeController },
    { DurableInternalRequestReplayGuard },
    { createInternalSignature },
    { closePool },
    { resetMemoryDb },
  ] = await Promise.all([
    import("../src/controllers/internal-realtime-controller.js"),
    import("../src/repositories/internal-request-replay-repository.js"),
    import("../src/services/internal-auth.js"),
    import("../src/db/client.js"),
    import("../src/db/client-memory.js"),
  ]);
  resetMemoryDb();
  const secret = "r".repeat(32);
  const nodeId = "worker-ifn-restart-01";
  const requestId = "realtime-restart-request-01";
  const path = "/internal/realtime/events";
  const body = JSON.stringify({
    type: "notification.queue.changed",
    payloadVersion: 1,
    payload: { queued: 1 },
    source: { service: "worker", nodeId, role: "worker" },
    scope: { kind: "team", teamId: 2 },
    subject: { type: "team", id: "2", teamId: 2 },
    replayable: true,
    idempotencyKey: "durable-realtime-restart",
  });
  const timestamp = new Date().toISOString();
  const headers = {
    "content-type": "application/json",
    "idempotency-key": "durable-realtime-restart",
    "x-spx-node-id": nodeId,
    "x-spx-request-id": requestId,
    "x-spx-timestamp": timestamp,
    "x-spx-signature": createInternalSignature({
      body,
      timestamp,
      nodeId,
      path,
      secret,
      eventKey: "durable-realtime-restart",
      requestId,
    }),
  };

  const invoke = async () => {
    const app = Fastify({ logger: false });
    await app.register(internalRealtimeController, {
      prefix: "/internal/realtime",
      sharedSecret: secret,
      allowedNodes: new Map([[nodeId, new Set([2])]]),
      replayGuard: new DurableInternalRequestReplayGuard(),
      publisher: {
        publish: async () => ({
          accepted: true,
          duplicate: false,
          id: "durable-realtime-restart",
          receivedAt: new Date().toISOString(),
          persisted: true,
        }),
        publishSnapshot: async () => ({
          accepted: true,
          duplicate: false,
          id: "durable-realtime-restart",
          receivedAt: new Date().toISOString(),
          persisted: true,
        }),
      },
    });
    try {
      return await app.inject({ method: "POST", url: path, headers, payload: body });
    } finally {
      await app.close();
    }
  };

  assert.equal((await invoke()).statusCode, 200);
  const replay = await invoke();
  assert.equal(replay.statusCode, 409, replay.body);
  assert.equal(JSON.parse(replay.body).error_code, "INTERNAL_REQUEST_REPLAYED");
  await closePool();
  resetMemoryDb();
}

async function testOcrControllerRejectsFileReplayAfterRestart(): Promise<void> {
  const [
    { internalOcrController },
    { FileInternalRequestReplayGuard },
    { createInternalSignature },
    { OCR_INTERNAL_READ_LINE_IMAGE_PATH },
  ] = await Promise.all([
    import("../src/controllers/internal-ocr-controller.js"),
    import("../src/services/file-internal-request-replay.js"),
    import("../src/services/internal-auth.js"),
    import("../src/services/ocr-service-contract.js"),
  ]);
  const root = await mkdtemp(join(tmpdir(), "spx-ocr-replay-restart-"));
  const secret = "o".repeat(32);
  const nodeId = "line-service-restart-01";
  const requestId = "ocr-restart-request-01";
  const body = JSON.stringify({
    imageBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
    mimeType: "image/png",
    traceId: "ocr-restart-trace",
  });
  const timestamp = new Date().toISOString();
  const headers = {
    "content-type": "application/json",
    "x-spx-node-id": nodeId,
    "x-spx-request-id": requestId,
    "x-spx-timestamp": timestamp,
    "x-spx-signature": createInternalSignature({
      body,
      timestamp,
      nodeId,
      path: OCR_INTERNAL_READ_LINE_IMAGE_PATH,
      secret,
      requestId,
    }),
  };

  const invoke = async () => {
    const app = Fastify({ logger: false });
    await app.register(internalOcrController, {
      prefix: "/internal",
      nodeSecrets: new Map([[nodeId, { active: secret }]]),
      readAllowedNodeIds: new Set([nodeId]),
      adminAllowedNodeIds: new Set(),
      replayGuard: new FileInternalRequestReplayGuard({ ledgerDir: join(root, "ledger") }),
      readLineImage: async () => ({
        text: "OCR",
        attempts: 1,
        validation: { ok: true, parsed: {} as never },
      }),
    });
    try {
      return await app.inject({
        method: "POST",
        url: OCR_INTERNAL_READ_LINE_IMAGE_PATH,
        headers,
        payload: body,
      });
    } finally {
      await app.close();
    }
  };

  try {
    assert.equal((await invoke()).statusCode, 200);
    const replay = await invoke();
    assert.equal(replay.statusCode, 409, replay.body);
    assert.equal(JSON.parse(replay.body).error_code, "INTERNAL_REPLAY_DETECTED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testRuntimeWiresDurableReplayStores(): Promise<void> {
  const httpServer = await readFile(join(process.cwd(), "src/services/http-server.ts"), "utf8");
  assert.match(httpServer, /const databaseReplayGuard = new DurableInternalRequestReplayGuard\(\)/);
  assert.match(
    httpServer,
    /const ocrReplayGuard = new FileInternalRequestReplayGuard\(\{\s*ledgerDir: env\.OCR_REPLAY_LEDGER_DIR,?\s*}\)/,
  );
  for (const controller of [
    "internalNotificationController",
    "internalLineController",
    "internalRealtimeController",
    "internalRealtimeReadController",
  ]) {
    const registrations = [...httpServer.matchAll(
      new RegExp(`app\\.register\\(${controller},[\\s\\S]*?\\n\\s*}\\);`, "g"),
    )];
    assert.ok(registrations.length > 0, `${controller} registration must exist`);
    for (const registration of registrations) {
      assert.match(registration[0], /replayGuard: databaseReplayGuard/);
    }
  }
  const ocrRegistration = httpServer.match(
    /app\.register\(internalOcrController,[\s\S]*?\n\s*}\);/,
  )?.[0] ?? "";
  assert.match(ocrRegistration, /replayGuard: ocrReplayGuard/);
}

async function testReplaySchemaParityAndFrozenMigration(): Promise<void> {
  const paths = [
    "src/db/schema.ts",
    "src/db/client.ts",
    "src/db/client-memory.ts",
    "src/db/migration-sql.ts",
    "src/scripts/generate-migration.ts",
    "scripts/schema-verify.mjs",
  ];
  for (const path of paths) {
    const source = await readFile(join(process.cwd(), path), "utf8");
    if (path.endsWith("generate-migration.ts")) {
      assert.match(source, /internalRequestReplaysMigrationSql/);
      continue;
    }
    assert.match(source, /internal_request_replays/, `${path} must define the replay table`);
    assert.match(source, /internal_request_replays_partition_expires_idx/);
    assert.match(source, /internal_request_replays_expires_idx/);
  }
  const drizzleSchema = await readFile(join(process.cwd(), "src/db/schema.ts"), "utf8");
  assert.match(drizzleSchema, /replayKey:\s*char\("replay_key",\s*\{\s*length:\s*64\s*}\)/);

  const migrationName = "033_create_internal_request_replays.sql";
  const migrationBytes = await readFile(join(process.cwd(), "migrations", migrationName));
  const migration = migrationBytes.toString("utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS internal_request_replays/);
  assert.match(migration, /PRIMARY KEY \(replay_key\)/);
  assert.match(migration, /internal_request_replays_partition_expires_idx/);
  assert.match(migration, /internal_request_replays_expires_idx/);
  const checksums = JSON.parse(await readFile(
    join(process.cwd(), "migrations/released-checksums.json"),
    "utf8",
  )) as Record<string, string>;
  assert.equal(
    checksums[migrationName],
    createHash("sha256").update(migrationBytes).digest("hex"),
  );

  const repository = await readFile(
    join(process.cwd(), "src/repositories/internal-request-replay-repository.ts"),
    "utf8",
  );
  assert.match(
    repository,
    /if \(total >= limits\.maxEntries \|\| partitionTotal >= limits\.maxEntriesPerPartition\) \{\s*await connection\.commit\(\);\s*return "capacity";/,
    "bounded cleanup must persist even when the request is rejected at capacity",
  );
}

async function testOcrLedgerUsesExistingWritableDataMount(): Promise<void> {
  const compose = await readFile(join(process.cwd(), "docker-compose.a3.yml"), "utf8");
  const ocrService = compose.match(/^ {2}ocr-service:[\s\S]*?(?=^ {2}[a-z0-9-]+:|^volumes:)/m)?.[0] ?? "";
  assert.match(ocrService, /OCR_REPLAY_LEDGER_DIR:\s*\/app\/data\/internal-replay/);
  assert.match(ocrService, /target:\s*\/app\/data/);

  const policy = JSON.parse(await readFile(
    join(process.cwd(), "deploy/runtime-isolation-policy.json"),
    "utf8",
  )) as {
    services: Record<string, { mounts: Array<{ id: string; path: string; access: string }> }>;
  };
  const dataMounts = policy.services["ocr-service"]?.mounts.filter(
    (mount) => (
      mount.path === "/app/data" || mount.path.startsWith("/app/data/")
    ) && mount.access === "read-write",
  ) ?? [];
  assert.equal(dataMounts.length, 1, "OCR replay must reuse the single-writer /app/data resource");
  assert.deepEqual(dataMounts[0], {
    id: "ocr-auth",
    resource: "ocr-auth",
    path: "/app/data",
    access: "read-write",
    kind: "directory",
  });
}

async function testReplayOperationsAreDocumented(): Promise<void> {
  const [envReference, deployment] = await Promise.all([
    readFile(join(process.cwd(), "docs/env-reference.md"), "utf8"),
    readFile(join(process.cwd(), "docs/deployment-a3.md"), "utf8"),
  ]);
  assert.match(envReference, /`OCR_REPLAY_LEDGER_DIR`/);
  assert.match(envReference, /\/app\/data\/internal-replay/);
  assert.match(deployment, /internal_request_replays/);
  assert.match(deployment, /SELECT, INSERT, DELETE/);
  assert.match(deployment, /migration `033_create_internal_request_replays\.sql`/);
  assert.match(deployment, /one active `ocr-service` replica/i);
  assert.match(deployment, /does not store request bodies, signatures, or secrets/i);
}

async function main(): Promise<void> {
  await testDatabaseReplaySurvivesGuardRestart();
  await testDatabaseReplayStoreFailsClosed();
  await testDatabaseReplayUniquenessIsAtomic();
  await testFileReplaySurvivesGuardRestartWithoutRawIdentifiers();
  await testFileReplayLedgerIsBoundedAndFailsClosed();
  await testFileReplayUniquenessIsAtomicAcrossInstances();
  await testFileReplayPublishesAtomicallyWithSecurePermissions();
  await testFileReplayFailsClosedOnInsecurePermissions();
  await testFileReplayCleansBoundedOrphanTempFiles();
  await testFileReplayRejectsNamedPipeWithoutBlocking();
  await testFileReplayRejectsSymlinkedLedgerDirectory();
  await testRealtimeControllerRejectsReplayAfterRestart();
  await testOcrControllerRejectsFileReplayAfterRestart();
  await testRuntimeWiresDurableReplayStores();
  await testReplaySchemaParityAndFrozenMigration();
  await testOcrLedgerUsesExistingWritableDataMount();
  await testReplayOperationsAreDocumented();
  console.log("durable internal replay tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
