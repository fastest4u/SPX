import { readFileSync } from "node:fs";
import {
  parseProductionTopology,
  productionTopologyUnitServices,
} from "../src/services/production-topology.ts";

function usage() {
  throw new Error(
    "usage: production-topology.mjs check <manifest> | services <manifest> --unit=primary|team2 [--format=json|shell]",
  );
}

function readTopology(path) {
  if (typeof path !== "string" || path.length === 0) usage();
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("production topology manifest is unreadable or invalid JSON");
  }
  return parseProductionTopology(value);
}

function options(args) {
  const result = {};
  for (const argument of args) {
    if (!argument.startsWith("--") || !argument.includes("=")) usage();
    const separator = argument.indexOf("=");
    const key = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (!key || !value || key in result) usage();
    result[key] = value;
  }
  return result;
}

function main(argv) {
  const [command, path, ...rest] = argv;
  const topology = readTopology(path);
  if (command === "check") {
    if (rest.length !== 0) usage();
    const services = topology.units.reduce((total, unit) => total + unit.services.length, 0);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        topology: topology.topology,
        units: topology.units.length,
        services,
        migrationUnit: topology.database.migrationUnit,
      })}\n`,
    );
    return;
  }
  if (command === "services") {
    const parsed = options(rest);
    if (Object.keys(parsed).some((key) => key !== "unit" && key !== "format")) usage();
    if (parsed.unit !== "primary" && parsed.unit !== "team2") {
      throw new Error("production topology unit must be primary or team2");
    }
    const format = parsed.format ?? "json";
    if (format !== "json" && format !== "shell") {
      throw new Error("production topology output format must be json or shell");
    }
    const services = productionTopologyUnitServices(topology, parsed.unit);
    process.stdout.write(format === "shell" ? `${services.join(" ")}\n` : `${JSON.stringify(services)}\n`);
    return;
  }
  usage();
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "production topology failed"}\n`);
  process.exitCode = 1;
}
