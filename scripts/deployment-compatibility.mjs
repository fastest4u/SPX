import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function readDeploymentContract(path) {
  let contract;
  try {
    contract = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Deployment contract is missing or unreadable");
  }
  if (!contract || Array.isArray(contract) || typeof contract !== "object"
      || Object.keys(contract).length !== 2 || contract.schemaVersion !== 1
      || !["legacy", "protected-a3"].includes(contract.mode)) {
    throw new Error("Unsupported deployment contract");
  }
  return contract;
}

function main(args) {
  const [command, path, ...options] = args;
  if (!path || !["check", "stage"].includes(command)) {
    throw new Error("Use check <contract> [--require-legacy|--require-protected-a3] [--github-output] or stage <contract> <destination>");
  }
  const contract = readDeploymentContract(path);
  if (command === "stage") {
    if (options.length !== 1 || options[0].startsWith("--")) throw new Error("A stage destination is required");
    writeFileSync(options[0], `${JSON.stringify(contract, null, 2)}\n`);
    return;
  }
  if (options.some((option) => !["--require-legacy", "--require-protected-a3", "--github-output"].includes(option))) {
    throw new Error("Unknown deployment compatibility option");
  }
  if (options.includes("--require-legacy") && options.includes("--require-protected-a3")) {
    throw new Error("Deployment compatibility requirements conflict");
  }
  const legacyDeployAllowed = contract.mode === "legacy";
  if (options.includes("--require-legacy") && !legacyDeployAllowed) {
    throw new Error("This runtime requires the protected A3 installer; legacy primary/worker deployment is disabled");
  }
  if (options.includes("--require-protected-a3") && contract.mode !== "protected-a3") {
    throw new Error("This release path requires protected A3 runtime");
  }
  if (options.includes("--github-output")) {
    if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
    appendFileSync(process.env.GITHUB_OUTPUT,
      `legacy_deploy_allowed=${legacyDeployAllowed}\ndeployment_mode=${contract.mode}\n`);
  }
  console.log(JSON.stringify({ deploymentMode: contract.mode, legacyDeployAllowed }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Deployment compatibility check failed");
    process.exitCode = 1;
  }
}
