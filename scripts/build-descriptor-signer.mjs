#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const entryPoint = join(repositoryRoot, "scripts", "spx-descriptor-signer.mjs");

function fail(code) {
  throw new Error(code);
}

async function assertSafeOutputPath(outputPath) {
  if (!isAbsolute(outputPath)) fail("output-path-must-be-absolute");
  const parent = await lstat(dirname(outputPath)).catch(() => fail("output-parent-invalid"));
  if (!parent.isDirectory() || parent.isSymbolicLink()) fail("output-parent-invalid");
  const existing = await lstat(outputPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) fail("output-path-exists");
}

export async function buildDescriptorSigner(outputPath) {
  await assertSafeOutputPath(outputPath);
  const temporaryPath = join(dirname(outputPath), `.spx-descriptor-signer-${randomUUID()}.tmp`);
  try {
    await build({
      absWorkingDir: repositoryRoot,
      entryPoints: [entryPoint],
      outfile: temporaryPath,
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      charset: "utf8",
      legalComments: "none",
      logLevel: "silent",
      minify: false,
      sourcemap: false,
    });
    const bytes = await readFile(temporaryPath);
    await chmod(temporaryPath, 0o500);
    await rename(temporaryPath, outputPath);
    return {
      outputPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  if (process.argv.length !== 3) {
    process.stderr.write("usage: node scripts/build-descriptor-signer.mjs <absolute-output-path>\n");
    process.exitCode = 2;
  } else {
    buildDescriptorSigner(process.argv[2]).then((report) => {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    }).catch(() => {
      process.stderr.write("descriptor-signer-build-failed\n");
      process.exitCode = 1;
    });
  }
}
