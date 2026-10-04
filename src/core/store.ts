import { DatabaseSync } from "node:sqlite";
import { dbPath } from "../paths.ts";
import { canonicalJson, sha256 } from "./hash.ts";
import type { SourceKind, StoredKind, Tier } from "./events.ts";

export interface EventRow {
  id: number;
  ts: string;
  sessionId: string | null;
  agentId: string | null;
  kind: StoredKind;
  toolName: string | null;
  sourceKind: SourceKind | null;
  sourceId: string | null;
  provisionalTier: Tier | null;
  indicators: string[] | null;
  surfacePath: string | null;
  blobSha: string | null;
  prevBlobSha: string | null;
  detail: Record<string, unknown> | null;
  prevHash: string;
  hash: string;
}

export type NewEvent = Omit<EventRow, "id" | "prevHash" | "hash">;

export interface SessionRow {
  id: string;
  projectRoot: string;
  startedAt: string;
  permissionMode: string | null;
}

export interface SurfaceRow {
  path: string;
  scope: string;
  projectRoot: string | null;
  lastSha: string | null;
  lastSeenAt: string;
}

export interface EventFilter {
  sinceIso?: string;
  untilIso?: string;
  sessionId?: string;
  kind?: StoredKind;
  surfacePath?: string;
  limit?: number;
  order?: "asc" | "desc";
}

export interface BlobRef {
  sha: string;
  truncated: boolean;
  originalSha: string;
}

const GENESIS = "0".repeat(64);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_root TEXT NOT NULL,
  started_at TEXT NOT NULL,
  permission_mode TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  session_id TEXT,
  agent_id TEXT,
  kind TEXT NOT NULL,
  tool_name TEXT,
  source_kind TEXT,
  source_id TEXT,
  provisional_tier TEXT,
  indicators TEXT,
  surface_path TEXT,
  blob_sha TEXT,
  prev_blob_sha TEXT,
  detail TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);
