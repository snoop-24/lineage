import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "InstructionsLoaded", "ConfigChange"] as const;
export const POST_TOOL_MATCHER = "Write|Edit|MultiEdit|NotebookEdit|Read|WebFetch|WebSearch|Bash|mcp__.*";
export const HOOK_TIMEOUT_SECONDS = 10;

export interface HookCommand {
  type: string;
  command?: string;
  timeout?: number;
  [k: string]: unknown;
}

export interface MatcherGroup {
  matcher?: string;
  hooks: HookCommand[];
  [k: string]: unknown;
}

export interface Settings {
  hooks?: Record<string, MatcherGroup[]>;
  permissions?: { deny?: string[]; [k: string]: unknown };
  [k: string]: unknown;
}

export function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed as Settings;
}

function groupHasCommand(g: MatcherGroup, command: string): boolean {
  return Array.isArray(g.hooks) && g.hooks.some((h) => h.command === command);
}

export function hooksInstalled(s: Settings, command: string): boolean {
  return HOOK_EVENTS.every((ev) => (s.hooks?.[ev] ?? []).some((g) => groupHasCommand(g, command)));
}

export function addHooks(s: Settings, command: string): Settings {
  const hooks: Record<string, MatcherGroup[]> = { ...(s.hooks ?? {}) };
  for (const ev of HOOK_EVENTS) {
    const groups = [...(hooks[ev] ?? [])];
    if (groups.some((g) => groupHasCommand(g, command))) continue;
    const entry: HookCommand = { type: "command", command, timeout: HOOK_TIMEOUT_SECONDS };
    groups.push(ev === "PostToolUse" ? { matcher: POST_TOOL_MATCHER, hooks: [entry] } : { hooks: [entry] });
    hooks[ev] = groups;
  }
  return { ...s, hooks };
}

export function removeHooks(s: Settings, command: string): Settings {
  if (!s.hooks) return s;
  const hooks: Record<string, MatcherGroup[]> = {};
  for (const [ev, groups] of Object.entries(s.hooks)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => h.command !== command) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length > 0) hooks[ev] = kept;
  }
  const next: Settings = { ...s };
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

export function addDenyRule(s: Settings, rule: string): Settings {
  const deny = [...(s.permissions?.deny ?? [])];
  if (!deny.includes(rule)) deny.push(rule);
  return { ...s, permissions: { ...(s.permissions ?? {}), deny } };
}

export function removeDenyRule(s: Settings, rule: string): Settings {
  const deny = s.permissions?.deny;
  if (!deny || !deny.includes(rule)) return s;
  return { ...s, permissions: { ...s.permissions, deny: deny.filter((r) => r !== rule) } };
}

export function writeSettingsWithBackup(path: string, s: Settings, now: Date): string | null {
  let backup: string | null = null;
  if (existsSync(path)) {
    backup = `${path}.pvg-backup-${now.toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(path, backup);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(s, null, 2)}\n`);
  return backup;
}
