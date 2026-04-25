import fs from "node:fs";
import path from "node:path";

export function saveJson(data: unknown, dir: string, prefix: string, reqNum: number): string {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${prefix}_${timestamp}_req${reqNum}.json`;
  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  return filepath;
}
