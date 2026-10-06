// Applies CommonEvents to the store. Pure bookkeeping: string and hash comparisons only, never interprets content.
import { resolve } from "node:path";
import type { CommonEvent, SourceKind } from "./events.ts";
import type { NewEvent, Store } from "./store.ts";
import { classify, type TrustConfig } from "./trust.ts";
import { extractIndicators } from "./indicators.ts";
import { detectNetworkSources } from "./bash-parse.ts";
import {
  classifySurfacePath, discoverSurfaces, isInside, parseImports, readSurface, rescanTargets,
  type SurfaceContext, type SurfaceScope, type SurfaceTarget,
} from "./surfaces.ts";
import { hooksInstalled, readSettings, type Settings } from "../claude-settings.ts";

export interface RecorderDeps {
  store: Store;
  trust: TrustConfig;
  home: string;
  platform: NodeJS.Platform;
  settingsPath: string;
  installedCommand: string | null;
  ingestCapBytes: number;
  retentionDays: number;
}

const SNAPSHOT_CAP = 1_048_576;
const NO_CAP = Number.POSITIVE_INFINITY;

type ChangeType = "created" | "modified" | "deleted";

function newEvent(ev: CommonEvent, fields: Partial<NewEvent> & Pick<NewEvent, "kind">): NewEvent {
  return {
    ts: ev.ts,
    sessionId: ev.sessionId,
    agentId: ev.agentId,
    toolName: null,
    sourceKind: null,
    sourceId: null,
    provisionalTier: null,
    indicators: null,
    surfacePath: null,
    blobSha: null,
    prevBlobSha: null,
    detail: null,
    ...fields,
  };
}

const changeType = (prev: string | null, next: string | null): ChangeType =>
  next === null ? "deleted" : prev === null ? "created" : "modified";

const scopeRoot = (scope: string, root: string): string | null => (scope === "project" || scope === "import" ? root : null);

function safeReadSettings(path: string): Settings {
  try {
    return readSettings(path);
  } catch {
    return {};
  }
}

export function record(ev: CommonEvent, d: RecorderDeps): void {
  const ctx: SurfaceContext = { home: d.home, projectRoot: ev.projectRoot, memoryDir: ev.memoryDir, platform: d.platform };
  switch (ev.kind) {
    case "session_start": {
      d.store.upsertSession({ id: ev.sessionId, projectRoot: ev.projectRoot, startedAt: ev.ts, permissionMode: ev.permissionMode });
      d.store.insertEvent(newEvent(ev, { kind: "session_start", detail: { projectRoot: ev.projectRoot } }));
      scanAndRecord(discoverSurfaces(ctx), ev, d, "between_sessions", null);
      d.store.pruneIngestBlobs(new Date(Date.parse(ev.ts) - d.retentionDays * 86_400_000).toISOString());
      return;
    }
    case "prompt": {
      const blob = d.store.putBlob(ev.text, d.ingestCapBytes);
      d.store.insertEvent(newEvent(ev, { kind: "prompt", provisionalTier: "T0", blobSha: blob.sha }));
      return;
    }
    case "ingest":
      recordIngest(ev, ev.toolName, ev.sourceKind, ev.sourceId, ev.text, d);
      // MCP tools can write files no hook sees; rescan like the Bash path, attributed to the MCP source.
      if (ev.sourceKind === "mcp") scanAndRecord(rescanTargets(ctx, d.store.listSurfaces()), ev, d, "in_session", ev.sourceId);
      return;
    case "file_write":
      recordFileWrite(ev, resolve(ev.filePath), ev.toolName, ctx, d);
      return;
    case "bash": {
      for (const src of detectNetworkSources(ev.command)) recordIngest(ev, ev.toolName, "network", src.sourceId, ev.output, d);
      scanAndRecord(rescanTargets(ctx, d.store.listSurfaces()), ev, d, "in_session", ev.command);
      return;
    }
    case "load": {
      const path = resolve(ev.filePath);
      const cur = readSurface(path, SNAPSHOT_CAP);
      const blobSha = cur ? d.store.putBlob(cur.text, NO_CAP).sha : null;
      d.store.insertEvent(
        newEvent(ev, { kind: "load", surfacePath: path, blobSha, detail: { memoryType: ev.memoryType, loadReason: ev.loadReason } }),
      );
      return;
    }
    case "config_change": {
      const blob = d.store.putBlob(ev.raw, d.ingestCapBytes);
      d.store.insertEvent(newEvent(ev, { kind: "config_change", blobSha: blob.sha }));
      if (d.installedCommand && !hooksInstalled(safeReadSettings(d.settingsPath), d.installedCommand)) {
        d.store.insertEvent(
          newEvent(ev, { kind: "tamper", detail: { reason: "lineage hook entries missing from Claude Code settings", settingsPath: d.settingsPath } }),
        );
      }
      return;
    }
  }
}

