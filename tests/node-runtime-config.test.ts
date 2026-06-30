import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const packageLock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8")) as {
  packages?: Record<string, { version?: string; engines?: Record<string, string>; devDependencies?: Record<string, string> }>;
};
const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
const dockerCompose = readFileSync(resolve(root, "docker-compose.yml"), "utf8");
const deployWorkflow = readFileSync(resolve(root, ".github/workflows/deploy.yml"), "utf8");
const deploymentDocs = readFileSync(resolve(root, "docs/deployment.md"), "utf8");

assert.equal(packageJson.engines?.node, ">=24.16.0", "package engines must require the Node 24 LTS baseline");
assert.match(packageJson.scripts?.build ?? "", /--target=node24\b/, "backend bundle must target Node 24");
assert.equal(packageJson.devDependencies?.["@types/node"], "^24.0.0", "Node typings must track Node 24");

assert.equal(packageLock.packages?.[""]?.engines?.node, ">=24.16.0", "package-lock root engines must match package.json");
assert.equal(packageLock.packages?.[""]?.devDependencies?.["@types/node"], "^24.0.0", "package-lock root @types/node spec must match package.json");
assert.match(packageLock.packages?.["node_modules/@types/node"]?.version ?? "", /^24\./, "locked @types/node package must be v24");

assert.doesNotMatch(dockerfile, /node:22\b/, "Dockerfile must not use Node 22 images");
assert.equal((dockerfile.match(/^FROM node:24-alpine\b/gm) ?? []).length, 1, "Docker runtime stage must use node:24-alpine");
assert.match(dockerfile, /^FROM node:24-alpine AS runtime$/m, "Dockerfile must define an explicit runtime stage");
assert.match(dockerfile, /^COPY dist \.\/dist$/m, "Dockerfile must package the CI-built dist artifact");
assert.doesNotMatch(dockerfile, /npm run build/, "Dockerfile must not rebuild the app during production deploy");

assert.match(
  dockerCompose,
  /x-spx-worker-healthcheck:[\s\S]*ps \| grep -q '\[n\]ode dist\/app\.js'/,
  "workers must override the Dockerfile HTTP healthcheck with a process healthcheck",
);
for (const serviceName of ["worker-ifn", "worker-ptwl"]) {
  assert.match(
    dockerCompose,
    new RegExp(`\\n  ${serviceName}:[\\s\\S]*?\\n    healthcheck: \\*spx-worker-healthcheck`),
    `${serviceName} must use the worker healthcheck instead of the notifier /ready probe`,
  );
}

assert.match(deployWorkflow, /uses:\s+actions\/setup-node@v6\b/, "CI must use setup-node v6 for Node 24");
assert.match(deployWorkflow, /node-version:\s+"24"/, "CI must install Node 24");
assert.match(deployWorkflow, /uses:\s+actions\/upload-artifact@v7[\s\S]*name:\s+spx-dist[\s\S]*path:\s+dist\//, "CI build job must upload dist as an artifact");
assert.match(deployWorkflow, /uses:\s+actions\/download-artifact@v8[\s\S]*name:\s+spx-dist[\s\S]*path:\s+dist/, "deploy job must download the dist artifact");

assert.match(deploymentDocs, /node:24-alpine/, "deployment docs must describe the Node 24 Docker base image");
assert.doesNotMatch(deploymentDocs, /node:18-slim|Node 22/, "deployment docs must not describe old Node production baselines");
assert.match(deploymentDocs, /DB-first config/i, "deployment docs must describe DB-first config");
assert.match(deploymentDocs, /SECRETS_KEY/, "deployment docs must mention SECRETS_KEY as bootstrap env");
assert.match(deploymentDocs, /RUN_TEAM_IDS/, "deployment docs must keep worker team assignment as process env");
assert.doesNotMatch(deploymentDocs, /POLL_INTERVAL_MS=.*production/i, "deployment docs must not tell production operators to tune poll interval in .env");

console.log("node-runtime-config: all assertions passed");
