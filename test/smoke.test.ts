import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("pvg --help prints usage", () => {
  const out = execFileSync(process.execPath, ["--no-warnings", "src/cli.ts", "--help"], { encoding: "utf8" });
  assert.match(out, /^pvg — memory provenance for coding agents/);
  assert.match(out, /pvg report/);
});

test("unknown command exits 2", () => {
  assert.throws(
    () => execFileSync(process.execPath, ["--no-warnings", "src/cli.ts", "nope"], { encoding: "utf8", stdio: "pipe" }),
    (err: { status?: number }) => err.status === 2,
  );
});

test("constructor command exits 2", () => {
  assert.throws(
    () => execFileSync(process.execPath, ["--no-warnings", "src/cli.ts", "constructor"], { encoding: "utf8", stdio: "pipe" }),
    (err: { status?: number }) => err.status === 2,
  );
});
