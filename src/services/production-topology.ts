const UNIT_IDS = ["primary", "team2"] as const;
const DEPLOYMENT_ORDER = ["primary", "team2"] as const;
const ROLLBACK_ORDER = ["team2", "primary"] as const;
const NOTIFICATION_INGRESS_URL =
  "http://127.0.0.1:3000/internal/notification-events" as const;

const SERVICE_CONTRACT = {
  "line-service": { role: "line-service", teamIds: [], unit: "primary" },
  "notification-service": { role: "notification-service", teamIds: [], unit: "primary" },
  "ocr-service": { role: "ocr-service", teamIds: [], unit: "primary" },
  "web-api": { role: "api", teamIds: [], unit: "primary" },
  "worker-ifn-split": { role: "worker", teamIds: [2], unit: "team2" },
  "worker-ptwl-split": { role: "worker", teamIds: [1], unit: "primary" },
} as const;

type UnitId = (typeof UNIT_IDS)[number];
type ServiceName = keyof typeof SERVICE_CONTRACT;

export interface ProductionTopologyService {
  name: ServiceName;
  role: string;
  nodeId: string;
  teamIds: number[];
}

export interface ProductionTopologyUnit {
  id: UnitId;
  host: string;
  composeProject: string;
  composeFiles: string[];
  services: ProductionTopologyService[];
  publishedPorts: string[];
  runsMigrations: boolean;
}

