// Report-time attribution: label each memory change by what preceded it in the same session.
import type { SourceKind, Tier } from "./events.ts";
import type { EventRow, Store } from "./store.ts";
import { classify, isUntrusted, type TrustConfig } from "./trust.ts";
import { extractIndicators, firstSharedShingle, normalizeWords, shingles } from "./indicators.ts";

export type Label = "MATCHED" | "UNATTRIBUTED_IN_SESSION" | "EXPOSED" | "UNATTRIBUTED_BETWEEN" | "CLEAN";

export const LABEL_ORDER: Label[] = ["MATCHED", "UNATTRIBUTED_IN_SESSION", "EXPOSED", "UNATTRIBUTED_BETWEEN", "CLEAN"];

export interface SourceRef {
  eventId: number;
  sourceKind: SourceKind;
  sourceId: string;
  ts: string;
  secondsBefore: number;
}

export interface Match extends SourceRef {
  kind: "words" | "indicator";
  evidence: string;
}

export interface BlastRadius {
  sessions: string[];
  estimated: boolean;
}

export interface AttributedChange {
  event: EventRow;
  label: Label;
  addedLines: string[];
  removedLines: string[];
  matches: Match[];
  untrustedSources: SourceRef[];
  evidencePruned: boolean;
  blastRadius: BlastRadius | null;
}

export interface AttributionOptions {
  sinceIso: string;
  projectRoot: string | null;
  home: string;
}

interface CachedIngest {
  text: string | null;
  indicators: Set<string>;
  shingles: Set<string> | null;
}

interface Cache {
  sessionEvents: Map<string, EventRow[]>;
  blobText: Map<string, string | null>;
  ingestInfo: Map<number, CachedIngest>;
  loadsFor: Map<string, EventRow[]>;
}

const UNKNOWN_ROOT = "/\u0000pvg-unknown-root";

function multisetDiff(from: string[], against: string[]): string[] {
  const budget = new Map<string, number>();
  for (const l of against) budget.set(l, (budget.get(l) ?? 0) + 1);
  const out: string[] = [];
  for (const l of from) {
    if (l.trim() === "") continue;
    const left = budget.get(l) ?? 0;
    if (left > 0) budget.set(l, left - 1);
    else out.push(l);
  }
  return out;
}

export function lineDiff(prev: string | null, next: string | null): { added: string[]; removed: string[] } {
  const prevLines = (prev ?? "").split("\n");
  const nextLines = (next ?? "").split("\n");
  return { added: multisetDiff(nextLines, prevLines), removed: multisetDiff(prevLines, nextLines) };
}

function createCache(): Cache {
  return {
    sessionEvents: new Map(),
    blobText: new Map(),
    ingestInfo: new Map(),
    loadsFor: new Map(),
  };
}

function getSessionEvents(cache: Cache, store: Store, sessionId: string): EventRow[] {
  if (!cache.sessionEvents.has(sessionId)) {
    cache.sessionEvents.set(sessionId, store.listEvents({ sessionId }));
  }
  return cache.sessionEvents.get(sessionId)!;
}

function getBlobText(cache: Cache, store: Store, sha: string): string | null {
  if (!cache.blobText.has(sha)) {
    cache.blobText.set(sha, store.getBlobText(sha));
  }
  return cache.blobText.get(sha)!;
}

function getLoadsFor(cache: Cache, store: Store, path: string): EventRow[] {
  if (!cache.loadsFor.has(path)) {
    cache.loadsFor.set(path, store.listEvents({ kind: "load", surfacePath: path }));
  }
  return cache.loadsFor.get(path)!;
}

function getFlaggedLines(addedLines: string[], matches: Match[]): string[] {
  if (matches.length > 0) {
    const flagged = new Set<string>();
    for (const line of addedLines) {
      for (const match of matches) {
        if (match.kind === "indicator") {
          if (extractIndicators(line).has(match.evidence)) {
            flagged.add(line);
            break;
          }
        } else if (match.kind === "words") {
          if (normalizeWords(line).join(" ").includes(match.evidence)) {
            flagged.add(line);
            break;
          }
        }
      }
    }
    if (flagged.size > 0) return [...flagged];
  }
  // Fallback: lines with at least 8 non-whitespace characters
  return addedLines.filter((l) => l.replace(/\s/g, "").length >= 8);
}

export function attributeChanges(store: Store, trust: TrustConfig, opts: AttributionOptions): AttributedChange[] {
  const cache = createCache();
  const changes = [
    ...store.listEvents({ sinceIso: opts.sinceIso, kind: "write" }),
    ...store.listEvents({ sinceIso: opts.sinceIso, kind: "scan_change" }),
  ].sort((a, b) => a.id - b.id);
  const out: AttributedChange[] = [];
  for (const ev of changes) {
    const root = ev.sessionId ? (store.getSession(ev.sessionId)?.projectRoot ?? null) : null;
    if (opts.projectRoot && root !== opts.projectRoot) continue;
    out.push(attributeOne(store, trust, ev, root ?? UNKNOWN_ROOT, opts.home, cache));
  }
  return out.sort((a, b) => LABEL_ORDER.indexOf(a.label) - LABEL_ORDER.indexOf(b.label) || a.event.id - b.event.id);
}

