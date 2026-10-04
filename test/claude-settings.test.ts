import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addDenyRule, addHooks, HOOK_EVENTS, hooksInstalled, readSettings, removeDenyRule, removeHooks,
  writeSettingsWithBackup, type Settings,
} from "../src/claude-settings.ts";
import { tempDir } from "./helpers.ts";

const CMD = "'/usr/bin/node' --no-warnings '/x/cli.js' hook";
const userSettings: Settings = {
  model: "opus",
  hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] }] },
};

test("addHooks preserves user config, adds all events, is idempotent", () => {
  const once = addHooks(userSettings, CMD);
  assert.equal(once.model, "opus");
  assert.equal(hooksInstalled(once, CMD), true);
  assert.equal(hooksInstalled(userSettings, CMD), false);
  for (const ev of HOOK_EVENTS) assert.ok(once.hooks?.[ev], `missing ${ev}`);
  assert.equal(once.hooks?.PostToolUse?.length, 2);
  const twice = addHooks(once, CMD);
  assert.deepEqual(twice, once);
});

test("removeHooks removes only pvg entries", () => {
  const removed = removeHooks(addHooks(userSettings, CMD), CMD);
  assert.deepEqual(removed, userSettings);
  assert.deepEqual(removeHooks(addHooks({}, CMD), CMD), {});
});

test("deny rule add/remove", () => {
  const withRule = addDenyRule(addDenyRule({}, "Edit(~/.pvg/**)"), "Edit(~/.pvg/**)");
  assert.deepEqual(withRule.permissions?.deny, ["Edit(~/.pvg/**)"]);
  assert.deepEqual(removeDenyRule(withRule, "Edit(~/.pvg/**)").permissions?.deny, []);
});

test("read/write with backup", () => {
  const t = tempDir();
  try {
    const p = join(t.path, "settings.json");
    assert.deepEqual(readSettings(p), {});
    assert.equal(writeSettingsWithBackup(p, { a: 1 }, new Date("2026-10-02T12:00:00Z")), null);
    const backup = writeSettingsWithBackup(p, { a: 2 }, new Date("2026-10-02T12:00:01Z"));
    assert.ok(backup && existsSync(backup));
    assert.deepEqual(JSON.parse(readFileSync(backup, "utf8")), { a: 1 });
    assert.deepEqual(readSettings(p), { a: 2 });
    writeFileSync(p, "[]");
    assert.throws(() => readSettings(p), /not a JSON object/);
  } finally {
    t.cleanup();
  }
});
