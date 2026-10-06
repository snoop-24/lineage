#!/usr/bin/env node
// Appends the hook JSON received on stdin as one line to $LINEAGE_CAPTURE_FILE.
import { appendFileSync } from "node:fs";

let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (data += chunk));
process.stdin.on("end", () => {
  const out = process.env.LINEAGE_CAPTURE_FILE ?? "capture.jsonl";
  appendFileSync(out, `${data.trim().replace(/\n/g, " ")}\n`);
});
