import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { handleHookInput } from "../src/cli/hook.ts";
import { Store } from "../src/core/store.ts";
import type { Env } from "../src/paths.ts";
import { tempDir } from "./helpers.ts";

function env(root: string): Env {
  return { home: join(root, "home"), dataDir: join(root, "data"), claudeSettingsPath: join(root, "home", ".claude", "settings.json") };
}

test("invalid input is logged, never thrown", () => {
  const t = tempDir();
  try {
    const e = env(t.path);
    handleHookInput("{not json", e);
    assert.match(readFileSync(join(e.dataDir, "errors.log"), "utf8"), /JSON/);
  } finally {
    t.cleanup();
  }
});

test("irrelevant events create nothing", () => {
  const t = tempDir();
  try {
    const e = env(t.path);
    handleHookInput(JSON.stringify({ hook_event_name: "Stop", session_id: "s", cwd: t.path }), e);
    assert.equal(existsSync(e.dataDir), false);
  } finally {
    t.cleanup();
  }
});

test("session start is recorded", () => {
  const t = tempDir();
  try {
    const e = env(t.path);
    mkdirSync(join(t.path, "proj", ".git"), { recursive: true });
    handleHookInput(JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1", cwd: join(t.path, "proj") }), e);
    const store = Store.open(e.dataDir);
    try {
      assert.equal(store.listEvents({ kind: "session_start" }).length, 1);
    } finally {
      store.close();
    }
  } finally {
    t.cleanup();
  }
});

test("CLI hook exits 0 and prints nothing, even on garbage", () => {
  const t = tempDir();
  try {
    const r = spawnSync(process.execPath, ["--no-warnings", "src/cli.ts", "hook"], {
      input: "garbage",
      encoding: "utf8",
      env: { ...process.env, PVG_DATA_DIR: join(t.path, "data"), PVG_HOME_DIR: join(t.path, "home") },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  } finally {
    t.cleanup();
  }
});
