import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, type NewEvent } from "../src/core/store.ts";
import { tempDir } from "./helpers.ts";

function ev(over: Partial<NewEvent> = {}): NewEvent {
  return {
    ts: "2026-10-02T12:00:00.000Z", sessionId: "s1", agentId: null, kind: "ingest",
    toolName: "WebFetch", sourceKind: "web", sourceId: "https://a.example/x", provisionalTier: "T4",
    indicators: null, surfacePath: null, blobSha: null, prevBlobSha: null, detail: null, ...over,
  };
}

test("events form a verifiable hash chain; tampering is detected", () => {
  const t = tempDir();
  const store = Store.open(t.path);
  try {
    store.insertEvent(ev());
    const second = store.insertEvent(ev({ kind: "write", surfacePath: "/p/CLAUDE.md", detail: { change: "modified", b: 1 } }));
    store.insertEvent(ev({ indicators: ["email:a@b.example"] }));
    assert.deepEqual(store.verifyChain(), { ok: true, brokenAtId: null, count: 3 });
    assert.deepEqual(store.listEvents({ kind: "write" })[0]?.detail, { b: 1, change: "modified" });
    store.db.prepare("UPDATE events SET source_id = 'evil' WHERE id = ?").run(second.id);
    assert.equal(store.verifyChain().ok, false);
    assert.equal(store.verifyChain().brokenAtId, second.id);
  } finally {
    store.close();
    t.cleanup();
  }
});

test("blobs are deduplicated and truncated at the cap", () => {
  const t = tempDir();
  const store = Store.open(t.path);
  try {
    const a = store.putBlob("hello");
    const b = store.putBlob("hello");
    assert.equal(a.sha, b.sha);
    assert.equal(store.getBlobText(a.sha), "hello");
    const big = store.putBlob("abcdef", 3);
    assert.equal(big.truncated, true);
    assert.notEqual(big.sha, big.originalSha);
    assert.equal(store.getBlobText(big.sha), "abc");
    assert.equal(store.getBlobText("missing"), null);
  } finally {
    store.close();
    t.cleanup();
  }
});

test("listEvents filters by session, kind, time, surface; desc + limit", () => {
  const t = tempDir();
  const store = Store.open(t.path);
  try {
    store.insertEvent(ev({ ts: "2026-10-01T00:00:00.000Z" }));
    store.insertEvent(ev({ sessionId: "s2", kind: "load", surfacePath: "/m.md" }));
    store.insertEvent(ev({ sessionId: "s2" }));
    assert.equal(store.listEvents({ sessionId: "s2" }).length, 2);
    assert.equal(store.listEvents({ sinceIso: "2026-10-02T00:00:00.000Z" }).length, 2);
    assert.equal(store.listEvents({ surfacePath: "/m.md" }).length, 1);
    const last = store.listEvents({ order: "desc", limit: 1 });
    assert.equal(last.length, 1);
    assert.equal(last[0]?.sessionId, "s2");
    assert.deepEqual(store.countByKind(), { ingest: 2, load: 1 });
  } finally {
    store.close();
    t.cleanup();
  }
});

test("sessions and surfaces upsert", () => {
  const t = tempDir();
  const store = Store.open(t.path);
  try {
    store.upsertSession({ id: "s1", projectRoot: "/p", startedAt: "2026-10-02T12:00:00.000Z", permissionMode: "default" });
    store.upsertSession({ id: "s1", projectRoot: "/p", startedAt: "2026-10-03T12:00:00.000Z", permissionMode: "acceptEdits" });
    assert.deepEqual(store.getSession("s1"), { id: "s1", projectRoot: "/p", startedAt: "2026-10-02T12:00:00.000Z", permissionMode: "acceptEdits" });
    assert.equal(store.listSessions("2026-10-02T00:00:00.000Z").length, 1);
    store.upsertSurface({ path: "/p/CLAUDE.md", scope: "project", projectRoot: "/p", lastSha: "a", lastSeenAt: "t1" });
    store.upsertSurface({ path: "/p/CLAUDE.md", scope: "project", projectRoot: "/p", lastSha: "b", lastSeenAt: "t2" });
    assert.equal(store.getSurface("/p/CLAUDE.md")?.lastSha, "b");
    assert.equal(store.listSurfaces().length, 1);
    assert.equal(store.getSurface("/nope"), null);
  } finally {
    store.close();
    t.cleanup();
  }
});

test("pruneIngestBlobs removes only old, unreferenced ingest blobs", () => {
  const t = tempDir();
  const store = Store.open(t.path);
  try {
    const oldBlob = store.putBlob("old page");
    const newBlob = store.putBlob("new page");
    const snap = store.putBlob("snapshot");
    store.insertEvent(ev({ ts: "2026-08-01T00:00:00.000Z", blobSha: oldBlob.sha }));
    store.insertEvent(ev({ ts: "2026-10-01T00:00:00.000Z", blobSha: newBlob.sha }));
    store.insertEvent(ev({ ts: "2026-08-01T00:00:00.000Z", kind: "write", blobSha: snap.sha }));
    assert.equal(store.pruneIngestBlobs("2026-09-01T00:00:00.000Z"), 1);
    assert.equal(store.getBlobText(oldBlob.sha), null);
    assert.equal(store.getBlobText(newBlob.sha), "new page");
    assert.equal(store.getBlobText(snap.sha), "snapshot");
  } finally {
    store.close();
    t.cleanup();
  }
});
