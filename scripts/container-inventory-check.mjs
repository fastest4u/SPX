import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { readStableRegularFile } from "./lib/safe-file.mjs";

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{12,64}$/;
const FAILURE_ORDER = [
  "inventory_invalid",
  "inventory_identity_mismatch",
  "inventory_policy_mismatch",
  "inventory_type_mismatch",
  "inventory_target_mismatch",
  "inventory_source_mismatch",
  "inventory_access_mismatch",
  "inventory_options_mismatch",
  "inventory_extra_mount",
  "inventory_missing_mount",
];
const REQUIRED_TMPFS = new Map([
  ["/tmp", new Set(["rw", "noexec", "nosuid", "nodev", "size=67108864"])],
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeName(value) {
  return typeof value === "string" && NAME_PATTERN.test(value) ? value : "unknown";
}

function result(service, failureCode) {
  return {
    ok: failureCode === undefined,
    service: safeName(service),
    failureCodes: failureCode === undefined ? [] : [failureCode],
  };
}

function firstFailure(codes) {
  for (const code of FAILURE_ORDER) {
    if (codes.has(code)) return code;
  }
  return undefined;
}

function parseJsonFile(path, label) {
  const bytes = readStableRegularFile(path, label, { maximumBytes: MAX_JSON_BYTES });
  return JSON.parse(bytes.toString("utf8"));
}

function normalizeTarget(target, prefix) {
  if (typeof target !== "string" || target.length === 0) return undefined;
  const resolved = target.startsWith("/") ? target : `${prefix}/${target}`;
  if (!resolved.startsWith("/") || resolved.includes("\0")) return undefined;
  return resolved;
}

function normalizeSize(option) {
  const match = /^size=(\d+)([kmgt])?$/i.exec(option);
  if (match === null) return option.toLowerCase();
  const units = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
  const unit = match[2]?.toLowerCase();
  const value = Number(match[1]) * (unit === undefined ? 1 : units[unit]);
  return Number.isSafeInteger(value) ? `size=${value}` : option.toLowerCase();
}

function normalizeTmpfsOptions(value) {
  if (typeof value !== "string") return undefined;
  const options = value
    .split(",")
    .map((option) => option.trim().toLowerCase())
    .filter(Boolean)
    .map(normalizeSize);
  if (options.length === 0 || new Set(options).size !== options.length) return undefined;
  return new Set(options);
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function secretTarget(variable) {
  if (typeof variable !== "string" || !/^[A-Z][A-Z0-9_]*_FILE$/.test(variable)) {
    return undefined;
  }
  return `/run/secrets/${variable.slice(0, -5).toLowerCase()}`;
}

function accessFromReadOnly(readOnly) {
  return readOnly === true ? "read-only" : "read-write";
}

function addExpected(entries, entry) {
  if (entries.has(entry.target)) return false;
  entries.set(entry.target, entry);
  return true;
}

function expectedInventory(service, compose, policy) {
  if (
    !isRecord(compose) ||
    !isRecord(compose.services) ||
    !isRecord(compose.services[service]) ||
    !isRecord(policy) ||
    policy.version !== 1 ||
    !isRecord(policy.services) ||
    !isRecord(policy.services[service])
  ) {
    return { failure: "inventory_invalid" };
  }

  const definition = compose.services[service];
  const rules = policy.services[service];
  if (
    !Array.isArray(rules.requiredSecretFiles) ||
    !Array.isArray(rules.allowedSecretFiles) ||
    !Array.isArray(rules.mounts)
  ) {
    return { failure: "inventory_invalid" };
  }

  const requiredSecrets = new Set(rules.requiredSecretFiles.map(secretTarget));
  const allowedSecrets = new Set(rules.allowedSecretFiles.map(secretTarget));
  if (
    requiredSecrets.has(undefined) ||
    allowedSecrets.has(undefined) ||
    [...requiredSecrets].some((target) => !allowedSecrets.has(target))
  ) {
    return { failure: "inventory_invalid" };
  }

  const policyMounts = new Map();
  for (const mount of rules.mounts) {
    if (
      !isRecord(mount) ||
      typeof mount.resource !== "string" ||
      mount.resource.length === 0 ||
      typeof mount.path !== "string" ||
      !mount.path.startsWith("/") ||
      !["read-only", "read-write", "absent"].includes(mount.access) ||
      policyMounts.has(mount.path)
    ) {
      return { failure: "inventory_invalid" };
    }
    policyMounts.set(mount.path, mount);
  }

  const expected = new Map();
  const configs = definition.configs ?? [];
  if (!Array.isArray(configs) || !isRecord(compose.configs ?? {})) {
    return { failure: "inventory_invalid" };
  }
  for (const config of configs) {
    const source = isRecord(config) ? compose.configs[config.source] : undefined;
    const target = isRecord(config)
      ? normalizeTarget(config.target, "/run/configs")
      : undefined;
    const policyMount = target === undefined ? undefined : policyMounts.get(target);
    if (
      !isRecord(source) ||
      typeof source.file !== "string" ||
      source.file.length === 0 ||
      target === undefined ||
      policyMount?.access !== "read-only" ||
      !addExpected(expected, {
        type: "bind",
        source: source.file,
        target,
        access: "read-only",
        category: "config",
      })
    ) {
      return { failure: "inventory_policy_mismatch" };
    }
  }

  const secrets = definition.secrets ?? [];
  if (!Array.isArray(secrets) || !isRecord(compose.secrets ?? {})) {
    return { failure: "inventory_invalid" };
  }
  const presentSecrets = new Set();
  for (const secret of secrets) {
    const source = isRecord(secret) ? compose.secrets[secret.source] : undefined;
    const target = isRecord(secret)
      ? normalizeTarget(secret.target, "/run/secrets")
      : undefined;
    if (
      !isRecord(source) ||
      typeof source.file !== "string" ||
      source.file.length === 0 ||
      target === undefined ||
      !allowedSecrets.has(target) ||
      presentSecrets.has(target) ||
      !addExpected(expected, {
        type: "bind",
        source: source.file,
        target,
        access: "read-only",
        category: "secret",
      })
    ) {
      return { failure: "inventory_policy_mismatch" };
    }
    presentSecrets.add(target);
  }
  if ([...requiredSecrets].some((target) => !presentSecrets.has(target))) {
    return { failure: "inventory_policy_mismatch" };
  }

  const volumes = definition.volumes ?? [];
  if (!Array.isArray(volumes) || !isRecord(compose.volumes ?? {})) {
    return { failure: "inventory_invalid" };
  }
  for (const volume of volumes) {
    if (!isRecord(volume) || !["bind", "volume"].includes(volume.type)) {
      return { failure: "inventory_invalid" };
    }
    const target = normalizeTarget(volume.target, "/");
    const policyMount = target === undefined ? undefined : policyMounts.get(target);
    const access = accessFromReadOnly(volume.read_only);
    let source;
    if (volume.type === "bind") {
      source = volume.source;
    } else {
      const volumeDefinition = compose.volumes[volume.source];
      source = isRecord(volumeDefinition) ? volumeDefinition.name : undefined;
    }
    if (
      typeof source !== "string" ||
      source.length === 0 ||
      policyMount?.access !== access ||
      (volume.type === "volume" && policyMount.resource !== volume.source) ||
      !addExpected(expected, {
        type: volume.type,
        source,
        target,
        access,
        category: "volume",
      })
    ) {
      return { failure: "inventory_policy_mismatch" };
    }
  }

  const tmpfs = definition.tmpfs ?? [];
  if (!Array.isArray(tmpfs)) return { failure: "inventory_invalid" };
  const presentTmpfs = new Set();
  for (const specification of tmpfs) {
    if (typeof specification !== "string") return { failure: "inventory_invalid" };
    const separator = specification.indexOf(":");
    const target = separator === -1 ? specification : specification.slice(0, separator);
    const options = normalizeTmpfsOptions(separator === -1 ? "rw" : specification.slice(separator + 1));
    const required = REQUIRED_TMPFS.get(target);
    if (
      options === undefined ||
      required === undefined ||
      !sameSet(options, required) ||
      presentTmpfs.has(target) ||
      !addExpected(expected, {
        type: "tmpfs",
        source: "tmpfs",
        target,
        access: options.has("ro") ? "read-only" : "read-write",
        options,
        category: "tmpfs",
      })
    ) {
      return { failure: "inventory_policy_mismatch" };
    }
    presentTmpfs.add(target);
  }
  if ([...REQUIRED_TMPFS].some(([target]) => !presentTmpfs.has(target))) {
    return { failure: "inventory_policy_mismatch" };
  }

  return { expected };
}

function actualInventory(inspect) {
  if (!isRecord(inspect) || !Array.isArray(inspect.mounts)) {
    return { failure: "inventory_invalid" };
  }
  const actual = new Map();
  const tmpfsMountTargets = new Set();
  for (const mount of inspect.mounts) {
    if (!isRecord(mount) || typeof mount.Destination !== "string") {
      return { failure: "inventory_invalid" };
    }
    if (mount.Type === "tmpfs") {
      tmpfsMountTargets.add(mount.Destination);
      continue;
    }
    const source = mount.Type === "volume" ? mount.Name : mount.Source;
    if (
      !["bind", "volume"].includes(mount.Type) ||
      typeof source !== "string" ||
      source.length === 0 ||
      typeof mount.RW !== "boolean" ||
      actual.has(mount.Destination)
    ) {
      return { failure: "inventory_invalid" };
    }
    actual.set(mount.Destination, {
      type: mount.Type,
      source,
      target: mount.Destination,
      access: mount.RW ? "read-write" : "read-only",
    });
  }

  const tmpfs = inspect.tmpfs ?? {};
  if (!isRecord(tmpfs)) return { failure: "inventory_invalid" };
  for (const [target, rawOptions] of Object.entries(tmpfs)) {
    const options = normalizeTmpfsOptions(rawOptions);
    if (options === undefined || actual.has(target)) {
      return { failure: "inventory_invalid" };
    }
    actual.set(target, {
      type: "tmpfs",
      source: "tmpfs",
      target,
      access: options.has("ro") ? "read-only" : "read-write",
      options,
    });
  }
  for (const target of tmpfsMountTargets) {
    if (!actual.has(target)) {
      actual.set(target, {
        type: "tmpfs",
        source: "tmpfs",
        target,
        access: "unknown",
        options: new Set(),
      });
    }
  }
  return { actual };
}

function compareInventories(expected, actual) {
  const failures = new Set();
  const missing = new Map();
  const extra = new Map();

  for (const [target, expectedMount] of expected) {
    const actualMount = actual.get(target);
    if (actualMount === undefined) {
      missing.set(target, expectedMount);
      continue;
    }
    if (expectedMount.type !== actualMount.type) failures.add("inventory_type_mismatch");
    else if (expectedMount.source !== actualMount.source) failures.add("inventory_source_mismatch");
    if (expectedMount.access !== actualMount.access) failures.add("inventory_access_mismatch");
    if (
      expectedMount.type === "tmpfs" &&
      (!actualMount.options || !sameSet(expectedMount.options, actualMount.options))
    ) {
      failures.add("inventory_options_mismatch");
    }
  }
  for (const [target, actualMount] of actual) {
    if (!expected.has(target)) extra.set(target, actualMount);
  }

  for (const [missingTarget, missingMount] of missing) {
    for (const [extraTarget, extraMount] of extra) {
      if (
        missingMount.type === extraMount.type &&
        missingMount.source === extraMount.source &&
        missingMount.access === extraMount.access
      ) {
        failures.add("inventory_target_mismatch");
        missing.delete(missingTarget);
        extra.delete(extraTarget);
        break;
      }
    }
  }
  if (extra.size > 0) failures.add("inventory_extra_mount");
  if (missing.size > 0) failures.add("inventory_missing_mount");
  return firstFailure(failures);
}

export function evaluateContainerInventory({ service, project, compose, inspect, policy }) {
  if (!NAME_PATTERN.test(service ?? "") || !NAME_PATTERN.test(project ?? "")) {
    return result(service, "inventory_invalid");
  }
  if (
    !isRecord(compose) ||
    compose.name !== project ||
    !isRecord(inspect) ||
    inspect.project !== project ||
    inspect.service !== service
  ) {
    return result(service, "inventory_identity_mismatch");
  }
  const expectedResult = expectedInventory(service, compose, policy);
  if (expectedResult.failure !== undefined) return result(service, expectedResult.failure);
  const actualResult = actualInventory(inspect);
  if (actualResult.failure !== undefined) return result(service, actualResult.failure);
  return result(service, compareInventories(expectedResult.expected, actualResult.actual));
}

function parseArguments(argv) {
  const values = new Map();
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (match === null || values.has(match[1])) throw new Error("arguments are invalid");
    values.set(match[1], match[2]);
  }
  const allowed = new Set([
    "service",
    "project",
    "compose-json",
    "policy",
    "inspect-json",
    "container-id",
  ]);
  if ([...values.keys()].some((key) => !allowed.has(key))) throw new Error("arguments are invalid");
  if (
    !NAME_PATTERN.test(values.get("service") ?? "") ||
    !NAME_PATTERN.test(values.get("project") ?? "") ||
    values.has("inspect-json") === values.has("container-id")
  ) {
    throw new Error("arguments are invalid");
  }
  for (const key of ["compose-json", "policy"]) {
    if (!values.has(key)) throw new Error("arguments are invalid");
  }
  return values;
}

function inspectContainer(containerId) {
  if (!CONTAINER_ID_PATTERN.test(containerId)) throw new Error("container id is invalid");
  const format = "{\"project\":{{json (index .Config.Labels \"com.docker.compose.project\")}},\"service\":{{json (index .Config.Labels \"com.docker.compose.service\")}},\"mounts\":{{json .Mounts}},\"tmpfs\":{{json .HostConfig.Tmpfs}}}";
  const inspected = spawnSync("docker", ["inspect", "--format", format, containerId], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: MAX_JSON_BYTES,
  });
  if (inspected.status !== 0 || typeof inspected.stdout !== "string") {
    throw new Error("container inspection failed");
  }
  return JSON.parse(inspected.stdout);
}

function runCli() {
  let service = "unknown";
  try {
    const args = parseArguments(process.argv.slice(2));
    service = args.get("service");
    const composePath = args.get("compose-json");
    const policyPath = args.get("policy");
    const inspectPath = args.get("inspect-json");
    if (
      !isAbsolute(composePath) ||
      !isAbsolute(policyPath) ||
      (inspectPath !== undefined && !isAbsolute(inspectPath))
    ) {
      throw new Error("input paths must be absolute");
    }
    const compose = parseJsonFile(composePath, "Compose inventory");
    const policy = parseJsonFile(policyPath, "Runtime isolation policy");
    const inspect = inspectPath === undefined
      ? inspectContainer(args.get("container-id"))
      : parseJsonFile(inspectPath, "Container inventory");
    const evaluation = evaluateContainerInventory({
      service,
      project: args.get("project"),
      compose,
      inspect,
      policy,
    });
    process.stdout.write(`${JSON.stringify(evaluation)}\n`);
    process.exitCode = evaluation.ok ? 0 : 1;
  } catch {
    process.stdout.write(`${JSON.stringify(result(service, "inventory_check_failed"))}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  runCli();
}
