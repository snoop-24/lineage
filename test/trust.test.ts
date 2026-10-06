import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { globToRegExp } from "../src/core/glob.ts";
import {
  addRule, classify, defaultTier, inferRule, loadTrust, parseTier, proposeTrust, removeRule, saveTrust,
  type TrustConfig,
} from "../src/core/trust.ts";
import { tempDir } from "./helpers.ts";

const root = "/p";
const home = "/h";
const none: TrustConfig = { rules: [] };

test("globToRegExp", () => {
  assert.ok(globToRegExp("/a/**").test("/a/b/c"));
  assert.ok(globToRegExp("**/CLAUDE.md").test("CLAUDE.md"));
  assert.ok(globToRegExp("**/CLAUDE.md").test("x/y/CLAUDE.md"));
  assert.ok(globToRegExp("*.md").test("a.md"));
  assert.ok(!globToRegExp("*.md").test("a/b.md"));
  assert.ok(globToRegExp("file?.txt").test("file1.txt"));
});

test("default tiers", () => {
  assert.equal(defaultTier("prompt", "x", root, home), "T0");
  assert.equal(defaultTier("file", "/p/src/a.ts", root, home), "T1");
  assert.equal(defaultTier("file", "/p/node_modules/x/README.md", root, home), "T3");
  assert.equal(defaultTier("file", "/etc/hosts", root, home), "T4");
  assert.equal(defaultTier("web", "https://a.example", root, home), "T4");
  assert.equal(classify("web", "https://a.example", root, none, home), "T4");
});

test("rules: domain suffix, mcp server, path with ~", () => {
  const cfg: TrustConfig = {
    rules: [
      { type: "domain", match: "python.org", tier: "T2" },
      { type: "mcp_server", match: "github", tier: "T2" },
      { type: "path", match: "~/notes/**", tier: "T2" },
    ],
  };
  assert.equal(classify("web", "https://docs.python.org/3/", root, cfg, home), "T2");
  assert.equal(classify("web", "https://evilpython.org/", root, cfg, home), "T4");
  assert.equal(classify("mcp", "mcp:github/get_issue", root, cfg, home), "T2");
  assert.equal(classify("mcp", "mcp:slack/read", root, cfg, home), "T4");
  assert.equal(classify("file", "/h/notes/a.md", root, cfg, home), "T2");
});

test("personalization only tightens trusted defaults; most restrictive wins", () => {
  const demote: TrustConfig = { rules: [{ type: "path", match: "/p/generated/**", tier: "T4" }] };
  assert.equal(classify("file", "/p/generated/x.md", root, demote, home), "T4");
  const promoteWorkspace: TrustConfig = { rules: [{ type: "path", match: "/p/**", tier: "T2" }] };
  assert.equal(classify("file", "/p/src/a.ts", root, promoteWorkspace, home), "T1");
  const conflict: TrustConfig = {
    rules: [
      { type: "domain", match: "example.com", tier: "T2" },
      { type: "domain", match: "example.com", tier: "T4" },
    ],
  };
  assert.equal(classify("web", "https://example.com/a", root, conflict, home), "T4");
  assert.equal(classify("prompt", "anything", root, demote, home), "T0");
});

test("proposal: frequent untrusted sources across sessions only", () => {
  const items = proposeTrust([
    { sourceKind: "web", sourceId: "https://docs.python.org/3/a", sessionId: "s1", tier: "T4" },
    { sourceKind: "web", sourceId: "https://docs.python.org/3/b", sessionId: "s1", tier: "T4" },
    { sourceKind: "web", sourceId: "https://docs.python.org/3/c", sessionId: "s2", tier: "T4" },
    { sourceKind: "web", sourceId: "https://rare.example/x", sessionId: "s1", tier: "T4" },
    { sourceKind: "search", sourceId: "search:python", sessionId: "s1", tier: "T4" },
    { sourceKind: "file", sourceId: "/p/node_modules/a/README.md", sessionId: "s1", tier: "T3" },
  ]);
  assert.deepEqual(items, [{ type: "domain", match: "docs.python.org", reads: 3, sessions: 2 }]);
});

test("rule editing, tier aliases, rule inference, load/save validation", () => {
  let cfg = addRule(none, { type: "domain", match: "a.example", tier: "T2" });
  cfg = addRule(cfg, { type: "domain", match: "a.example", tier: "T4" });
  assert.deepEqual(cfg.rules, [{ type: "domain", match: "a.example", tier: "T4" }]);
  const r = removeRule(cfg, "domain", "a.example");
  assert.equal(r.removed, true);
  assert.equal(r.cfg.rules.length, 0);
  assert.equal(parseTier("trusted"), "T2");
  assert.equal(parseTier("external"), "T4");
  assert.equal(parseTier("T0"), null);
  assert.deepEqual(inferRule("mcp:github"), { type: "mcp_server", match: "github" });
  assert.deepEqual(inferRule("~/notes/**"), { type: "path", match: "~/notes/**" });
  assert.deepEqual(inferRule("https://Docs.Python.org/3/"), { type: "domain", match: "docs.python.org" });
  assert.deepEqual(inferRule("docs.python.org"), { type: "domain", match: "docs.python.org" });

  const t = tempDir();
  try {
    const p = join(t.path, "trust.json");
    assert.deepEqual(loadTrust(p), { rules: [] });
    writeFileSync(p, JSON.stringify({ rules: [
      { type: "domain", match: "a.example", tier: "T2" },
      { type: "bogus", match: "x", tier: "T2" },
      { type: "domain", match: "b.example", tier: "T0" },
    ] }));
    assert.deepEqual(loadTrust(p), { rules: [{ type: "domain", match: "a.example", tier: "T2" }] });
    saveTrust(p, cfg);
    assert.deepEqual(loadTrust(p), cfg);
  } finally {
    t.cleanup();
  }
});

