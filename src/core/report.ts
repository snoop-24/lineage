import { basename, dirname } from "node:path";
import type { SourceKind, Tier } from "./events.ts";
import type { Store } from "./store.ts";
import { attributeChanges, LABEL_ORDER, UNKNOWN_ROOT, type AttributedChange, type Label } from "./attribution.ts";
import { classify, isUntrusted, proposalKey, proposeTrust, type ProposalItem, type TrustConfig } from "./trust.ts";
import { safe } from "./sanitize.ts";

export const LABEL_TITLES: Record<Label, string> = {
  MATCHED: "MATCHED",
  UNATTRIBUTED_IN_SESSION: "UNATTRIBUTED (in session)",
  EXPOSED: "EXPOSED",
  UNATTRIBUTED_BETWEEN: "UNATTRIBUTED (between sessions)",
  CLEAN: "CLEAN",
};

export interface ReportHealth {
  hooksInstalled: boolean;
  tamperEvents: number;
  chainOk: boolean;
  errorLines: number;
}

export interface ClassifiedIngest {
  sourceKind: SourceKind;
  sourceId: string;
  sessionId: string | null;
  tier: Tier;
}

export interface ReportData {
  generatedAt: string;
  sinceIso: string;
  projectRoot: string | null;
  home: string;
  sessions: number;
  projects: number;
  exposure: {
    total: number;
    untrusted: number;
    untrustedByKind: Record<string, number>;
    topSources: Array<{ source: string; reads: number }>;
  };
  changes: AttributedChange[];
  settingsChanges: AttributedChange[];
  appSkillUpdates: AttributedChange[];
  counts: Record<Label, number>;
  proposal: ProposalItem[];
  health: ReportHealth;
}

export interface BuildOptions {
  sinceIso: string;
  projectRoot: string | null;
  home: string;
  health: ReportHealth;
  now: Date;
}

export function tilde(path: string, home: string): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

// .claude/settings.json and .claude/settings.local.json (project or ~/.claude) are configuration, not memory.
export function isSettingsPath(path: string): boolean {
  return (basename(path) === "settings.json" || basename(path) === "settings.local.json") && basename(dirname(path)) === ".claude";
}

// A settings change matters for lineage when it touches hooks or removes lineage's deny rule.
export function settingsChangeFlagged(c: AttributedChange): boolean {
  const touchesHooks = (l: string): boolean => l.includes('"hooks"') || l.includes('"disableAllHooks"');
  return c.addedLines.some(touchesHooks) || c.removedLines.some((l) => touchesHooks(l) || l.includes("Edit("));
}

