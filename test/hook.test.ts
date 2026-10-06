import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { handleHookInput } from "../src/cli/hook.ts";
import { Store } from "../src/core/store.ts";
import type { Env } from "../src/paths.ts";
import { tempDir } from "./helpers.ts";

function env(root: string): Env {
  return { home: join(root, "home"), dataDir: join(root, "data"), claudeSettingsPath: join(root, "home", ".claude", "settings.json") };
}

test("handleHookInput never throws, even when dataDir is a regular file", () => {
  const t = tempDir();
  try {
    const e = env(t.path);
    writeFileSync(e.dataDir, "");
    assert.doesNotThrow(() => {
      handleHookInput(JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1", cwd: t.path }), e);
    });
  } finally {
    t.cleanup();
  }
});

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
      env: { ...process.env, LINEAGE_DATA_DIR: join(t.path, "data"), LINEAGE_HOME_DIR: join(t.path, "home") },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
  } finally {
    t.cleanup();
  }
});

test("F3: unrecognized PostToolUse payload for a handled tool logs field names only", () => {
  const t = tempDir();
  try {
    const e = env(t.path);
    handleHookInput(
      JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s1", cwd: t.path, tool_name: "WebFetch", tool_input: { href: "x" }, tool_response: "secret-page-body" }),
      e,
    );
    const log = readFileSync(join(e.dataDir, "errors.log"), "utf8");
    assert.equal(log.trim().split("\n").length, 1);
    assert.match(log, /unrecognized PostToolUse payload: tool=WebFetch tool_input keys=href\n$/);
    assert.doesNotMatch(log, /"x"|=x\b|secret-page-body/);
  } finally {
    t.cleanup();
  }
});

test("F3: unhandled tools and recognized payloads write no error line", () => {
  const t = tempDir();
  try {
    const e = env(t.path);
    handleHookInput(JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s1", cwd: t.path, tool_name: "TodoWrite", tool_input: { todos: [] } }), e);
    handleHookInput(JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s1", cwd: t.path, tool_name: "WebFetch", tool_input: { url: "https://a.example/" }, tool_response: "ok" }), e);
    assert.equal(existsSync(join(e.dataDir, "errors.log")), false);
  } finally {
    t.cleanup();
  }
});

test("M2: invalid hook JSON logs its size, never its content", () => {
  const t = tempDir();
  try {
    const e = env(t.path);
    handleHookInput("secret-token-123{", e);
    const log = readFileSync(join(e.dataDir, "errors.log"), "utf8");
    assert.match(log, /SyntaxError: invalid hook JSON \(17 bytes\)/);
    assert.doesNotMatch(log, /secret-token-123/);
  } finally {
    t.cleanup();
  }
});
