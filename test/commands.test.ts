import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { record } from "../src/core/recorder.ts";
import { loadTrust } from "../src/core/trust.ts";
import { configPath, trustPath, ensureDataDir, type Env } from "../src/paths.ts";
import { runTrust } from "../src/cli/trust.ts";
import { hookCommandPaths, runStatus } from "../src/cli/status.ts";
import { runLog } from "../src/cli/log.ts";
import { addHooks } from "../src/claude-settings.ts";
import { saveConfig, DEFAULT_CONFIG } from "../src/config.ts";
import { buildHookCommand } from "../src/cli/install.ts";
import { recorderFixture } from "./helpers.ts";

const NOW = new Date("2026-10-03T00:00:00Z");

function withData() {
  const f = recorderFixture();
  for (const [s, p] of [["s1", "a"], ["s1", "b"], ["s2", "c"]] as const) {
    record({ ...f.base(s), kind: "ingest", toolName: "WebFetch", sourceKind: "web", sourceId: `https://docs.python.org/3/${p}`, text: "docs" }, f.deps);
  }
  const env: Env = { home: f.home, dataDir: f.data, claudeSettingsPath: f.deps.settingsPath };
  return { f, env };
}

test("trust add / list / remove / errors", () => {
  const { f, env } = withData();
  try {
    const add = runTrust(["add", "docs.python.org", "--tier", "trusted"], env, NOW);
    assert.equal(add.code, 0);
    assert.match(add.out, /domain docs\.python\.org → T2/);
    assert.deepEqual(loadTrust(trustPath(env.dataDir)).rules, [{ type: "domain", match: "docs.python.org", tier: "T2" }]);
    assert.match(runTrust(["list"], env, NOW).out, /domain docs\.python\.org T2 \(trusted-external\)/);
    assert.match(runTrust(["remove", "docs.python.org"], env, NOW).out, /Removed rule/);
    assert.equal(runTrust(["add", "x.example"], env, NOW).code, 2);
    assert.equal(runTrust(["frobnicate"], env, NOW).code, 2);
  } finally {
    f.cleanup();
  }
});

test("trust list shows proposals; accept trusts them", () => {
  const { f, env } = withData();
  try {
    assert.match(runTrust([], env, NOW).out, /domain docs\.python\.org \(3 reads, 2 sessions\)/);
    const acc = runTrust(["accept"], env, NOW);
    assert.match(acc.out, /domain docs\.python\.org/);
    assert.deepEqual(loadTrust(trustPath(env.dataDir)).rules, [{ type: "domain", match: "docs.python.org", tier: "T2" }]);
    assert.match(runTrust(["accept"], env, NOW).out, /No proposals/);
  } finally {
    f.cleanup();
  }
});

test("status reports health and integrity", () => {
  const { f, env } = withData();
  try {
    const out = runStatus(env).out;
    assert.match(out, /Hooks installed: no/);
    assert.match(out, /Events: 5 \(ingest 3, session_start 2\)/);
    assert.match(out, /Log integrity: OK \(5 events\)/);
    assert.match(out, /Errors logged: 0/);
  } finally {
    f.cleanup();
  }
});

test("log filters and validates", () => {
  const { f, env } = withData();
  try {
    const out = runLog(["--kind", "ingest", "--limit", "1"], env).out.trim().split("\n");
    assert.equal(out.length, 1);
    assert.match(out[0] ?? "", /ingest WebFetch https:\/\/docs\.python\.org\/3\/c/);
    assert.equal(runLog(["--kind", "nope"], env).code, 2);
    assert.equal(runLog(["--limit", "0"], env).code, 2);
  } finally {
    f.cleanup();
  }
});

test("F1: log escapes control characters in source ids", () => {
  const { f, env } = withData();
  try {
    record({ ...f.base("s1"), kind: "ingest", toolName: "WebFetch", sourceKind: "web", sourceId: "https://evil.example/\x1b[2J\x9b", text: "x" }, f.deps);
    const out = runLog(["--kind", "ingest", "--limit", "1"], env).out;
    assert.ok(out.includes("https://evil.example/\\x1b[2J\\x9b"), out);
    assert.doesNotMatch(out, /[\x1b\x9b]/);
  } finally {
    f.cleanup();
  }
});

test("ruling 1: proposals skip sources with existing rules", () => {
  const { f, env } = withData();
  try {
    // Add an explicit rule for docs.python.org (demoting to external/T4)
    const add = runTrust(["add", "docs.python.org", "--tier", "external"], env, NOW);
    assert.equal(add.code, 0);

    // List should not show it as a proposal (it already has a rule)
    const list = runTrust(["list"], env, NOW).out;
    assert(!list.includes("(3 reads, 2 sessions)"), "proposal should not appear after rule is added");

    // Accept should find no proposals
    const accept = runTrust(["accept"], env, NOW);
    assert.match(accept.out, /No proposals/);
  } finally {
    f.cleanup();
  }
});

test("ruling 2: status warns when trust.json is malformed JSON", () => {
  const { f, env } = withData();
  try {
    ensureDataDir(env.dataDir);
    const trustJsonPath = trustPath(env.dataDir);
    writeFileSync(trustJsonPath, "{oops", { mode: 0o600 });

    const status = runStatus(env).out;
    assert.match(status, /trust\.json is not valid JSON/);
  } finally {
    f.cleanup();
  }
});

