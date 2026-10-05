import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildHookCommand, denyRuleFor, initCli, runInit, runUninstall } from "../src/cli/install.ts";
import { hooksInstalled, readSettings } from "../src/claude-settings.ts";
import { loadConfig } from "../src/config.ts";
import { configPath, type Env } from "../src/paths.ts";
import { tempDir } from "./helpers.ts";

const CMD = "'/usr/bin/node' --no-warnings '/x/cli.js' hook";
const NOW = new Date("2026-10-02T12:00:00Z");

function setup() {
  const t = tempDir();
  const home = join(t.path, "home");
  const env: Env = { home, dataDir: join(home, ".pvg"), claudeSettingsPath: join(home, ".claude", "settings.json") };
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(env.claudeSettingsPath, JSON.stringify({ model: "opus", hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] }] } }));
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "user rules\n");
  return { t, env };
}

const opts = (over: Partial<Parameters<typeof runInit>[1]> = {}) => ({ dryRun: false, protectData: false, command: CMD, now: NOW, platform: "linux" as const, ...over });

test("init merges hooks, backs up, records the command, baselines; second run is a no-op", () => {
  const { t, env } = setup();
  try {
    const r = runInit(env, opts());
    assert.equal(r.changes.length, 5);
    assert.ok(r.backupPath && existsSync(r.backupPath));
    const s = readSettings(env.claudeSettingsPath);
    assert.equal(s.model, "opus");
    assert.ok(hooksInstalled(s, CMD));
    assert.equal(s.hooks?.PostToolUse?.[0]?.hooks[0]?.command, "my-linter");
    assert.equal(loadConfig(configPath(env.dataDir)).installedCommand, CMD);
    assert.ok(r.baselined >= 2);
    const again = runInit(env, opts());
    assert.deepEqual(again.changes, []);
    assert.equal(again.backupPath, null);
  } finally {
    t.cleanup();
  }
});

test("dry run changes nothing", () => {
  const { t, env } = setup();
  try {
    const r = runInit(env, opts({ dryRun: true }));
    assert.equal(r.changes.length, 5);
    assert.equal(existsSync(env.dataDir), false);
    assert.equal(hooksInstalled(readSettings(env.claudeSettingsPath), CMD), false);
  } finally {
    t.cleanup();
  }
});

test("protect-data, re-init with a new command, uninstall, purge", () => {
  const { t, env } = setup();
  try {
    runInit(env, opts({ protectData: true }));
    assert.ok(readSettings(env.claudeSettingsPath).permissions?.deny?.includes("Edit(~/.pvg/**)"));
    const CMD2 = "'/usr/bin/node' --no-warnings '/y/cli.js' hook";
    const r2 = runInit(env, opts({ command: CMD2 }));
    assert.ok(r2.changes.includes("replace previous pvg hook command"));
    const s2 = readSettings(env.claudeSettingsPath);
    assert.ok(hooksInstalled(s2, CMD2));
    assert.ok(!JSON.stringify(s2).includes("/x/cli.js"));
    const u = runUninstall(env, { purge: false, now: NOW });
    assert.equal(u.removed, true);
    const s3 = readSettings(env.claudeSettingsPath);
    assert.equal(hooksInstalled(s3, CMD2), false);
    assert.equal(s3.hooks?.PostToolUse?.[0]?.hooks[0]?.command, "my-linter");
    assert.ok(!s3.permissions?.deny?.includes("Edit(~/.pvg/**)"));
    assert.equal(loadConfig(configPath(env.dataDir)).installedCommand, null);
    const p = runUninstall(env, { purge: true, now: NOW });
    assert.equal(p.removed, false);
    assert.equal(existsSync(env.dataDir), false);
  } finally {
    t.cleanup();
  }
});

test("hook command quoting, env prefix, deny rule paths", () => {
  assert.equal(
    buildHookCommand("/n o/node", "/a'b/cli.js", { PVG_DATA_DIR: "/d" }),
    "PVG_DATA_DIR='/d' '/n o/node' --no-warnings '/a'\\''b/cli.js' hook",
  );
  assert.equal(denyRuleFor({ home: "/h", dataDir: "/h/.pvg", claudeSettingsPath: "" }), "Edit(~/.pvg/**)");
  assert.equal(denyRuleFor({ home: "/h", dataDir: "/tmp/x", claudeSettingsPath: "" }), "Edit(//tmp/x/**)");
});

test("initCli prints changes and the protect-data recommendation", () => {
  const { t, env } = setup();
  try {
    const r = initCli([], env, NOW, "/x/cli.js");
    assert.equal(r.code, 0);
    assert.match(r.out, /add PostToolUse hook/);
    assert.match(r.out, /pvg init --protect-data/);
    assert.equal(initCli(["--nope"], env, NOW, "/x/cli.js").code, 2);
  } finally {
    t.cleanup();
  }
});

test("tampered install: broken matcher is detected and repaired", () => {
  const { t, env } = setup();
  try {
    // First init installs correctly
    runInit(env, opts());
    let s = readSettings(env.claudeSettingsPath);
    assert.ok(hooksInstalled(s, CMD));

    // Tamper: change the pvg PostToolUse group's matcher to something wrong
    // The pvg group is at index 1 (after the pre-existing "my-linter" group at index 0)
    s.hooks!.PostToolUse![1]!.matcher = "NoSuchTool";
    writeFileSync(env.claudeSettingsPath, JSON.stringify(s, null, 2) + "\n");

    // Second init should detect the tampering and fix it
    const r2 = runInit(env, opts());
    assert.ok(r2.changes.includes("add PostToolUse hook (matcher Write|Edit|MultiEdit|NotebookEdit|Read|WebFetch|WebSearch|Bash|mcp__.*)"));
    assert.ok(r2.backupPath !== null);

    // After init, hooks should be correctly installed again
    const s2 = readSettings(env.claudeSettingsPath);
    assert.ok(hooksInstalled(s2, CMD));
  } finally {
    t.cleanup();
  }
});
