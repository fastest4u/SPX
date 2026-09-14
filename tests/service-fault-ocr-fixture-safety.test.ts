import assert from "node:assert/strict";
import { copyFile, lstat, mkdtemp, open, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = resolve(repoRoot, "scripts", "task9-ocr-fixture.png");
const expectedFixtureSha256 =
  "cdf7dcb00ca85d93e950cba10ac707c6e27c1dca828673512831454fbd53f73c";

type FixtureLoader = (input: {
  fixturePath: string;
  expectedSha256: string;
  fileSystem?: {
    lstat: typeof lstat;
    open: typeof open;
  };
}) => Promise<{ image: Buffer; hash: string }>;

async function main() {
  const probeModule = (await import("../scripts/service-fault-ocr-boundary-probe.mjs")) as {
    loadSyntheticFixture?: FixtureLoader;
  };
  assert.equal(typeof probeModule.loadSyntheticFixture, "function");
  const loadSyntheticFixture = probeModule.loadSyntheticFixture as FixtureLoader;

  const loaded = await loadSyntheticFixture({ fixturePath, expectedSha256: expectedFixtureSha256 });
  assert.equal(loaded.hash, expectedFixtureSha256);
  assert.ok(loaded.image.byteLength > 0);

  const tempRoot = await mkdtemp(resolve(tmpdir(), "spx-ocr-fixture-safety-"));
  try {
    await assert.rejects(
      loadSyntheticFixture({ fixturePath: tempRoot, expectedSha256: expectedFixtureSha256 }),
      /regular file/,
    );

    const replacementPath = resolve(tempRoot, "replacement.png");
    await copyFile(fixturePath, replacementPath);
    let replacementRead = false;
    await assert.rejects(
      loadSyntheticFixture({
        fixturePath,
        expectedSha256: expectedFixtureSha256,
        fileSystem: {
          lstat,
          open: async () => {
            const handle = await open(replacementPath, "r");
            return {
              stat: handle.stat.bind(handle),
              readFile: async (...args: Parameters<typeof handle.readFile>) => {
                replacementRead = true;
                return handle.readFile(...args);
              },
              close: handle.close.bind(handle),
            } as Awaited<ReturnType<typeof open>>;
          },
        },
      }),
      /identity changed/,
    );
    assert.equal(replacementRead, false, "race-fenced replacement must not be read");

    const symlinkPath = resolve(tempRoot, "fixture-link.png");
    let symlinkCreated = false;
    try {
      await symlink(fixturePath, symlinkPath, "file");
      symlinkCreated = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES" && code !== "ENOTSUP") throw error;
    }
    if (symlinkCreated) {
      await assert.rejects(
        loadSyntheticFixture({
          fixturePath: symlinkPath,
          expectedSha256: expectedFixtureSha256,
        }),
        /symbolic link/,
      );
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
