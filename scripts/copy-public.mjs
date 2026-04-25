import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve(process.cwd(), "src/public");
const target = resolve(process.cwd(), "dist/public");

await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true, force: true });