test("loadTrust handles corrupt JSON and null values without throwing", () => {
  const t = tempDir();
  try {
    const p = join(t.path, "trust.json");
    // Missing file returns empty
    assert.deepEqual(loadTrust(p), { rules: [] });
    // File containing null should return empty
    writeFileSync(p, "null");
    assert.deepEqual(loadTrust(p), { rules: [] });
    // Invalid JSON should return empty
    writeFileSync(p, "{not json");
    assert.deepEqual(loadTrust(p), { rules: [] });
    // Array should return empty (arrays parse as objects but have no .rules)
    writeFileSync(p, "[]");
    assert.deepEqual(loadTrust(p), { rules: [] });
  } finally {
    t.cleanup();
  }
});

test("glob avoids backtracking on consecutive **/", () => {
  // Consecutive **/ patterns should still work
  assert.ok(globToRegExp("**/**/CLAUDE.md").test("CLAUDE.md"));
  assert.ok(globToRegExp("**/**/CLAUDE.md").test("x/y/CLAUDE.md"));

  // Heavy backtracking test: many **/ should be fast (< 50ms)
  const pattern = "**/**/**/**/**/**/**/x";
  const testString = "a/".repeat(60) + "y";
  const start = performance.now();
  const result = globToRegExp(pattern).test(testString);
  const elapsed = performance.now() - start;

  assert.equal(result, false, "pattern should not match");
  assert.ok(elapsed < 50, `test should complete in < 50ms, took ${elapsed.toFixed(2)}ms`);
});

test("inferRule extracts correct server and domain segments", () => {
  // mcp: should extract only server name, not full path
  assert.deepEqual(inferRule("mcp:github/get_issue"), { type: "mcp_server", match: "github" });
  // scheme-less domain with path should extract only domain
  assert.deepEqual(inferRule("python.org/3/"), { type: "domain", match: "python.org" });
  // existing tests should still pass
  assert.deepEqual(inferRule("mcp:github"), { type: "mcp_server", match: "github" });
  assert.deepEqual(inferRule("~/notes/**"), { type: "path", match: "~/notes/**" });
  assert.deepEqual(inferRule("https://Docs.Python.org/3/"), { type: "domain", match: "docs.python.org" });
  assert.deepEqual(inferRule("docs.python.org"), { type: "domain", match: "docs.python.org" });
});

test("F6: only your own ~/.claude agent files and CLAUDE.md files above the project are trusted outside it", () => {
  const proj = "/h/work/proj";
  // Your own memory and instruction files under ~/.claude
  assert.equal(defaultTier("file", "/h/.claude/CLAUDE.md", proj, home), "T1");
  assert.equal(defaultTier("file", "/h/.claude/rules/style.md", proj, home), "T1");
  assert.equal(defaultTier("file", "/h/.claude/skills/deploy/SKILL.md", proj, home), "T1");
  assert.equal(defaultTier("file", "/h/.claude/skills/deploy/helper.sh", proj, home), "T1");
  assert.equal(defaultTier("file", "/h/.claude/projects/p/memory/topic.md", proj, home), "T1");
  // CLAUDE.md files in directories above the project, which Claude Code loads
  assert.equal(defaultTier("file", "/h/work/CLAUDE.md", proj, home), "T1");
  assert.equal(defaultTier("file", "/h/work/CLAUDE.local.md", proj, home), "T1");
  assert.equal(defaultTier("file", "/h/CLAUDE.md", proj, home), "T1");
  // Third-party files that merely share the names are not trusted
  assert.equal(defaultTier("file", "/elsewhere/AGENTS.md", proj, home), "T4");
  assert.equal(defaultTier("file", "/elsewhere/CLAUDE.md", proj, home), "T4");
  assert.equal(defaultTier("file", "/h/work/other/CLAUDE.md", proj, home), "T4");
  assert.equal(defaultTier("file", "/h/work/AGENTS.md", proj, home), "T4");
  assert.equal(defaultTier("file", "/tmp/x/.claude/skills/a/SKILL.md", proj, home), "T4");
  assert.equal(defaultTier("file", "/tmp/x/.claude/rules/r.md", proj, home), "T4");
  assert.equal(defaultTier("file", "/tmp/.claude/projects/p/memory/x.md", proj, home), "T4");
  assert.equal(defaultTier("file", "/h/.claude/skills/../../evil/CLAUDE.md", proj, home), "T4");
  assert.equal(defaultTier("file", "/h/work/proj/node_modules/pkg/CLAUDE.md", proj, home), "T3");
  assert.equal(defaultTier("file", "/h/work/proj/node_modules/pkg/.claude/skills/s/SKILL.md", proj, home), "T3");
  // Other files under ~/.claude stay untrusted
  assert.equal(defaultTier("file", "/elsewhere/README.md", proj, home), "T4");
  assert.equal(defaultTier("file", "/h/.claude/projects/p/transcript.jsonl", proj, home), "T4");
  assert.equal(defaultTier("file", "/h/.claude/settings.json", proj, home), "T4");
  // Unknown project root: no ancestors are trusted
  assert.equal(defaultTier("file", "/CLAUDE.md", "/\u0000pvg-unknown-root", home), "T4");
  assert.equal(defaultTier("file", "/h/.claude/CLAUDE.md", "/\u0000pvg-unknown-root", home), "T1");
  // Your rules can still demote trusted files
  const demote: TrustConfig = { rules: [{ type: "path", match: "/h/work/**", tier: "T4" }] };
  assert.equal(classify("file", "/h/work/CLAUDE.md", proj, demote, home), "T4");
});
