import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  adoptProductionProjectIdentity,
  reconcileProductionProjectIdentity,
  rollbackProductionProjectIdentity,
  verifyProductionIdentityReleaseBinding,
  verifyProductionProjectIdentity,
} from "../scripts/production-project-identity.mjs";

const RELEASE_SHA = "2".repeat(40);
const IMAGE_DIGEST = `sha256:${"1".repeat(64)}`;
const IMAGE_REF = `spx-app:${RELEASE_SHA}`;
const CONFIG_SHA_NOTIFICATION = "3".repeat(64);
const CONFIG_SHA_WEB = "4".repeat(64);
const START_MS = Date.parse("2026-07-10T05:00:00.000Z");

interface Container {
  Id: string;
  Image: string;
  Config: {
    Image: string;
    Labels: Record<string, string>;
  };
  State: {
    Running: boolean;
    Health: { Status: string };
  };
  Mounts: Array<{
    Type: string;
    Name: string;
    Source: string;
    Destination: string;
    RW: boolean;
  }>;
  NetworkSettings: {
    Networks: Record<string, { NetworkID: string }>;
    Ports: Record<string, Array<{ HostIp: string; HostPort: string }>>;
  };
}

function container(project: string, service: string, running = true, healthy = true): Container {
  return {
    Id: `${project}-${service}`,
    Image: IMAGE_DIGEST,
    Config: {
      Image: IMAGE_REF,
      Labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.service": service,
        "com.docker.compose.config-hash":
          service === "notification-service" ? CONFIG_SHA_NOTIFICATION : CONFIG_SHA_WEB,
        "org.opencontainers.image.revision": RELEASE_SHA,
      },
    },
    State: {
      Running: running,
      Health: { Status: healthy ? "healthy" : "unhealthy" },
    },
    Mounts: [
      {
        Type: "volume",
        Name: "spx-production-state",
        Source: "/var/lib/docker/volumes/spx-production-state/_data",
        Destination: `/state/${service}`,
        RW: true,
      },
    ],
    NetworkSettings: {
      Networks: {
        "spx-production-network": { NetworkID: "network-id-001" },
      },
      Ports:
        service === "web-api" ? { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "3000" }] } : {},
    },
  };
}

function approval() {
  return {
    schemaVersion: 1,
    currentProductionSha: RELEASE_SHA,
    approvedImageRef: IMAGE_REF,
    approvedImageDigest: IMAGE_DIGEST,
    services: ["notification-service", "web-api"],
    maintenanceWindow: {
      notBefore: "2026-07-10T04:55:00.000Z",
      notAfter: "2026-07-10T05:30:00.000Z",
    },
    volumeMappings: [
      {
        name: "spx-production-state",
        legacyName: "spx-production-state",
        canonicalName: "spx-production-state",
        stateful: true,
      },
    ],
    networkMappings: [
      {
        legacyName: "spx-production-network",
        canonicalName: "spx-production-network",
        networkId: "network-id-001",
      },
    ],
    portBindings: [
      {
        service: "web-api",
        containerPort: "3000/tcp",
        hostIp: "127.0.0.1",
        hostPort: "3000",
      },
    ],
    healthThresholds: {
      startupTimeoutMs: 20,
      pollIntervalMs: 1,
      requiredStatus: "healthy",
    },
    rollbackOwner: "on-call-primary",
    compose: {
      workingDirectory: `/root/spx-releases/${RELEASE_SHA}/operator`,
      files: ["docker-compose.yml"],
      envFile: "/etc/spx-production/runtime.env",
      configSha256: {
        "notification-service": CONFIG_SHA_NOTIFICATION,
        "web-api": CONFIG_SHA_WEB,
      },
    },
  } as const;
}

function createFakeDocker(
  options: {
    legacy?: Container[];
    canonical?: Container[];
    canonicalHealthy?: boolean;
    partialLegacyStopFailure?: boolean;
  } = {},
) {
  const baseline = options.legacy ?? [
    container("spx", "notification-service"),
    container("spx", "web-api"),
  ];
  const state = {
    legacy: structuredClone(baseline),
    canonical: structuredClone(options.canonical ?? []),
    commands: [] as string[][],
  };

  const runDocker = async (args: string[]) => {
    state.commands.push([...args]);
    if (args[0] === "ps") {
      const projectFilter = args.find((arg) => arg.startsWith("label=com.docker.compose.project="));
      const project = projectFilter?.split("=").at(-1);
      const containers = project === "spx" ? state.legacy : state.canonical;
      return `${containers.map((entry) => entry.Id).join("\n")}${containers.length ? "\n" : ""}`;
    }
    if (args[0] === "inspect") {
      const ids = new Set(args.slice(1));
      return JSON.stringify(
        [...state.legacy, ...state.canonical].filter((entry) => ids.has(entry.Id)),
      );
    }
    if (args[0] === "compose") {
      const project = args[args.indexOf("-p") + 1];
      const actionIndex = args.findIndex((arg) => arg === "stop" || arg === "up");
      const action = args[actionIndex];
      const services = args.slice(actionIndex + 1).filter((arg) => !arg.startsWith("-"));
      if (action === "stop") {
        const entries = project === "spx" ? state.legacy : state.canonical;
        if (project === "spx" && options.partialLegacyStopFailure) {
          entries[0].State.Running = false;
          options.partialLegacyStopFailure = false;
          throw new Error("simulated-partial-stop");
        }
        for (const entry of entries) {
          if (services.includes(entry.Config.Labels["com.docker.compose.service"])) {
            entry.State.Running = false;
          }
        }
        return "";
      }
      if (action === "up") {
        if (project === "spx-production") {
          state.canonical = baseline
            .filter((entry) => services.includes(entry.Config.Labels["com.docker.compose.service"]))
            .map((entry) => {
              const next = structuredClone(entry);
              next.Id = next.Id.replace(/^spx-/, "spx-production-");
              next.Config.Labels["com.docker.compose.project"] = "spx-production";
              next.State.Running = true;
              next.State.Health.Status =
                options.canonicalHealthy === false ? "unhealthy" : "healthy";
              return next;
            });
        } else {
          state.legacy = baseline.map((entry) => {
            const next = structuredClone(entry);
            next.State.Running = services.includes(
              next.Config.Labels["com.docker.compose.service"],
            );
            next.State.Health.Status = "healthy";
            return next;
          });
        }
        return "";
      }
    }
    throw new Error(`unexpected docker command: ${args.join(" ")}`);
  };

  return { state, runDocker };
}

