import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

// Copy built SPA from frontend/dist to dist/public
const source = resolve(process.cwd(), "frontend/dist");
const target = resolve(process.cwd(), "dist/public");

await mkdir(target, { recursive: true });

// If frontend/dist exists, use it; otherwise fall back to src/public (legacy)
import { stat } from "node:fs/promises";
try {
  await stat(source);
  await cp(source, target, { recursive: true, force: true });
} catch {
  const legacySource = resolve(process.cwd(), "src/public");
  await cp(legacySource, target, { recursive: true, force: true });
}