CREATE INDEX IF NOT EXISTS idx_events_kind_ts ON events(kind, ts);
CREATE INDEX IF NOT EXISTS idx_events_surface ON events(surface_path, id);
CREATE TABLE IF NOT EXISTS blobs (
  sha TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  size INTEGER NOT NULL,
  original_size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS surfaces (
  path TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  project_root TEXT,
  last_sha TEXT,
  last_seen_at TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function eventHash(e: NewEvent, prevHash: string): string {
  return sha256(
    prevHash +
      canonicalJson({
        ts: e.ts,
        sessionId: e.sessionId,
        agentId: e.agentId,
        kind: e.kind,
        toolName: e.toolName,
        sourceKind: e.sourceKind,
        sourceId: e.sourceId,
        provisionalTier: e.provisionalTier,
        indicators: e.indicators,
        surfacePath: e.surfacePath,
        blobSha: e.blobSha,
        prevBlobSha: e.prevBlobSha,
        detail: e.detail,
      }),
  );
}

function toEventRow(r: Row): EventRow {
  return {
    id: Number(r.id),
    ts: String(r.ts),
    sessionId: strOrNull(r.session_id),
    agentId: strOrNull(r.agent_id),
    kind: String(r.kind) as StoredKind,
    toolName: strOrNull(r.tool_name),
    sourceKind: strOrNull(r.source_kind) as SourceKind | null,
    sourceId: strOrNull(r.source_id),
    provisionalTier: strOrNull(r.provisional_tier) as Tier | null,
    indicators: r.indicators ? (JSON.parse(String(r.indicators)) as string[]) : null,
    surfacePath: strOrNull(r.surface_path),
    blobSha: strOrNull(r.blob_sha),
    prevBlobSha: strOrNull(r.prev_blob_sha),
    detail: r.detail ? (JSON.parse(String(r.detail)) as Record<string, unknown>) : null,
    prevHash: String(r.prev_hash),
    hash: String(r.hash),
  };
}

function toSessionRow(r: Row): SessionRow {
  return {
    id: String(r.id),
    projectRoot: String(r.project_root),
    startedAt: String(r.started_at),
    permissionMode: strOrNull(r.permission_mode),
  };
}

function toSurfaceRow(r: Row): SurfaceRow {
  return {
    path: String(r.path),
    scope: String(r.scope),
    projectRoot: strOrNull(r.project_root),
    lastSha: strOrNull(r.last_sha),
    lastSeenAt: String(r.last_seen_at),
  };
}

export class Store {
  readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(dataDir: string): Store {
    const db = new DatabaseSync(dbPath(dataDir));
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    db.exec(SCHEMA);
    return new Store(db);
  }

  close(): void {
    this.db.close();
  }

  insertEvent(e: NewEvent): EventRow {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const last = this.db.prepare("SELECT hash FROM events ORDER BY id DESC LIMIT 1").get() as { hash: string } | undefined;
      const prevHash = last?.hash ?? GENESIS;
      const hash = eventHash(e, prevHash);
      const res = this.db
        .prepare(
          `INSERT INTO events (ts, session_id, agent_id, kind, tool_name, source_kind, source_id, provisional_tier,
             indicators, surface_path, blob_sha, prev_blob_sha, detail, prev_hash, hash)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          e.ts,
          e.sessionId,
          e.agentId,
          e.kind,
          e.toolName,
          e.sourceKind,
          e.sourceId,
          e.provisionalTier,
          e.indicators ? JSON.stringify(e.indicators) : null,
          e.surfacePath,
          e.blobSha,
          e.prevBlobSha,
          e.detail ? canonicalJson(e.detail) : null,
          prevHash,
          hash,
        );
      this.db.exec("COMMIT");
      return { ...e, id: Number(res.lastInsertRowid), prevHash, hash };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  putBlob(text: string, capBytes: number = 1_048_576): BlobRef {
    const full = Buffer.from(text, "utf8");
    const originalSha = sha256(full);
    const truncated = full.length > capBytes;
    const stored = truncated ? full.subarray(0, capBytes) : full;
    const sha = truncated ? sha256(stored) : originalSha;
    this.db
      .prepare("INSERT OR IGNORE INTO blobs (sha, bytes, size, original_size, created_at) VALUES (?,?,?,?,?)")
      .run(sha, stored, stored.length, full.length, new Date().toISOString());
    return { sha, truncated, originalSha };
  }

  getBlobText(sha: string): string | null {
    const row = this.db.prepare("SELECT bytes FROM blobs WHERE sha = ?").get(sha) as { bytes: Uint8Array } | undefined;
    return row ? Buffer.from(row.bytes).toString("utf8") : null;
  }

  upsertSession(s: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_root, started_at, permission_mode) VALUES (?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET permission_mode = excluded.permission_mode`,
      )
      .run(s.id, s.projectRoot, s.startedAt, s.permissionMode);
  }

  getSession(id: string): SessionRow | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return row ? toSessionRow(row) : null;
  }

  listSessions(sinceIso: string): SessionRow[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE started_at >= ? ORDER BY started_at ASC").all(sinceIso) as Row[]).map(
      toSessionRow,
    );
  }

  getSurface(path: string): SurfaceRow | null {
    const row = this.db.prepare("SELECT * FROM surfaces WHERE path = ?").get(path) as Row | undefined;
    return row ? toSurfaceRow(row) : null;
  }

  upsertSurface(s: SurfaceRow): void {
    this.db
      .prepare(
        `INSERT INTO surfaces (path, scope, project_root, last_sha, last_seen_at) VALUES (?,?,?,?,?)
         ON CONFLICT(path) DO UPDATE SET scope = excluded.scope, project_root = excluded.project_root,
           last_sha = excluded.last_sha, last_seen_at = excluded.last_seen_at`,
      )
      .run(s.path, s.scope, s.projectRoot, s.lastSha, s.lastSeenAt);
  }

  listSurfaces(): SurfaceRow[] {
    return (this.db.prepare("SELECT * FROM surfaces ORDER BY path").all() as Row[]).map(toSurfaceRow);
  }

  listEvents(f: EventFilter = {}): EventRow[] {
    const where: string[] = [];
    const params: string[] = [];
    if (f.sinceIso) {
      where.push("ts >= ?");
      params.push(f.sinceIso);
    }
    if (f.untilIso) {
      where.push("ts <= ?");
      params.push(f.untilIso);
    }
    if (f.sessionId) {
      where.push("session_id = ?");
      params.push(f.sessionId);
    }
    if (f.kind) {
      where.push("kind = ?");
      params.push(f.kind);
    }
    if (f.surfacePath) {
      where.push("surface_path = ?");
      params.push(f.surfacePath);
    }
    const sql =
      `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ` +
      `ORDER BY id ${f.order === "desc" ? "DESC" : "ASC"}${f.limit ? ` LIMIT ${Math.floor(f.limit)}` : ""}`;
    return (this.db.prepare(sql).all(...params) as Row[]).map(toEventRow);
  }

  countByKind(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.prepare("SELECT kind, COUNT(*) AS n FROM events GROUP BY kind ORDER BY kind").all() as Row[]) {
      out[String(r.kind)] = Number(r.n);
    }
    return out;
  }

  verifyChain(): { ok: boolean; brokenAtId: number | null; count: number } {
    let prev = GENESIS;
    let count = 0;
    for (const row of this.db.prepare("SELECT * FROM events ORDER BY id ASC").all() as Row[]) {
      const e = toEventRow(row);
      count += 1;
      if (e.prevHash !== prev || eventHash(e, prev) !== e.hash) return { ok: false, brokenAtId: e.id, count };
      prev = e.hash;
    }
    return { ok: true, brokenAtId: null, count };
  }

  pruneIngestBlobs(olderThanIso: string): number {
    const res = this.db
      .prepare(
        `DELETE FROM blobs
         WHERE sha IN (SELECT blob_sha FROM events WHERE kind = 'ingest' AND ts < ? AND blob_sha IS NOT NULL)
           AND sha NOT IN (SELECT blob_sha FROM events WHERE kind = 'ingest' AND ts >= ? AND blob_sha IS NOT NULL)
           AND sha NOT IN (SELECT blob_sha FROM events WHERE kind <> 'ingest' AND blob_sha IS NOT NULL)
           AND sha NOT IN (SELECT prev_blob_sha FROM events WHERE prev_blob_sha IS NOT NULL)
           AND sha NOT IN (SELECT last_sha FROM surfaces WHERE last_sha IS NOT NULL)`,
      )
      .run(olderThanIso, olderThanIso);
    return Number(res.changes);
  }
}
