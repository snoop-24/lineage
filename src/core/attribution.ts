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
  blastRadius: BlastRadius | null;
}

export interface AttributionOptions {
  sinceIso: string;
  projectRoot: string | null;
  home: string;
}

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

export function attributeChanges(store: Store, trust: TrustConfig, opts: AttributionOptions): AttributedChange[] {
  const changes = [
    ...store.listEvents({ sinceIso: opts.sinceIso, kind: "write" }),
    ...store.listEvents({ sinceIso: opts.sinceIso, kind: "scan_change" }),
  ].sort((a, b) => a.id - b.id);
  const out: AttributedChange[] = [];
  for (const ev of changes) {
    const root = ev.sessionId ? (store.getSession(ev.sessionId)?.projectRoot ?? null) : null;
    if (opts.projectRoot && root !== opts.projectRoot) continue;
    out.push(attributeOne(store, trust, ev, root ?? "", opts.home));
  }
  return out.sort((a, b) => LABEL_ORDER.indexOf(a.label) - LABEL_ORDER.indexOf(b.label) || a.event.id - b.event.id);
}

function attributeOne(store: Store, trust: TrustConfig, ev: EventRow, root: string, home: string): AttributedChange {
  const prevText = ev.prevBlobSha ? store.getBlobText(ev.prevBlobSha) : null;
  const newText = ev.blobSha ? store.getBlobText(ev.blobSha) : null;
  const { added, removed } = lineDiff(prevText, newText);
  const context = ev.kind === "scan_change" ? String(ev.detail?.context ?? "") : "tool";
  if (context === "between_sessions") {
    return { event: ev, label: "UNATTRIBUTED_BETWEEN", addedLines: added, removedLines: removed, matches: [], untrustedSources: [], blastRadius: null };
  }

  const prior = ev.sessionId ? store.listEvents({ sessionId: ev.sessionId }).filter((e) => e.id < ev.id) : [];
  const trustedIndicators = new Set<string>(extractIndicators(prevText ?? ""));
  const untrusted: Array<{ ref: SourceRef; text: string | null; indicators: Set<string> }> = [];
  const changeMs = Date.parse(ev.ts);

  for (const p of prior) {
    if (p.kind === "prompt") {
      const text = p.blobSha ? store.getBlobText(p.blobSha) : null;
      for (const i of extractIndicators(text ?? "")) trustedIndicators.add(i);
      continue;
    }
    if (p.kind !== "ingest" || !p.sourceKind || !p.sourceId) continue;
    const tier: Tier = classify(p.sourceKind, p.sourceId, root, trust, home);
    const text = p.blobSha ? store.getBlobText(p.blobSha) : null;
    const indicators = text !== null ? extractIndicators(text) : new Set(p.indicators ?? []);
    if (!isUntrusted(tier)) {
      for (const i of indicators) trustedIndicators.add(i);
      continue;
    }
    const secondsBefore = Math.max(0, Math.round((changeMs - Date.parse(p.ts)) / 1000));
    untrusted.push({ ref: { eventId: p.id, sourceKind: p.sourceKind, sourceId: p.sourceId, ts: p.ts, secondsBefore }, text, indicators });
  }

  const addedText = added.join("\n");
  const addedShingles = shingles(normalizeWords(addedText));
  const addedIndicators = extractIndicators(addedText);
  const matches: Match[] = [];
  for (const u of untrusted) {
    if (u.text !== null) {
      const shared = firstSharedShingle(addedShingles, shingles(normalizeWords(u.text)));
      if (shared) matches.push({ ...u.ref, kind: "words", evidence: shared });
    }
    for (const i of addedIndicators) {
      if (u.indicators.has(i) && !trustedIndicators.has(i)) matches.push({ ...u.ref, kind: "indicator", evidence: i });
    }
  }

  const label: Label =
    matches.length > 0 ? "MATCHED" : context === "in_session" ? "UNATTRIBUTED_IN_SESSION" : untrusted.length > 0 ? "EXPOSED" : "CLEAN";
  return {
    event: ev,
    label,
    addedLines: added,
    removedLines: removed,
    matches,
    untrustedSources: untrusted.map((u) => u.ref),
    blastRadius: label === "CLEAN" ? null : blastRadius(store, ev, root, added),
  };
}

function blastRadius(store: Store, ev: EventRow, root: string, added: string[]): BlastRadius {
  if (!ev.surfacePath) return { sessions: [], estimated: false };
  const lines = added.map((l) => l.trim()).filter((l) => l.length > 0);
  const loads = store.listEvents({ kind: "load", surfacePath: ev.surfacePath });
  if (loads.length > 0) {
    const sessions = new Set<string>();
    for (const l of loads) {
      if (l.id <= ev.id || !l.sessionId || l.sessionId === ev.sessionId) continue;
      const text = l.blobSha ? store.getBlobText(l.blobSha) : null;
      if (text !== null && lines.some((x) => text.includes(x))) sessions.add(l.sessionId);
    }
    return { sessions: [...sessions].sort(), estimated: false };
  }
  const later = store.listSessions(ev.ts).filter((s) => s.projectRoot === root && s.id !== ev.sessionId && s.startedAt > ev.ts);
  return { sessions: later.map((s) => s.id).sort(), estimated: true };
}
