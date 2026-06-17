import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "src/frontend/routes/index.tsx"), "utf8");

assert.match(
  source,
  /import\s+\{\s*DataTable,\s*type\s+DataTableColumn\s*\}\s+from\s+'..\/components\/DataTable'/,
  "rules dashboard must import the shared DataTable component",
);
assert.match(source, /<DataTable\b/, "rules dashboard must render the shared DataTable");
assert.match(source, /densityKey="notify-rules"/, "rules DataTable must persist density/columns under notify-rules");
assert.doesNotMatch(
  source,
  /<table\s+className="data-table"/,
  "rules dashboard should not render a raw data-table directly",
);

console.log("frontend-rules-datatable: all assertions passed");