export interface ProductionTopology {
  schemaVersion: 1;
  topology: "split-two-host";
  deploymentOrder: UnitId[];
  rollbackOrder: UnitId[];
  database: {
    name: "SPX";
    migrationUnit: "primary";
  };
  notificationIngress: {
    producerUnit: "team2";
    targetUnit: "primary";
    transport: "private-ssh-tunnel";
    url: typeof NOTIFICATION_INGRESS_URL;
  };
  units: ProductionTopologyUnit[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown field(s): ${unknown.sort().join(", ")}`);
  const missing = keys.filter((key) => !(key in value));
  if (missing.length > 0) throw new Error(`${label} is missing required field(s): ${missing.join(", ")}`);
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...value];
}

function numbers(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.some((item) => !Number.isSafeInteger(item) || item < 1)) {
    throw new Error(`${label} must be an array of positive integers`);
  }
  return [...value];
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireExactArray(value: unknown, expected: readonly unknown[], message: string): void {
  if (!equal(value, expected)) throw new Error(message);
}

function parseService(value: unknown, unitId: UnitId, index: number): ProductionTopologyService {
  const service = record(value, `units.${unitId}.services[${index}]`);
  exact(service, ["name", "role", "nodeId", "teamIds"], `units.${unitId}.services[${index}]`);
  if (typeof service.name !== "string" || !(service.name in SERVICE_CONTRACT)) {
    throw new Error("production topology contains an unsupported service");
  }
  const name = service.name as ServiceName;
  const expected = SERVICE_CONTRACT[name];
  if (service.role !== expected.role) throw new Error(`${name} role is invalid`);
  if (typeof service.nodeId !== "string" || !/^prod-[a-z0-9-]{3,120}$/.test(service.nodeId)) {
    throw new Error(`${name} node ID is invalid`);
  }
  const teamIds = numbers(service.teamIds, `${name}.teamIds`);
  if (!equal(teamIds, expected.teamIds)) {
    if (name === "worker-ptwl-split") throw new Error("worker-ptwl-split must own exactly team 1");
    if (name === "worker-ifn-split") throw new Error("worker-ifn-split must own exactly team 2");
    throw new Error(`${name} must not own a team`);
  }
  if (unitId !== expected.unit) throw new Error(`${name} is assigned to the wrong production unit`);
  return { name, role: expected.role, nodeId: service.nodeId, teamIds };
}

function parseUnit(value: unknown, index: number): ProductionTopologyUnit {
  const unit = record(value, `units[${index}]`);
  exact(
    unit,
    ["id", "host", "composeProject", "composeFiles", "services", "publishedPorts", "runsMigrations"],
    `units[${index}]`,
  );
  if (unit.id !== UNIT_IDS[index]) throw new Error("production units must be primary then team2");
  const id = unit.id as UnitId;
  const expectedHost = id === "primary" ? "45.83.207.139" : "147.50.240.44";
  if (unit.host !== expectedHost) throw new Error(`${id} host does not match the designated production host`);
  const expectedProject = "spx-production";
  if (unit.composeProject !== expectedProject) throw new Error(`${id} Compose project is invalid`);
  const expectedFiles = id === "primary"
    ? ["docker-compose.a3.yml", "deploy/production-primary.yml"]
    : ["deploy/production-team2.yml"];
  requireExactArray(unit.composeFiles, expectedFiles, `${id} Compose files are invalid`);
  if (!Array.isArray(unit.services) || unit.services.length === 0) {
    throw new Error(`${id} services must be a non-empty array`);
  }
  const services = unit.services.map((service, serviceIndex) => parseService(service, id, serviceIndex));
  const names = services.map((service) => service.name);
  if (!equal(names, [...names].sort())) throw new Error(`${id} services must be sorted`);
  const publishedPorts = strings(unit.publishedPorts, `${id}.publishedPorts`);
  if (id === "primary") {
    requireExactArray(
      publishedPorts,
      ["127.0.0.1:3000:3000"],
      "primary must publish only loopback web readiness",
    );
  } else if (publishedPorts.length !== 0) {
    throw new Error("TEAM 2 must not publish ports");
  }
  if (typeof unit.runsMigrations !== "boolean") throw new Error(`${id}.runsMigrations must be boolean`);
  return {
    id,
    host: expectedHost,
    composeProject: expectedProject,
    composeFiles: strings(unit.composeFiles, `${id}.composeFiles`),
    services,
    publishedPorts,
    runsMigrations: unit.runsMigrations,
  };
}

export function parseProductionTopology(value: unknown): ProductionTopology {
  const topology = record(value, "production topology");
  exact(
    topology,
    [
      "schemaVersion",
      "topology",
      "deploymentOrder",
      "rollbackOrder",
      "database",
      "notificationIngress",
      "units",
    ],
    "production topology",
  );
  if (topology.schemaVersion !== 1) throw new Error("production topology schemaVersion must equal 1");
  if (topology.topology !== "split-two-host") throw new Error("production topology must be split-two-host");
  requireExactArray(
    topology.deploymentOrder,
    DEPLOYMENT_ORDER,
    "deployment order must be primary then TEAM 2",
  );
  requireExactArray(topology.rollbackOrder, ROLLBACK_ORDER, "rollback order must be TEAM 2 then primary");

  const database = record(topology.database, "production topology database");
  exact(database, ["name", "migrationUnit"], "production topology database");
  if (database.name !== "SPX" || database.migrationUnit !== "primary") {
    throw new Error("production database and migration owner are invalid");
  }

  const ingress = record(topology.notificationIngress, "production topology notificationIngress");
  exact(
    ingress,
    ["producerUnit", "targetUnit", "transport", "url"],
    "production topology notificationIngress",
  );
  if (
    ingress.producerUnit !== "team2" ||
    ingress.targetUnit !== "primary" ||
    ingress.transport !== "private-ssh-tunnel" ||
    ingress.url !== NOTIFICATION_INGRESS_URL
  ) {
    throw new Error("notification ingress must use the managed loopback tunnel");
  }

  if (!Array.isArray(topology.units) || topology.units.length !== 2) {
    throw new Error("production topology requires exactly two units");
  }
  const rawServiceNames = topology.units.flatMap((unit, unitIndex) => {
    const rawUnit = record(unit, `units[${unitIndex}]`);
    if (!Array.isArray(rawUnit.services)) return [];
    return rawUnit.services.map((service, serviceIndex) => {
      const rawService = record(service, `units[${unitIndex}].services[${serviceIndex}]`);
      return rawService.name;
    });
  });
  if (new Set(rawServiceNames).size !== rawServiceNames.length) {
    throw new Error("service names must be globally unique");
  }
  const units = topology.units.map(parseUnit);
  const migrationOwners = units.filter((unit) => unit.runsMigrations);
  if (migrationOwners.length !== 1 || migrationOwners[0]?.id !== database.migrationUnit) {
    throw new Error("exactly one migration owner is required");
  }
  const services = units.flatMap((unit) => unit.services);
  const serviceNames = services.map((service) => service.name);
  if (new Set(serviceNames).size !== serviceNames.length) {
    throw new Error("service names must be globally unique");
  }
  requireExactArray(
    [...serviceNames].sort(),
    Object.keys(SERVICE_CONTRACT).sort(),
    "production topology must contain the complete distributed split baseline",
  );
  const nodeIds = services.map((service) => service.nodeId);
  if (new Set(nodeIds).size !== nodeIds.length) throw new Error("node IDs must be globally unique");
  const workerTeamIds = services
    .filter((service) => service.role === "worker")
    .flatMap((service) => service.teamIds);
  if (!equal([...workerTeamIds].sort((left, right) => left - right), [1, 2])) {
    throw new Error("worker team assignments must be exact and non-overlapping");
  }
  return {
    schemaVersion: 1,
    topology: "split-two-host",
    deploymentOrder: [...DEPLOYMENT_ORDER],
    rollbackOrder: [...ROLLBACK_ORDER],
    database: { name: "SPX", migrationUnit: "primary" },
    notificationIngress: {
      producerUnit: "team2",
      targetUnit: "primary",
      transport: "private-ssh-tunnel",
      url: NOTIFICATION_INGRESS_URL,
    },
    units,
  };
}

export function productionTopologyUnit(
  topology: ProductionTopology,
  unitId: UnitId,
): ProductionTopologyUnit {
  const unit = topology.units.find((candidate) => candidate.id === unitId);
  if (!unit) throw new Error(`production topology unit ${unitId} is missing`);
  return unit;
}

export function productionTopologyUnitServices(
  topology: ProductionTopology,
  unitId: UnitId,
): ServiceName[] {
  return productionTopologyUnit(topology, unitId).services.map((service) => service.name);
}