function recordIngest(ev: CommonEvent, toolName: string, sourceKind: SourceKind, sourceId: string, text: string, d: RecorderDeps): void {
  const tier = classify(sourceKind, sourceId, ev.projectRoot, d.trust, d.home);
  if (tier === "T1") {
    d.store.insertEvent(
      newEvent(ev, { kind: "ingest", toolName, sourceKind, sourceId, provisionalTier: tier, indicators: [...extractIndicators(text)].sort() }),
    );
    return;
  }
  const blob = d.store.putBlob(text, d.ingestCapBytes);
  d.store.insertEvent(
    newEvent(ev, {
      kind: "ingest",
      toolName,
      sourceKind,
      sourceId,
      provisionalTier: tier,
      blobSha: blob.sha,
      detail: blob.truncated ? { originalSha: blob.originalSha } : null,
    }),
  );
}

function recordFileWrite(ev: CommonEvent, path: string, toolName: string, ctx: SurfaceContext, d: RecorderDeps): void {
  const prev = d.store.getSurface(path);
  const scope = classifySurfacePath(path, ctx) ?? (prev ? (prev.scope as SurfaceScope) : null);
  if (!scope) return;
  const cur = readSurface(path, SNAPSHOT_CAP);
  const newSha = cur?.sha ?? null;
  if (prev && prev.lastSha === newSha) return;
  if (cur) d.store.putBlob(cur.text, NO_CAP);
  const prevSha = prev?.lastSha ?? null;
  d.store.insertEvent(
    newEvent(ev, { kind: "write", toolName, surfacePath: path, blobSha: newSha, prevBlobSha: prevSha, detail: { change: changeType(prevSha, newSha) } }),
  );
  d.store.upsertSurface({ path, scope, projectRoot: scopeRoot(scope, ev.projectRoot), lastSha: newSha, lastSeenAt: ev.ts });
  if (cur) trackImports(path, cur.text, ev, d);
}

function scanAndRecord(
  targets: SurfaceTarget[],
  ev: CommonEvent,
  d: RecorderDeps,
  context: "between_sessions" | "in_session",
  command: string | null,
): void {
  const known = d.store.listSurfaces();
  const memoryDir = ev.memoryDir;
  const projectBaselined = known.some((r) => r.projectRoot === ev.projectRoot);
  const userBaselined = known.some((r) => r.scope === "user" || r.scope === "managed");
  const memoryBaselined = memoryDir !== null && known.some((r) => r.scope === "memory" && isInside(r.path, memoryDir));
  const baselinedFor = (scope: SurfaceScope): boolean =>
    scope === "user" || scope === "managed" ? userBaselined : scope === "memory" ? memoryBaselined : projectBaselined;
  for (const t of targets) {
    const cur = readSurface(t.path, SNAPSHOT_CAP);
    const newSha = cur?.sha ?? null;
    const prev = d.store.getSurface(t.path);
    if (!prev) {
      if (!cur && !t.trackAbsent) continue;
      if (cur) d.store.putBlob(cur.text, NO_CAP);
      // Record the event before persisting the row: if the insert throws, the next scan sees the file as new again.
      if (cur && !(context === "between_sessions" && !baselinedFor(t.scope))) {
        d.store.insertEvent(
          newEvent(ev, { kind: "scan_change", surfacePath: t.path, blobSha: newSha, prevBlobSha: null, detail: { context, change: "created", command } }),
        );
      }
      d.store.upsertSurface({ path: t.path, scope: t.scope, projectRoot: scopeRoot(t.scope, ev.projectRoot), lastSha: newSha, lastSeenAt: ev.ts });
      continue;
    }
    if (prev.lastSha === newSha) continue;
    if (cur) d.store.putBlob(cur.text, NO_CAP);
    d.store.insertEvent(
      newEvent(ev, {
        kind: "scan_change",
        surfacePath: t.path,
        blobSha: newSha,
        prevBlobSha: prev.lastSha,
        detail: { context, change: changeType(prev.lastSha, newSha), command },
      }),
    );
    d.store.upsertSurface({ ...prev, lastSha: newSha, lastSeenAt: ev.ts });
  }
}

function trackImports(fromPath: string, text: string, ev: CommonEvent, d: RecorderDeps): void {
  for (const imp of parseImports(text, fromPath, d.home)) {
    if (d.store.getSurface(imp)) continue;
    const cur = readSurface(imp, SNAPSHOT_CAP);
    if (!cur) continue;
    d.store.putBlob(cur.text, NO_CAP);
    // Only called for in-session writes: a newly imported file is recorded before its row, like scanAndRecord.
    d.store.insertEvent(
      newEvent(ev, { kind: "scan_change", surfacePath: imp, blobSha: cur.sha, prevBlobSha: null, detail: { context: "in_session", change: "created", command: null } }),
    );
    d.store.upsertSurface({ path: imp, scope: "import", projectRoot: ev.projectRoot, lastSha: cur.sha, lastSeenAt: ev.ts });
  }
}

// Used by `lineage init` to baseline user-level surfaces before any session runs. Silent: no events.
export function baseline(targets: SurfaceTarget[], store: Store, ts: string): number {
  let n = 0;
  for (const t of targets) {
    if (store.getSurface(t.path)) continue;
    const cur = readSurface(t.path, SNAPSHOT_CAP);
    if (!cur && !t.trackAbsent) continue;
    if (cur) store.putBlob(cur.text, NO_CAP);
    store.upsertSurface({ path: t.path, scope: t.scope, projectRoot: null, lastSha: cur?.sha ?? null, lastSeenAt: ts });
    n += 1;
  }
  return n;
}
