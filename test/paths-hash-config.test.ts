import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveEnv, dbPath, trustPath } from "../src/paths.ts";
import { sha256, canonicalJson } from "../src/core/hash.ts";
import { loadConfig, saveConfig, DEFAULT_CONFIG } from "../src/config.ts";
import { tempDir } from "./helpers.ts";

test("resolveEnv uses overrides", () => {
  const env = resolveEnv({ PVG_HOME_DIR: "/h", PVG_DATA_DIR: "/d", PVG_CLAUDE_SETTINGS: "/s.json" });
  assert.deepEqual(env, { home: "/h", dataDir: "/d", claudeSettingsPath: "/s.json" });
});

test("resolveEnv defaults under home", () => {
  const env = resolveEnv({ PVG_HOME_DIR: "/h" });
  assert.equal(env.dataDir, "/h/.pvg");
  assert.equal(env.claudeSettingsPath, "/h/.claude/settings.json");
  assert.equal(dbPath(env.dataDir), "/h/.pvg/pvg.db");
  assert.equal(trustPath(env.dataDir), "/h/.pvg/trust.json");
});

test("sha256 matches known vector", () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("canonicalJson sorts keys recursively", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
});

test("config defaults, round-trip, and invalid values", () => {
  const t = tempDir();
  try {
    const p = join(t.path, "config.json");
    assert.deepEqual(loadConfig(p), DEFAULT_CONFIG);
    saveConfig(p, { installedCommand: "x", protectDataAdded: false, retentionDays: 7, ingestCapBytes: 10 });
    assert.deepEqual(loadConfig(p), { installedCommand: "x", protectDataAdded: false, retentionDays: 7, ingestCapBytes: 10 });
    writeFileSync(p, JSON.stringify({ installedCommand: 3, retentionDays: -1 }));
    assert.deepEqual(loadConfig(p), DEFAULT_CONFIG);
  } finally {
    t.cleanup();
  }
});
