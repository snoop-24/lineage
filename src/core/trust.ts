import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { SourceKind, Tier } from "./events.ts";
import { globToRegExp } from "./glob.ts";

export const TIER_NAMES: Record<Tier, string> = {
  T0: "user",
  T1: "workspace",
  T2: "trusted-external",
  T3: "dependency",
  T4: "external",
};

export type RuleTier = "T2" | "T3" | "T4";
export type RuleType = "domain" | "mcp_server" | "path";

export interface TrustRule {
  type: RuleType;
  match: string;
  tier: RuleTier;
}

export interface TrustConfig {
  rules: TrustRule[];
}

const RULE_TYPES = new Set<string>(["domain", "mcp_server", "path"]);
const RULE_TIERS = new Set<string>(["T2", "T3", "T4"]);
const DEP_DIRS = new Set(["node_modules", "vendor", ".venv", "venv", "site-packages"]);
const TIER_RANK: Record<Tier, number> = { T0: 0, T1: 1, T2: 2, T3: 3, T4: 4 };

export const isUntrusted = (t: Tier): boolean => t === "T3" || t === "T4";

export function loadTrust(path: string): TrustConfig {
  if (!existsSync(path)) return { rules: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { rules?: unknown };
    if (raw === null || typeof raw !== "object") return { rules: [] };
    const rules: TrustRule[] = [];
    if (Array.isArray(raw.rules)) {
      for (const r of raw.rules) {
        if (!r || typeof r !== "object") continue;
        const { type, match, tier } = r as Record<string, unknown>;
        if (typeof type === "string" && typeof match === "string" && typeof tier === "string" && match.length > 0 &&
            RULE_TYPES.has(type) && RULE_TIERS.has(tier)) {
          rules.push({ type: type as RuleType, match, tier: tier as RuleTier });
        }
      }
    }
    return { rules };
  } catch {
    return { rules: [] };
  }
}

export function saveTrust(path: string, cfg: TrustConfig): void {
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
}