test("ruling 2: status warns when trust.json is null", () => {
  const { f, env } = withData();
  try {
    ensureDataDir(env.dataDir);
    const trustJsonPath = trustPath(env.dataDir);
    writeFileSync(trustJsonPath, "null", { mode: 0o600 });

    const status = runStatus(env).out;
    assert.match(status, /trust\.json is not valid JSON/);
  } finally {
    f.cleanup();
  }
});

test("ruling 2: status warns when trust.json is a number", () => {
  const { f, env } = withData();
  try {
    ensureDataDir(env.dataDir);
    const trustJsonPath = trustPath(env.dataDir);
    writeFileSync(trustJsonPath, "42", { mode: 0o600 });

    const status = runStatus(env).out;
    assert.match(status, /trust\.json is not valid JSON/);
  } finally {
    f.cleanup();
  }
});

test("ruling 2: status has no Trust rules line when trust.json doesn't exist", () => {
  const { f, env } = withData();
  try {
    const status = runStatus(env).out;
    assert(!status.includes("Trust rules:"), "should not have Trust rules line when no trust.json");
  } finally {
    f.cleanup();
  }
});

test("ruling 2: status doesn't warn with valid trust.json", () => {
  const { f, env } = withData();
  try {
    ensureDataDir(env.dataDir);
    const trustJsonPath = trustPath(env.dataDir);
    writeFileSync(trustJsonPath, JSON.stringify({ rules: [] }), { mode: 0o600 });

    const status = runStatus(env).out;
    assert(!status.includes("WARNING"), "should not warn with valid trust.json");
  } finally {
    f.cleanup();
  }
});

test("trust add refuses to write when trust.json is invalid", () => {
  const { f, env } = withData();
  try {
    ensureDataDir(env.dataDir);
    const trustJsonPath = trustPath(env.dataDir);
    writeFileSync(trustJsonPath, "{oops", { mode: 0o600 });

    const result = runTrust(["add", "example.com", "--tier", "trusted"], env, NOW);
    assert.equal(result.code, 1);
    assert.match(result.err, /trust\.json is not valid JSON/);

    // Verify file wasn't modified
    const content = readFileSync(trustJsonPath, "utf8");
    assert.equal(content, "{oops");
  } finally {
    f.cleanup();
  }
});

test("trust accept refuses to write when trust.json is invalid", () => {
  const { f, env } = withData();
  try {
    ensureDataDir(env.dataDir);
    const trustJsonPath = trustPath(env.dataDir);
    writeFileSync(trustJsonPath, "{oops", { mode: 0o600 });

    const result = runTrust(["accept"], env, NOW);
    assert.equal(result.code, 1);
    assert.match(result.err, /trust\.json is not valid JSON/);

    // Verify file wasn't modified
    const content = readFileSync(trustJsonPath, "utf8");
    assert.equal(content, "{oops");
  } finally {
    f.cleanup();
  }
});

function installFake(env: Env, nodePath: string, cliPath: string): void {
  const command = buildHookCommand(nodePath, cliPath, { LINEAGE_DATA_DIR: env.dataDir });
  mkdirSync(dirname(env.claudeSettingsPath), { recursive: true });
  writeFileSync(env.claudeSettingsPath, JSON.stringify(addHooks({}, command)));
  saveConfig(configPath(env.dataDir), { ...DEFAULT_CONFIG, installedCommand: command });
}

test("F8: status warns when the hook command points to missing paths and when recording has gone quiet", () => {
  const { f, env } = withData();
  try {
    installFake(env, join(f.home, "gone", "node"), join(f.home, "gone", "it's", "cli.js"));
    const out = runStatus(env, new Date("2026-10-20T00:00:00Z")).out;
    assert.match(out, /Hooks installed: yes/);
    assert.match(out, /WARNING: hook command points to a missing Node or CLI path; re-run lineage init/);
    assert.match(out, /WARNING: no events recorded in 17 days — is recording working\?/);
  } finally {
    f.cleanup();
  }
});

test("F8: no status warnings when hook paths exist and events are recent", () => {
  const { f, env } = withData();
  try {
    installFake(env, process.execPath, join(process.cwd(), "src", "cli.ts"));
    const out = runStatus(env, new Date("2026-10-05T00:00:00Z")).out;
    assert.match(out, /Hooks installed: yes/);
    assert.doesNotMatch(out, /WARNING/);
    installFake(env, join(f.home, "gone", "node"), process.execPath);
    assert.match(runStatus(env, new Date("2026-10-05T00:00:00Z")).out, /missing Node or CLI path/);
  } finally {
    f.cleanup();
  }
});

test("F8: hookCommandPaths parses quoted node and CLI paths", () => {
  assert.deepEqual(hookCommandPaths(buildHookCommand("/n o/node", "/a'b/cli.js", { LINEAGE_DATA_DIR: "/d x", LINEAGE_HOME_DIR: "/h" })), { node: "/n o/node", cli: "/a'b/cli.js" });
  assert.deepEqual(hookCommandPaths("'/usr/bin/node' --no-warnings '/x/cli.js' hook"), { node: "/usr/bin/node", cli: "/x/cli.js" });
  assert.equal(hookCommandPaths("my-linter"), null);
});
