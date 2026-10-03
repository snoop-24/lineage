#!/usr/bin/env node
// Usage: node scripts/split-capture.mjs <capture.jsonl> <outDir>
// Writes one pretty-printed fixture per distinct event/tool, with the home directory replaced by /home/tester.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const [input, outDir] = process.argv.slice(2);
if (!input || !outDir) {
  console.error("usage: split-capture.mjs <capture.jsonl> <outDir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const seen = new Set();
for (const line of readFileSync(input, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const j = JSON.parse(line);
  const name = j.hook_event_name + (j.tool_name ? `-${String(j.tool_name).replace(/[^\w-]/g, "_")}` : "");
  if (seen.has(name)) continue;
  seen.add(name);
  const text = JSON.stringify(j, null, 2)
    .replaceAll(homedir(), "/home/tester")
    .replaceAll(homedir().replaceAll("/", "-"), "-home-tester");
  writeFileSync(`${outDir}/${name}.json`, `${text}\n`);
}
console.log([...seen].sort().join("\n"));