async function withJournal(run: (journalPath: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "spx-project-identity-test-"));
  const journalPath = join(directory, "identity-journal.json");
  try {
    await run(journalPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  assert.doesNotMatch(
    readFileSync("scripts/production-project-identity.mjs", "utf8"),
    /\/root\/SPX/,
  );
  const source = readFileSync("scripts/production-project-identity.mjs", "utf8");
  assert.match(source, /const LEGACY_PROJECT = "spx"/);
  assert.match(source, /const CANONICAL_PROJECT = "spx-production"/);
  assert.match(source, /shell:\s*false/);
  assert.doesNotMatch(source, /down\s+-v|volume\s+(?:rm|prune)|network\s+(?:rm|prune)/);

  assert.deepEqual(
    verifyProductionIdentityReleaseBinding(approval(), {
      sourceSha: RELEASE_SHA,
      imageId: IMAGE_DIGEST,
      imageTag: IMAGE_REF,
    }),
    { sourceSha: RELEASE_SHA, imageId: IMAGE_DIGEST, imageTag: IMAGE_REF },
  );
  assert.throws(
    () =>
      verifyProductionIdentityReleaseBinding(approval(), {
        sourceSha: RELEASE_SHA,
        imageId: `sha256:${"9".repeat(64)}`,
        imageTag: IMAGE_REF,
      }),
    /production-project-release-binding-mismatch/,
  );

  {
    const canonical = createFakeDocker({
      legacy: [],
      canonical: [
        container("spx-production", "notification-service"),
        container("spx-production", "web-api"),
      ],
    });
    const result = await verifyProductionProjectIdentity({
      approval: approval(),
      runDocker: canonical.runDocker,
      nowMs: START_MS,
    });
    assert.equal(result.owner, "spx-production");
    assert.deepEqual(result.services, ["notification-service", "web-api"]);
  }

  {
    const mixed = createFakeDocker({
      legacy: [container("spx", "notification-service")],
      canonical: [container("spx-production", "web-api")],
    });
    await assert.rejects(
      verifyProductionProjectIdentity({
        approval: approval(),
        runDocker: mixed.runDocker,
        nowMs: START_MS,
      }),
      /production-project-mixed-owners/,
    );
  }

  {
    const unknown = createFakeDocker({
      legacy: [],
      canonical: [
        container("spx-production", "notification-service"),
        container("spx-production", "web-api"),
        container("spx-production", "unknown-service"),
      ],
    });
    await assert.rejects(
      verifyProductionProjectIdentity({
        approval: approval(),
        runDocker: unknown.runDocker,
        nowMs: START_MS,
      }),
      /production-project-unknown-service/,
    );
  }

  {
    const noOwner = createFakeDocker({ legacy: [], canonical: [] });
    await assert.rejects(
      verifyProductionProjectIdentity({
        approval: approval(),
        runDocker: noOwner.runDocker,
        nowMs: START_MS,
      }),
      /production-project-no-owner/,
    );
  }

  await withJournal(async (journalPath) => {
    const fake = createFakeDocker();
    const result = await adoptProductionProjectIdentity({
      approval: approval(),
      runDocker: fake.runDocker,
      journalPath,
      now: () => START_MS,
      sleep: async () => undefined,
    });
    assert.equal(result.owner, "spx-production");
    const composeCommands = fake.state.commands.filter((args) => args[0] === "compose");
    assert.deepEqual(
      composeCommands.map((args) => [
        args[args.indexOf("-p") + 1],
        args.find((arg) => arg === "stop" || arg === "up"),
      ]),
      [
        ["spx", "stop"],
        ["spx-production", "up"],
      ],
    );
    for (const command of composeCommands) {
      assert.equal(command.includes("--no-build"), command.includes("up"));
      assert.equal(command.includes("down"), false);
    }
    assert.equal(
      fake.state.legacy.some((entry) => entry.State.Running),
      false,
    );
    assert.equal(
      fake.state.canonical.every((entry) => entry.State.Running),
      true,
    );
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    assert.equal(journal.state, "completed");
    assert.equal(journal.before.owner, "spx");
    assert.equal(journal.after.owner, "spx-production");
    assert.equal(journal.rollback.owner, "on-call-primary");

    const rolledBack = await rollbackProductionProjectIdentity({
      approval: approval(),
      runDocker: fake.runDocker,
      journalPath,
      now: () => START_MS + 60_000,
      sleep: async () => undefined,
    });
    assert.equal(rolledBack.owner, "spx");
    assert.equal(
      fake.state.canonical.some((entry) => entry.State.Running),
      false,
    );
    assert.equal(
      fake.state.legacy.every((entry) => entry.State.Running),
      true,
    );
    const rollbackCommands = fake.state.commands.filter((args) => args[0] === "compose").slice(-2);
    assert.deepEqual(
      rollbackCommands.map((args) => [
        args[args.indexOf("-p") + 1],
        args.find((arg) => arg === "stop" || arg === "up"),
      ]),
      [
        ["spx-production", "stop"],
        ["spx", "up"],
      ],
    );
  });

  await withJournal(async (journalPath) => {
    const fake = createFakeDocker({ canonicalHealthy: false });
    let time = START_MS;
    await assert.rejects(
      adoptProductionProjectIdentity({
        approval: approval(),
        runDocker: fake.runDocker,
        journalPath,
        now: () => time,
        sleep: async (milliseconds: number) => {
          time += milliseconds;
        },
      }),
      /production-project-adoption-rolled-back/,
    );
    assert.equal(
      fake.state.canonical.some((entry) => entry.State.Running),
      false,
    );
    assert.equal(
      fake.state.legacy.every((entry) => entry.State.Running),
      true,
    );
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    assert.equal(journal.state, "rolled-back");
    assert.equal(journal.terminalPostcondition, "legacy-baseline-restored");
  });

  await withJournal(async (journalPath) => {
    const fake = createFakeDocker({ partialLegacyStopFailure: true });
    let time = START_MS;
    await assert.rejects(
      adoptProductionProjectIdentity({
        approval: approval(),
        runDocker: fake.runDocker,
        journalPath,
        now: () => time,
        sleep: async (milliseconds: number) => {
          time += milliseconds;
        },
      }),
      /production-project-adoption-rolled-back/,
    );
    assert.equal(
      fake.state.legacy.every((entry) => entry.State.Running),
      true,
    );
    assert.equal(
      fake.state.canonical.some((entry) => entry.State.Running),
      false,
    );
  });

  await withJournal(async (journalPath) => {
    const fake = createFakeDocker();
    await adoptProductionProjectIdentity({
      approval: approval(),
      runDocker: fake.runDocker,
      journalPath,
      now: () => START_MS,
      sleep: async () => undefined,
    });
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.state = "canonical-started";
    delete journal.after;
    fake.state.canonical.forEach((entry) => {
      entry.State.Health.Status = "unhealthy";
    });
    await writeFile(journalPath, `${JSON.stringify(journal)}\n`, "utf8");

    const reconciled = await reconcileProductionProjectIdentity({
      approval: approval(),
      runDocker: fake.runDocker,
      journalPath,
      now: () => START_MS + 60_000,
      sleep: async () => undefined,
    });
    assert.equal(reconciled.outcome, "rolled-back");
    assert.equal(
      fake.state.canonical.some((entry) => entry.State.Running),
      false,
    );
    assert.equal(
      fake.state.legacy.every((entry) => entry.State.Running),
      true,
    );
  });

  {
    const expiredApproval = {
      ...approval(),
      maintenanceWindow: { ...approval().maintenanceWindow, notAfter: "2026-07-10T04:59:59.000Z" },
    };
    const canonical = createFakeDocker({
      legacy: [],
      canonical: [
        container("spx-production", "notification-service"),
        container("spx-production", "web-api"),
      ],
    });
    const verified = await verifyProductionProjectIdentity({
      approval: expiredApproval,
      runDocker: canonical.runDocker,
      nowMs: START_MS,
    });
    assert.equal(verified.owner, "spx-production", "read-only verify survives window expiry");
    await assert.rejects(
      adoptProductionProjectIdentity({
        approval: expiredApproval,
        runDocker: createFakeDocker().runDocker,
        journalPath: join(tmpdir(), `expired-adoption-${process.pid}.json`),
        now: () => START_MS,
        sleep: async () => undefined,
      }),
      /production-project-approval-outside-window/,
    );
  }

  await assert.rejects(
    verifyProductionProjectIdentity({
      approval: {
        ...approval(),
        volumeMappings: [
          {
            name: "spx-production-state",
            legacyName: "spx-production-state",
            canonicalName: "new-empty-state",
            stateful: true,
          },
        ],
      },
      runDocker: createFakeDocker().runDocker,
      nowMs: START_MS,
    }),
    /production-project-stateful-volume-remap/,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
