import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseProductionTopology,
  productionTopologyUnit,
  productionTopologyUnitServices,
} from "../src/services/production-topology.js";

const topologyPath = resolve("deploy/production-topology.json");
const topology = parseProductionTopology(JSON.parse(readFileSync(topologyPath, "utf8")));

assert.equal(topology.schemaVersion, 1);
assert.equal(topology.topology, "split-two-host");
assert.deepEqual(topology.deploymentOrder, ["primary", "team2"]);
assert.deepEqual(topology.rollbackOrder, ["team2", "primary"]);
assert.equal(topology.database.migrationUnit, "primary");
assert.equal(topology.notificationIngress.transport, "private-ssh-tunnel");
assert.equal(
  topology.notificationIngress.url,
  "http://127.0.0.1:3000/internal/notification-events",
);

const primary = productionTopologyUnit(topology, "primary");
assert.equal(primary.host, "45.83.207.139");
assert.equal(primary.composeProject, "spx-production");
assert.deepEqual(primary.composeFiles, ["docker-compose.a3.yml", "deploy/production-primary.yml"]);
assert.equal(primary.runsMigrations, true);
assert.deepEqual(primary.publishedPorts, ["127.0.0.1:3000:3000"]);
assert.deepEqual(productionTopologyUnitServices(topology, "primary"), [
  "line-service",
  "notification-service",
  "ocr-service",
  "web-api",
  "worker-ptwl-split",
]);

const team2 = productionTopologyUnit(topology, "team2");
assert.equal(team2.host, "147.50.240.44");
assert.equal(team2.composeProject, "spx-production");
assert.deepEqual(team2.composeFiles, ["deploy/production-team2.yml"]);
assert.equal(team2.runsMigrations, false);
assert.deepEqual(team2.publishedPorts, []);
assert.deepEqual(productionTopologyUnitServices(topology, "team2"), ["worker-ifn-split"]);

interface MutableTopology {
  deploymentOrder: string[];
  notificationIngress: { url: string };
  units: Array<{
    publishedPorts: string[];
    runsMigrations: boolean;
    services: Array<{ name: string; nodeId: string; role: string; teamIds: number[] }>;
    unexpected?: boolean;
  }>;
}

const expectedFailure = (mutate: (value: MutableTopology) => void, pattern: RegExp) => {
  const value = structuredClone(topology) as unknown as MutableTopology;
  mutate(value);
  assert.throws(() => parseProductionTopology(value), pattern);
};

expectedFailure(
  (value) => value.units[0].services.push(structuredClone(value.units[1].services[0])),
  /service names must be globally unique/,
);
expectedFailure(
  (value) => value.units[0].services.at(-1).teamIds = [2],
  /worker-ptwl-split must own exactly team 1/,
);
expectedFailure(
  (value) => value.units[1].services[0].teamIds = [1],
  /worker-ifn-split must own exactly team 2/,
);
expectedFailure(
  (value) => value.units[0].services.push({
    name: "worker-ifn-split",
    role: "worker",
    nodeId: "prod-worker-ifn-primary",
    teamIds: [2],
  }),
  /service names must be globally unique/,
);
expectedFailure(
  (value) => value.units[1].publishedPorts = ["0.0.0.0:3002:3002"],
  /TEAM 2 must not publish ports/,
);
expectedFailure(
  (value) => value.notificationIngress.url = "http://45.83.207.139:3000/internal/notification-events",
  /notification ingress must use the managed loopback tunnel/,
);
expectedFailure(
  (value) => value.units[1].runsMigrations = true,
  /exactly one migration owner is required/,
);
expectedFailure(
  (value) => value.units[1].services[0].nodeId = value.units[0].services[0].nodeId,
  /node IDs must be globally unique/,
);
expectedFailure(
  (value) => value.units[0].unexpected = true,
  /contains unknown field/,
);
expectedFailure(
  (value) => value.deploymentOrder = ["team2", "primary"],
  /deployment order must be primary then TEAM 2/,
);

const cli = resolve("scripts/production-topology.mjs");
const check = spawnSync(process.execPath, [cli, "check", topologyPath], { encoding: "utf8" });
assert.equal(check.status, 0, check.stderr);
assert.deepEqual(JSON.parse(check.stdout), {
  ok: true,
  topology: "split-two-host",
  units: 2,
  services: 6,
  migrationUnit: "primary",
});

const primaryServices = spawnSync(
  process.execPath,
  [cli, "services", topologyPath, "--unit=primary", "--format=shell"],
  { encoding: "utf8" },
);
assert.equal(primaryServices.status, 0, primaryServices.stderr);
assert.equal(
  primaryServices.stdout,
  "line-service notification-service ocr-service web-api worker-ptwl-split\n",
);

const team2Services = spawnSync(
  process.execPath,
  [cli, "services", topologyPath, "--unit=team2", "--format=json"],
  { encoding: "utf8" },
);
assert.equal(team2Services.status, 0, team2Services.stderr);
assert.deepEqual(JSON.parse(team2Services.stdout), ["worker-ifn-split"]);

const invalidCli = spawnSync(process.execPath, [cli, "services", topologyPath, "--unit=unknown"], {
  encoding: "utf8",
});
assert.equal(invalidCli.status, 1);
assert.match(invalidCli.stderr, /production topology unit must be primary or team2/);

console.log("production topology: strict two-host placement and duplicate-worker guards pass");