// The Claude app rewrites its own skills in ~/.claude/skills/synced/ between sessions. A change there with any
// session behind it keeps its normal label and stays in the full list.
export function isAppSkillUpdate(c: AttributedChange, home: string): boolean {
  const path = c.event.surfacePath ?? "";
  return c.label === "UNATTRIBUTED_BETWEEN" && basename(path) === "SKILL.md" && path.startsWith(`${home}/.claude/skills/synced/`);
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const when = (iso: string): string => `${iso.slice(0, 16).replace("T", " ")} UTC`;

export function classifiedIngests(
  store: Store,
  trust: TrustConfig,
  o: { sinceIso: string; projectRoot: string | null; home: string },
): ClassifiedIngest[] {
  const roots = new Map<string, string | null>();
  const rootOf = (id: string): string | null => {
    if (!roots.has(id)) roots.set(id, store.getSession(id)?.projectRoot ?? null);
    return roots.get(id) ?? null;
  };
  const out: ClassifiedIngest[] = [];
  for (const e of store.listEvents({ sinceIso: o.sinceIso, kind: "ingest" })) {
    if (!e.sessionId || !e.sourceKind || !e.sourceId) continue;
    const root = rootOf(e.sessionId);
    if (o.projectRoot && root !== o.projectRoot) continue;
    out.push({ sourceKind: e.sourceKind, sourceId: e.sourceId, sessionId: e.sessionId, tier: classify(e.sourceKind, e.sourceId, root ?? UNKNOWN_ROOT, trust, o.home) });
  }
  return out;
}

export function buildReport(store: Store, trust: TrustConfig, o: BuildOptions): ReportData {
  const sessions = store.listSessions(o.sinceIso).filter((s) => !o.projectRoot || s.projectRoot === o.projectRoot);
  const ingests = classifiedIngests(store, trust, o);
  const untrusted = ingests.filter((i) => isUntrusted(i.tier));
  const untrustedByKind: Record<string, number> = {};
  const top = new Map<string, number>();
  for (const u of untrusted) {
    untrustedByKind[u.sourceKind] = (untrustedByKind[u.sourceKind] ?? 0) + 1;
    const key = proposalKey(u.sourceKind, u.sourceId);
    const label = key ? (key.type === "mcp_server" ? `mcp:${key.match}` : key.match) : u.sourceKind;
    top.set(label, (top.get(label) ?? 0) + 1);
  }
  const attributed = attributeChanges(store, trust, { sinceIso: o.sinceIso, projectRoot: o.projectRoot, home: o.home });
  const appSkillUpdates = attributed.filter((c) => isAppSkillUpdate(c, o.home));
  const changes = attributed.filter((c) => !isSettingsPath(c.event.surfacePath ?? "") && !isAppSkillUpdate(c, o.home));
  const settingsChanges = attributed.filter((c) => isSettingsPath(c.event.surfacePath ?? "")).sort((a, b) => a.event.id - b.event.id);
  const counts = Object.fromEntries(LABEL_ORDER.map((l) => [l, 0])) as Record<Label, number>;
  for (const c of changes) counts[c.label] += 1;
  return {
    generatedAt: o.now.toISOString(),
    sinceIso: o.sinceIso,
    projectRoot: o.projectRoot,
    home: o.home,
    sessions: sessions.length,
    projects: new Set(sessions.map((s) => s.projectRoot)).size,
    exposure: {
      total: ingests.length,
      untrusted: untrusted.length,
      untrustedByKind,
      topSources: [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([source, reads]) => ({ source, reads })),
    },
    changes,
    settingsChanges,
    appSkillUpdates,
    counts,
    proposal: proposeTrust(ingests),
    health: o.health,
  };
}

function sessionLine(e: AttributedChange["event"]): string {
  const via = e.kind === "write" ? `via ${safe(e.toolName ?? "tool")}` : `detected by scan (${safe(String(e.detail?.change ?? "changed"))})`;
  return `    session ${safe(e.sessionId ?? "?")} · ${when(e.ts)} · ${via}`;
}

function diffLines(c: AttributedChange): string[] {
  const L: string[] = [];
  for (const line of c.addedLines.slice(0, 5)) L.push(`    + ${safe(clip(line, 160))}`);
  if (c.addedLines.length > 5) L.push(`    + … ${c.addedLines.length - 5} more line(s)`);
  for (const line of c.removedLines.slice(0, 5)) L.push(`    - ${safe(clip(line, 160))}`);
  if (c.removedLines.length > 5) L.push(`    - … ${c.removedLines.length - 5} more line(s)`);
  return L;
}

function renderChange(c: AttributedChange, home: string): string[] {
  const e = c.event;
  const L: string[] = [`  [${LABEL_TITLES[c.label]}] ${safe(tilde(e.surfacePath ?? "?", home))}`];
  L.push(sessionLine(e));
  const cmd = e.detail?.command;
  if (typeof cmd === "string" && cmd.length > 0) L.push(`    command: ${safe(clip(cmd, 120))}`);
  L.push(...diffLines(c));
  for (const m of c.matches.slice(0, 5)) {
    const what = m.kind === "words" ? `shared text "${safe(clip(m.evidence, 80))}"` : `indicator ${safe(m.evidence)}`;
    L.push(`    evidence: ${what} in ${m.sourceKind} ${safe(clip(m.sourceId, 100))} (${m.secondsBefore}s earlier)`);
  }
  if (c.matches.length === 0 && c.untrustedSources.length > 0) {
    L.push(`    untrusted content earlier in session: ${c.untrustedSources.slice(0, 3).map((s) => `${s.sourceKind} ${safe(clip(s.sourceId, 80))}`).join("; ")}`);
  }
  if (c.evidencePruned) L.push("    note: some untrusted content from this session has expired (30-day retention); the label may understate the match");
  if (c.blastRadius) {
    const n = c.blastRadius.sessions.length;
    const list = n > 0 ? ` (${c.blastRadius.sessions.slice(0, 5).join(", ")})` : "";
    L.push(`    blast radius: ${c.blastRadius.estimated ? "up to " : ""}${n} later session(s)${safe(list)}${c.blastRadius.estimated ? " (estimated: no load events recorded for this file)" : ""}`);
  }
  return L;
}

function appSkillSummary(updates: AttributedChange[]): string {
  const counts = new Map<string, number>();
  for (const c of updates) {
    const name = basename(dirname(c.event.surfacePath ?? ""));
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, n]) => safe(n > 1 ? `${name} (${n})` : name)).join(", ");
}

