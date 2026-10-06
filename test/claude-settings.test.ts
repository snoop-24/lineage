import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addDenyRule, addHooks, HOOK_EVENTS, hookInstalledFor, hooksInstalled, readSettings, removeDenyRule, removeHooks,
  writeSettingsWithBackup, type HookEvent, type Settings,
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

test("removeHooks removes only lineage entries", () => {
  const removed = removeHooks(addHooks(userSettings, CMD), CMD);
  assert.deepEqual(removed, userSettings);
  assert.deepEqual(removeHooks(addHooks({}, CMD), CMD), {});
});

test("deny rule add/remove", () => {
  const withRule = addDenyRule(addDenyRule({}, "Edit(~/.lineage/**)"), "Edit(~/.lineage/**)");
  assert.deepEqual(withRule.permissions?.deny, ["Edit(~/.lineage/**)"]);
  assert.deepEqual(removeDenyRule(withRule, "Edit(~/.lineage/**)").permissions?.deny, []);
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

test("hooksInstalled is false when matcher is altered or type is changed", () => {
  const original = addHooks({}, CMD);

  // (a) PostToolUse matcher changed to "NoSuchTool"
  const tamperedMatcher = JSON.parse(JSON.stringify(original));
  tamperedMatcher.hooks.PostToolUse[0].matcher = "NoSuchTool";
  assert.equal(hooksInstalled(tamperedMatcher, CMD), false, "should fail when PostToolUse matcher altered");

  // (b) Any lineage entry's type changed to "prompt"
  const tamperedType = JSON.parse(JSON.stringify(original));
  tamperedType.hooks.PostToolUse[0].hooks[0].type = "prompt";
  assert.equal(hooksInstalled(tamperedType, CMD), false, "should fail when entry type altered");

  // (c) matcher: "startup" added to SessionStart lineage group
  const tamperedSessionStart = JSON.parse(JSON.stringify(original));
  tamperedSessionStart.hooks.SessionStart[0].matcher = "startup";
  assert.equal(hooksInstalled(tamperedSessionStart, CMD), false, "should fail when SessionStart has matcher");

  // (d) One event's array is deleted
  const tamperedDeleted = JSON.parse(JSON.stringify(original));
  delete tamperedDeleted.hooks.SessionStart;
  assert.equal(hooksInstalled(tamperedDeleted, CMD), false, "should fail when event array deleted");

  // Different command string
  assert.equal(hooksInstalled(original, "different-command"), false, "should fail for different command");
});

test("addHooks repairs tampered installations", () => {
  // (a) Repaired from altered matcher
  let tampered = JSON.parse(JSON.stringify(addHooks({}, CMD)));
  tampered.hooks.PostToolUse[0].matcher = "NoSuchTool";
  assert.equal(hooksInstalled(tampered, CMD), false);
  const repaired_a = addHooks(tampered, CMD);
  assert.equal(hooksInstalled(repaired_a, CMD), true, "should repair altered matcher");

  // (b) Repaired from altered type
  tampered = JSON.parse(JSON.stringify(addHooks({}, CMD)));
  tampered.hooks.PostToolUse[0].hooks[0].type = "prompt";
  assert.equal(hooksInstalled(tampered, CMD), false);
  const repaired_b = addHooks(tampered, CMD);
  assert.equal(hooksInstalled(repaired_b, CMD), true, "should repair altered type");

  // (c) Repaired from added matcher on SessionStart
  tampered = JSON.parse(JSON.stringify(addHooks({}, CMD)));
  tampered.hooks.SessionStart[0].matcher = "startup";
  assert.equal(hooksInstalled(tampered, CMD), false);
  const repaired_c = addHooks(tampered, CMD);
  assert.equal(hooksInstalled(repaired_c, CMD), true, "should repair added matcher");

  // Verify exactly one lineage entry per event after repair
  for (const ev of HOOK_EVENTS) {
    const groups = repaired_c.hooks?.[ev] ?? [];
    let lineageEntryCount = 0;
    for (const g of groups) {
      for (const h of g.hooks ?? []) {
        if (h.command === CMD) lineageEntryCount++;
      }
    }
    assert.equal(lineageEntryCount, 1, `should have exactly one lineage entry for ${ev}`);
  }
});

test("hookInstalledFor exported and works correctly", () => {
  const installed = addHooks({}, CMD);
  for (const ev of HOOK_EVENTS) {
    assert.equal(hookInstalledFor(installed, ev as HookEvent, CMD), true, `hookInstalledFor should be true for ${ev}`);
  }

  // Verify it returns false when altered
  const tampered = JSON.parse(JSON.stringify(installed));
  tampered.hooks.PostToolUse[0].matcher = "NoSuchTool";
  assert.equal(hookInstalledFor(tampered, "PostToolUse" as HookEvent, CMD), false, "should detect altered matcher");
});
