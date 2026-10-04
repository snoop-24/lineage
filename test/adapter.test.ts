import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractText, memoryDirFromTranscript, toCommonEvents } from "../src/adapters/claude-code.ts";
import { findProjectRoot } from "../src/core/project.ts";
import { tempDir } from "./helpers.ts";

const NOW = new Date("2026-10-02T12:00:00.000Z");
const base = { session_id: "s1", cwd: "/repo/sub", transcript_path: "/h/.claude/projects/-repo/s1.jsonl", permission_mode: "default" };

test("findProjectRoot walks up to .git", () => {
  const t = tempDir();
  try {
    mkdirSync(join(t.path, ".git"));
    mkdirSync(join(t.path, "a", "b"), { recursive: true });
    assert.equal(findProjectRoot(join(t.path, "a", "b")), t.path);
    assert.equal(findProjectRoot("/definitely/not/a/repo"), "/definitely/not/a/repo");
  } finally {
    t.cleanup();
  }
});

test("helpers", () => {
  assert.equal(memoryDirFromTranscript("/h/.claude/projects/-repo/s1.jsonl"), "/h/.claude/projects/-repo/memory");
  assert.equal(memoryDirFromTranscript(null), null);
  assert.equal(extractText({ a: "x", b: [1, "y", { c: "z" }], d: true }), "x\ny\nz");
  assert.equal(extractText("abcdef", 3), "abc");
});

test("session start, prompt, load, config change", () => {
  const [start] = toCommonEvents({ ...base, hook_event_name: "SessionStart" }, NOW);
  assert.deepEqual(start, {
    sessionId: "s1", ts: NOW.toISOString(), projectRoot: "/repo/sub", agentId: null,
    memoryDir: "/h/.claude/projects/-repo/memory", kind: "session_start", permissionMode: "default",
  });
  assert.equal(toCommonEvents({ ...base, hook_event_name: "UserPromptSubmit", prompt: "hi" }, NOW)[0]?.kind, "prompt");
  const [load] = toCommonEvents({ ...base, hook_event_name: "InstructionsLoaded", file_path: "CLAUDE.md", memory_type: "Project", load_reason: "session_start" }, NOW);
  assert.equal(load?.kind, "load");
  assert.equal(load?.kind === "load" ? load.filePath : "", "/repo/sub/CLAUDE.md");
  assert.equal(toCommonEvents({ ...base, hook_event_name: "ConfigChange" }, NOW)[0]?.kind, "config_change");
  assert.deepEqual(toCommonEvents({ ...base, hook_event_name: "Stop" }, NOW), []);
  assert.deepEqual(toCommonEvents({ hook_event_name: "SessionStart" }, NOW), []);
});

test("tool events", () => {
  const post = (tool_name: string, tool_input: unknown, tool_response: unknown = "") =>
    toCommonEvents({ ...base, hook_event_name: "PostToolUse", tool_name, tool_input, tool_response }, NOW)[0];
  const write = post("Write", { file_path: "/repo/CLAUDE.md", content: "x" });
  assert.equal(write?.kind === "file_write" ? write.filePath : "", "/repo/CLAUDE.md");
  const edit = post("Edit", { file_path: "notes/a.md", old_string: "a", new_string: "b" });
  assert.equal(edit?.kind === "file_write" ? edit.filePath : "", "/repo/sub/notes/a.md");
  const read = post("Read", { file_path: "/repo/README.md" }, { file: { content: "readme text" } });
  assert.ok(read?.kind === "ingest" && read.sourceKind === "file" && read.sourceId === "/repo/README.md" && read.text === "readme text");
  const web = post("WebFetch", { url: "https://a.example/x", prompt: "summarize" }, { result: "page" });
  assert.ok(web?.kind === "ingest" && web.sourceKind === "web" && web.sourceId === "https://a.example/x" && web.text === "page");
  const search = post("WebSearch", { query: "pvg" }, "results");
  assert.ok(search?.kind === "ingest" && search.sourceId === "search:pvg");
  const mcp = post("mcp__github__get_issue", { number: 3 }, { body: "issue body" });
  assert.ok(mcp?.kind === "ingest" && mcp.sourceKind === "mcp" && mcp.sourceId === "mcp:github/get_issue");
  const bash = post("Bash", { command: "curl -s https://a.example" }, { stdout: "out", stderr: "" });
  assert.ok(bash?.kind === "bash" && bash.command === "curl -s https://a.example" && bash.output.startsWith("out"));
  assert.equal(post("Glob", { pattern: "*" }), undefined);
});

// Contract test against real captured payloads (Task 2). Skipped if none were captured.
const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/claude-code/", import.meta.url));
const EXPECT: Record<string, string> = {
  SessionStart: "session_start",
  UserPromptSubmit: "prompt",
  "PostToolUse-WebFetch": "ingest",
  "PostToolUse-WebSearch": "ingest",
  "PostToolUse-Read": "ingest",
  "PostToolUse-Bash": "bash",
  "PostToolUse-Edit": "file_write",
  "PostToolUse-Write": "file_write",
  "PostToolUse-MultiEdit": "file_write",
  InstructionsLoaded: "load",
  ConfigChange: "config_change",
};
const fixtures = existsSync(FIXTURE_DIR) ? readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json")) : [];
test("captured fixtures present", { skip: fixtures.length === 0 ? "no captured fixtures; run Task 2" : false }, () => {
  assert.ok(fixtures.length > 0);
});
for (const f of fixtures) {
  const name = f.replace(/\.json$/, "");
  const expected = EXPECT[name];
  if (!expected) continue;
  test(`captured ${name} maps to ${expected}`, () => {
    const input = JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as Record<string, unknown>;
    const events = toCommonEvents(input, NOW);
    assert.ok(events.some((e) => e.kind === expected), `got ${JSON.stringify(events.map((e) => e.kind))}`);
  });
}