export function sourceHost(sourceId: string): string | null {
  try {
    const u = new URL(sourceId);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function mcpServer(sourceId: string): string | null {
  if (!sourceId.startsWith("mcp:")) return null;
  const server = sourceId.slice(4).split("/")[0];
  return server ? server : null;
}

const AGENT_FILE_BASENAMES = new Set(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "SKILL.md"]);

// The agent's own memory/instruction files: their writes are attributed when they happen, so reading them is trusted.
function isAgentMemoryFile(path: string): boolean {
  return (
    AGENT_FILE_BASENAMES.has(basename(path)) ||
    path.includes("/.claude/rules/") ||
    path.includes("/.claude/skills/") ||
    /\/\.claude\/projects\/[^/]+\/memory\//.test(path)
  ); // ~/.claude/CLAUDE.md is covered by the basename check.
}

export function defaultTier(kind: SourceKind | "prompt", sourceId: string, projectRoot: string): Tier {
  if (kind === "prompt") return "T0";
  if (kind === "file") {
    if (isAgentMemoryFile(sourceId)) return "T1";
    const rel = relative(projectRoot, sourceId);
    const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    if (!inside) return "T4";
    return rel.split("/").some((seg) => DEP_DIRS.has(seg)) ? "T3" : "T1";
  }
  return "T4";
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  return p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

function ruleMatches(rule: TrustRule, kind: SourceKind | "prompt", sourceId: string, home: string): boolean {
  if (rule.type === "domain") {
    if (kind !== "web" && kind !== "network") return false;
    const host = sourceHost(sourceId);
    const m = rule.match.toLowerCase();
    return host !== null && (host === m || host.endsWith(`.${m}`));
  }
  if (rule.type === "mcp_server") return kind === "mcp" && mcpServer(sourceId) === rule.match;
  return kind === "file" && globToRegExp(expandHome(rule.match, home)).test(sourceId);
}

function maxTier(tiers: Tier[]): Tier {
  return tiers.reduce((a, b) => (TIER_RANK[b] > TIER_RANK[a] ? b : a));
}

export function classify(kind: SourceKind | "prompt", sourceId: string, projectRoot: string, cfg: TrustConfig, home: string): Tier {
  const base = defaultTier(kind, sourceId, projectRoot);
  if (base === "T0") return base;
  const matches: Tier[] = cfg.rules.filter((r) => ruleMatches(r, kind, sourceId, home)).map((r) => r.tier);
  if (matches.length === 0) return base;
  if (base === "T1") {
    const demotions = matches.filter((t) => t !== "T2");
    return demotions.length > 0 ? maxTier(demotions) : base;
  }
  return maxTier(matches);
}

export interface ProposalInput {
  sourceKind: SourceKind;
  sourceId: string;
  sessionId: string | null;
  tier: Tier;
}

export interface ProposalItem {
  type: RuleType;
  match: string;
  reads: number;
  sessions: number;
}

export interface ProposalOptions {
  minReads: number;
  minSessions: number;
  max: number;
}

export const DEFAULT_PROPOSAL: ProposalOptions = { minReads: 3, minSessions: 2, max: 5 };

export function proposalKey(kind: SourceKind, sourceId: string): { type: RuleType; match: string } | null {
  if (kind === "web" || kind === "network") {
    const host = sourceHost(sourceId);
    return host ? { type: "domain", match: host } : null;
  }
  if (kind === "mcp") {
    const s = mcpServer(sourceId);
    return s ? { type: "mcp_server", match: s } : null;
  }
  if (kind === "file") return { type: "path", match: `${dirname(sourceId)}/**` };
  return null;
}

export function proposeTrust(inputs: ProposalInput[], opts: ProposalOptions = DEFAULT_PROPOSAL): ProposalItem[] {
  const groups = new Map<string, { type: RuleType; match: string; reads: number; sessions: Set<string> }>();
  for (const i of inputs) {
    if (i.tier !== "T4") continue;
    const key = proposalKey(i.sourceKind, i.sourceId);
    if (!key) continue;
    const k = `${key.type}:${key.match}`;
    const g = groups.get(k) ?? { type: key.type, match: key.match, reads: 0, sessions: new Set<string>() };
    g.reads += 1;
    if (i.sessionId) g.sessions.add(i.sessionId);
    groups.set(k, g);
  }
  return [...groups.values()]
    .filter((g) => g.reads >= opts.minReads && g.sessions.size >= opts.minSessions)
    .sort((a, b) => b.reads - a.reads || a.match.localeCompare(b.match))
    .slice(0, opts.max)
    .map((g) => ({ type: g.type, match: g.match, reads: g.reads, sessions: g.sessions.size }));
}

export function addRule(cfg: TrustConfig, rule: TrustRule): TrustConfig {
  return { rules: [...cfg.rules.filter((r) => !(r.type === rule.type && r.match === rule.match)), rule] };
}

export function removeRule(cfg: TrustConfig, type: RuleType, match: string): { cfg: TrustConfig; removed: boolean } {
  const rules = cfg.rules.filter((r) => !(r.type === type && r.match === match));
  return { cfg: { rules }, removed: rules.length !== cfg.rules.length };
}

export function parseTier(s: string): RuleTier | null {
  const aliases: Record<string, RuleTier> = {
    T2: "T2", trusted: "T2",
    T3: "T3", dependency: "T3",
    T4: "T4", external: "T4", untrusted: "T4",
  };
  return aliases[s] ?? null;
}

export function inferRule(source: string): { type: RuleType; match: string } {
  if (source.startsWith("mcp:")) {
    const server = source.slice(4).split("/")[0] ?? "";
    return { type: "mcp_server", match: server };
  }
  if (source.startsWith("/") || source.startsWith("~")) return { type: "path", match: source };
  const host = sourceHost(source);
  const domain = host ?? source.toLowerCase().split("/")[0] ?? "";
  return { type: "domain", match: domain };
}
