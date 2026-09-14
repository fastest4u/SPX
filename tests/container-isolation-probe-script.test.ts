import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const scriptPath = resolve(root, "scripts/container-isolation-probe.mjs");
  const policy = (
    await import(pathToFileURL(resolve(root, "deploy/runtime-isolation-policy.json")).href, {
      with: { type: "json" },
    })
  ).default as {
    version: number;
    services: Record<
      string,
      {
        requiredSecretFiles: string[];
        allowedSecretFiles: string[];
        mounts: Array<{ id: string; resource: string; path: string; access: string; kind: string }>;
      }
    >;
  };

  type Evaluation = {
    ok: boolean;
    service: string;
    failureCodes: string[];
  };

  const probeModule = (await import(pathToFileURL(scriptPath).href)) as {
    evaluateRoleIsolation(input: {
      service: string;
      policy: typeof policy;
      env: Record<string, string | undefined>;
      uid?: number;
      probeSecretFile?: (path: string) => Promise<boolean>;
      probeMountAccess?: (mount: { access: string }) => Promise<string>;
    }): Promise<Evaluation>;
    validatePolicy(value: unknown): typeof policy;
  };

  function expectedSecretPath(key: string): string {
    return `/run/secrets/${key.slice(0, -"_FILE".length).toLowerCase()}`;
  }

  function validEnv(service: string): Record<string, string> {
    const env = Object.fromEntries(
      policy.services[service]!.allowedSecretFiles.map((key) => [key, expectedSecretPath(key)]),
    );
    const publicCa = policy.services[service]!.mounts.find((mount) => mount.id === "public-ca");
    if (publicCa?.access === "read-only") env.DB_SSL_CA_FILE = "/run/config/db-ca.pem";
    return env;
  }

  const probeSecretFile = async () => true;
  const probeMountAccess = async (mount: { access: string }) => mount.access;

  for (const service of Object.keys(policy.services)) {
    const result = await probeModule.evaluateRoleIsolation({
      service,
      policy,
      env: validEnv(service),
      uid: 1000,
      probeSecretFile,
      probeMountAccess,
    });
    assert.deepEqual(result, { ok: true, service, failureCodes: [] });
  }

  const sampleService = "worker-ifn-split";
  const sampleEnv = validEnv(sampleService);
  const secretMarker = "SECRET_VALUE_MUST_NOT_PRINT";
  const pathMarker = "/private/secret/path-must-not-print";

  const unexpected = await probeModule.evaluateRoleIsolation({
    service: sampleService,
    policy,
    env: { ...sampleEnv, JWT_SECRET_FILE: pathMarker, SECRET_MARKER: secretMarker },
    uid: 1000,
    probeSecretFile,
    probeMountAccess,
  });
  assert.deepEqual(unexpected.failureCodes, ["unexpected_secret_file"]);

  const crossRolePlainSecret = await probeModule.evaluateRoleIsolation({
    service: sampleService,
    policy,
    env: { ...sampleEnv, LINE_SERVICE_ADMIN_SECRET: secretMarker },
    uid: 1000,
    probeSecretFile,
    probeMountAccess,
  });
  assert.deepEqual(crossRolePlainSecret.failureCodes, ["plain_secret_present"]);

  const missingPublicCaConfig = await probeModule.evaluateRoleIsolation({
    service: sampleService,
    policy,
    env: { ...sampleEnv, DB_SSL_CA_FILE: "" },
    uid: 1000,
    probeSecretFile,
    probeMountAccess,
  });
  assert.ok(missingPublicCaConfig.failureCodes.includes("required_config_missing"));

  const wrongPublicCaPath = await probeModule.evaluateRoleIsolation({
    service: sampleService,
    policy,
    env: { ...sampleEnv, DB_SSL_CA_FILE: pathMarker },
    uid: 1000,
    probeSecretFile,
    probeMountAccess,
  });
  assert.ok(wrongPublicCaPath.failureCodes.includes("config_file_path_mismatch"));

  const ocrWithUnexpectedCa = await probeModule.evaluateRoleIsolation({
    service: "ocr-service",
    policy,
    env: { ...validEnv("ocr-service"), DB_SSL_CA_FILE: "/run/config/db-ca.pem" },
    uid: 1000,
    probeSecretFile,
    probeMountAccess,
  });
  assert.ok(ocrWithUnexpectedCa.failureCodes.includes("unexpected_config_file"));

  const missingKey = policy.services[sampleService]!.requiredSecretFiles[0]!;
  const missing = await probeModule.evaluateRoleIsolation({
    service: sampleService,
    policy,
    env: { ...sampleEnv, [missingKey]: "" },
    uid: 1000,
    probeSecretFile,
    probeMountAccess,
  });
  assert.ok(missing.failureCodes.includes("required_secret_missing"));

  const wrongPathKey = policy.services[sampleService]!.requiredSecretFiles[1]!;
  const wrongPath = await probeModule.evaluateRoleIsolation({
    service: sampleService,
    policy,
    env: { ...sampleEnv, [wrongPathKey]: pathMarker },
    uid: 1000,
    probeSecretFile,
    probeMountAccess,
  });
  assert.ok(wrongPath.failureCodes.includes("secret_file_path_mismatch"));

  const unreadable = await probeModule.evaluateRoleIsolation({
    service: sampleService,
    policy,
    env: sampleEnv,
    uid: 1000,
    probeSecretFile: async () => false,
    probeMountAccess,
  });
  assert.ok(unreadable.failureCodes.includes("secret_file_unreadable"));

  const rootResult = await probeModule.evaluateRoleIsolation({
    service: sampleService,
    policy,
    env: sampleEnv,
    uid: 0,
    probeSecretFile,
    probeMountAccess,
  });
  assert.ok(rootResult.failureCodes.includes("running_as_root"));

  for (const access of ["absent", "read-only", "read-write"] as const) {
    const mismatch = await probeModule.evaluateRoleIsolation({
      service: sampleService,
      policy,
      env: sampleEnv,
      uid: 1000,
      probeSecretFile,
      probeMountAccess: async (mount) => (mount.access === access ? "unavailable" : mount.access),
    });
    const expectedCode =
      access === "absent"
        ? "mount_absence_violation"
        : access === "read-only"
          ? "mount_read_only_violation"
          : "mount_read_write_violation";
    assert.ok(mismatch.failureCodes.includes(expectedCode));
  }

  assert.throws(
    () =>
      probeModule.validatePolicy({
        version: 1,
        services: {
          "worker-*": policy.services[sampleService],
        },
      }),
    /policy invalid/,
  );

  for (const result of [
    unexpected,
    crossRolePlainSecret,
    missingPublicCaConfig,
    wrongPublicCaPath,
    ocrWithUnexpectedCa,
    missing,
    wrongPath,
    unreadable,
    rootResult,
  ]) {
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(
      serialized,
      /JWT_SECRET_FILE|DB_PASSWORD_FILE|SECRET_VALUE|private|run\/secrets/,
    );
  }

  const cli = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [scriptPath, "--help"], {
        cwd: root,
        env: { ...process.env, SECRET_MARKER: secretMarker, JWT_SECRET_FILE: pathMarker },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", rejectRun);
      child.on("exit", (status) => resolveRun({ status, stdout, stderr }));
    },
  );
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  assert.match(cli.stdout, /container-isolation-probe\.mjs/);
  assert.doesNotMatch(cli.stdout + cli.stderr, /SECRET_VALUE|path-must-not-print|JWT_SECRET_FILE/);

  console.log("container-isolation-probe-script: policy evaluation and redaction verified");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