function attributeOne(
  store: Store,
  trust: TrustConfig,
  ev: EventRow,
  root: string,
  home: string,
  cache: Cache,
): AttributedChange {
  const prevText = ev.prevBlobSha ? getBlobText(cache, store, ev.prevBlobSha) : null;
  const newText = ev.blobSha ? getBlobText(cache, store, ev.blobSha) : null;
  const { added, removed } = lineDiff(prevText, newText);
  const context = ev.kind === "scan_change" ? String(ev.detail?.context ?? "") : "tool";
  if (context === "between_sessions") {
    return {
      event: ev,
      label: "UNATTRIBUTED_BETWEEN",
      addedLines: added,
      removedLines: removed,
      matches: [],
      untrustedSources: [],
      evidencePruned: false,
      blastRadius: null,
    };
  }

  const prior = ev.sessionId ? getSessionEvents(cache, store, ev.sessionId).filter((e) => e.id < ev.id) : [];
  const trustedIndicators = new Set<string>(extractIndicators(prevText ?? ""));
  const untrusted: Array<{ ref: SourceRef; text: string | null; indicators: Set<string> }> = [];
  const changeMs = Date.parse(ev.ts);
  let evidencePruned = false;

  for (const p of prior) {
    if (p.kind === "prompt") {
      const text = p.blobSha ? getBlobText(cache, store, p.blobSha) : null;
      for (const i of extractIndicators(text ?? "")) trustedIndicators.add(i);
      continue;
    }
    if (p.kind !== "ingest" || !p.sourceKind || !p.sourceId) continue;
    const tier: Tier = classify(p.sourceKind, p.sourceId, root, trust, home);
    let ingestInfo = cache.ingestInfo.get(p.id);
    if (!ingestInfo) {
      const text = p.blobSha ? getBlobText(cache, store, p.blobSha) : null;
      const indicators = text !== null ? extractIndicators(text) : new Set(p.indicators ?? []);
      ingestInfo = { text, indicators, shingles: null };
      cache.ingestInfo.set(p.id, ingestInfo);
    }
    if (!isUntrusted(tier)) {
      for (const i of ingestInfo.indicators) trustedIndicators.add(i);
      continue;
    }
    // Check if blob was pruned
    if (p.blobSha !== null && ingestInfo.text === null) {
      evidencePruned = true;
    }
    const secondsBefore = Math.max(0, Math.round((changeMs - Date.parse(p.ts)) / 1000));
    untrusted.push({
      ref: { eventId: p.id, sourceKind: p.sourceKind, sourceId: p.sourceId, ts: p.ts, secondsBefore },
      text: ingestInfo.text,
      indicators: ingestInfo.indicators,
    });
  }

  const addedText = added.join("\n");
  const addedShingles = shingles(normalizeWords(addedText));
  const addedIndicators = extractIndicators(addedText);
  const matches: Match[] = [];
  for (const u of untrusted) {
    if (u.text !== null && addedShingles.size > 0) {
      const shared = firstSharedShingle(addedShingles, shingles(normalizeWords(u.text)));
      if (shared) matches.push({ ...u.ref, kind: "words", evidence: shared });
    }
    for (const i of addedIndicators) {
      if (u.indicators.has(i) && !trustedIndicators.has(i)) matches.push({ ...u.ref, kind: "indicator", evidence: i });
    }
  }

  const label: Label =
    matches.length > 0 ? "MATCHED" : context === "in_session" ? "UNATTRIBUTED_IN_SESSION" : untrusted.length > 0 ? "EXPOSED" : "CLEAN";

  const flagged = getFlaggedLines(added, matches);
  return {
    event: ev,
    label,
    addedLines: added,
    removedLines: removed,
    matches,
    untrustedSources: untrusted.map((u) => u.ref),
    evidencePruned,
    blastRadius: label === "CLEAN" ? null : blastRadius(store, cache, ev, root, flagged),
  };
}

function blastRadius(store: Store, cache: Cache, ev: EventRow, root: string, flagged: string[]): BlastRadius {
  if (!ev.surfacePath) return { sessions: [], estimated: false };
  const lines = flagged.map((l) => l.trim()).filter((l) => l.length > 0);
  const loads = getLoadsFor(cache, store, ev.surfacePath);
  // Filter to loads AFTER the change
  const laterLoads = loads.filter((l) => l.id > ev.id && l.sessionId && l.sessionId !== ev.sessionId);
  if (laterLoads.length > 0) {
    const sessions = new Set<string>();
    for (const l of laterLoads) {
      const text = l.blobSha ? getBlobText(cache, store, l.blobSha) : null;
      if (text !== null && lines.some((x) => text.includes(x))) {
        sessions.add(l.sessionId!);
      }
    }
    return { sessions: [...sessions].sort(), estimated: false };
  }
  const later = store.listSessions(ev.ts).filter((s) => s.projectRoot === root && s.id !== ev.sessionId && s.startedAt > ev.ts);
  return { sessions: later.map((s) => s.id).sort(), estimated: true };
}