export function renderText(r: ReportData): string {
  const L: string[] = [];
  const scope = r.projectRoot ? ` (project ${safe(tilde(r.projectRoot, r.home))})` : "";
  L.push(`Provenance report: since ${when(r.sinceIso)}, ${r.sessions} session(s) in ${r.projects} project(s)${scope}`);
  const warnings: string[] = [];
  if (!r.health.hooksInstalled) warnings.push("lineage hooks are not installed in Claude Code settings. Run: lineage init");
  if (r.health.tamperEvents > 0) warnings.push(`${r.health.tamperEvents} tamper event(s): lineage hooks were removed or changed. Run: lineage status`);
  if (!r.health.chainOk) warnings.push("The event log hash chain is broken: the log was edited outside lineage. Run: lineage status");
  if (r.health.errorLines > 0) warnings.push(`${r.health.errorLines} hook error(s) logged. Run: lineage status`);
  if (warnings.length > 0) {
    L.push("", "HEALTH WARNINGS");
    for (const w of warnings) L.push(`  ! ${w}`);
  }
  L.push("", "EXPOSURE", `  Ingestions: ${r.exposure.total} total, ${r.exposure.untrusted} untrusted`);
  const kinds = Object.entries(r.exposure.untrustedByKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ");
  if (kinds) L.push(`  Untrusted by kind: ${kinds}`);
  if (r.exposure.topSources.length > 0) L.push(`  Top untrusted sources: ${r.exposure.topSources.map((s) => `${safe(s.source)} (${s.reads})`).join(", ")}`);
  L.push("", `MEMORY CHANGES: ${r.changes.length} total. ${LABEL_ORDER.map((l) => `${LABEL_TITLES[l]} ${r.counts[l]}`).join(", ")}`);
  for (const c of r.changes) {
    if (c.label !== "CLEAN") L.push("", ...renderChange(c, r.home));
  }
  if (r.appSkillUpdates.length > 0) {
    L.push("", `  Claude app updated ${r.appSkillUpdates.length} skill file(s) between sessions: ${appSkillSummary(r.appSkillUpdates)}`);
  }
  if (r.settingsChanges.length > 0) {
    const flagged = r.settingsChanges.filter(settingsChangeFlagged).length;
    L.push("", `SETTINGS CHANGES: ${r.settingsChanges.length} total, ${flagged} touching hooks or lineage's deny rule (marked !)`);
    for (const c of r.settingsChanges) {
      L.push("", `  ${settingsChangeFlagged(c) ? "! " : "  "}${safe(tilde(c.event.surfacePath ?? "?", r.home))}`, sessionLine(c.event), ...diffLines(c));
    }
  }
  L.push("", "PROPOSED TRUST RANKING");
  if (r.proposal.length === 0) {
    L.push("  No proposals yet (a source needs 3+ reads across 2+ sessions).");
  } else {
    const items = r.proposal.map((p) => `${safe(p.type === "mcp_server" ? `mcp:${p.match}` : p.match)} (${p.reads} reads, ${p.sessions} sessions)`);
    L.push(`  Promote to trusted? ${items.join("; ")}`, "  Run: lineage trust accept");
  }
  return `${L.join("\n")}\n`;
}

export function renderMarkdown(r: ReportData): string {
  const text = renderText(r);
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `# Provenance report\n\n${fence}text\n${text}${fence}\n`;
}

export function reportJson(r: ReportData): string {
  return `${JSON.stringify(
    {
      ...r,
      settingsChanges: r.settingsChanges.map((c) => ({
        surfacePath: c.event.surfacePath,
        sessionId: c.event.sessionId,
        ts: c.event.ts,
        kind: c.event.kind,
        tool: c.event.toolName,
        flagged: settingsChangeFlagged(c),
        addedLines: c.addedLines,
        removedLines: c.removedLines,
      })),
      appSkillUpdates: r.appSkillUpdates.map((c) => ({
        surfacePath: c.event.surfacePath,
        sessionId: c.event.sessionId,
        ts: c.event.ts,
        addedLines: c.addedLines,
        removedLines: c.removedLines,
      })),
      changes: r.changes.map((c) => ({
        label: c.label,
        surfacePath: c.event.surfacePath,
        sessionId: c.event.sessionId,
        ts: c.event.ts,
        kind: c.event.kind,
        tool: c.event.toolName,
        addedLines: c.addedLines,
        removedLines: c.removedLines,
        matches: c.matches,
        untrustedSources: c.untrustedSources,
        evidencePruned: c.evidencePruned,
        blastRadius: c.blastRadius,
      })),
    },
    null,
    2,
  )}\n`;
}
