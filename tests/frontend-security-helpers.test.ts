import assert from "node:assert/strict";
import { safeBrowserUrl } from "../src/frontend/lib/utils.js";

assert.equal(safeBrowserUrl("javascript:alert(1)"), null);
assert.equal(safeBrowserUrl("data:text/html,<script>alert(1)</script>"), null);
assert.equal(safeBrowserUrl("//evil.example/path"), "http://evil.example/path");
assert.equal(safeBrowserUrl("/line-images/run.png?x=1#top"), "/line-images/run.png?x=1#top");
assert.equal(safeBrowserUrl("https://example.com/a b"), "https://example.com/a%20b");
assert.equal(
  safeBrowserUrl("line://au/q/test", { allowedProtocols: ["http:", "https:", "line:"] }),
  "line://au/q/test",
);

console.log("frontend-security-helpers: all assertions passed");
