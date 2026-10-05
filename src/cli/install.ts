import { rmSync } from "node:fs";
import { extname, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  addDenyRule, addHooks, HOOK_EVENTS, POST_TOOL_MATCHER, readSettings, removeDenyRule, removeHooks, writeSettingsWithBackup, hookInstalledFor,
} from "../claude-settings.ts";
import { baseline } from "../core/recorder.ts";
import { Store } from "../core/store.ts";
import { managedClaudeMd, userSurfaceTargets } from "../core/surfaces.ts";
import { loadConfig, saveConfig } from "../config.ts";
import { configPath, ensureDataDir, resolveEnv, type Env } from "../paths.ts";
import { emit, ok, usage, type CmdResult } from "./result.ts";

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function buildHookCommand(nodePath: string, cliPath: string, envVars: Record<string, string>): string {
  const prefix = Object.entries(envVars)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${shellQuote(v)} `)
    .join("");
  return `${prefix}${shellQuote(nodePath)} --no-warnings ${shellQuote(cliPath)} hook`;
}

export function denyRuleFor(env: Env): string {
  const rel = relative(env.home, env.dataDir);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  return inside ? `Edit(~/${rel}/**)` : `Edit(/${env.dataDir}/**)`;
}

export function defaultCliPath(): string {
  const ext = extname(fileURLToPath(import.meta.url));
  return fileURLToPath(new URL(`../cli${ext}`, import.meta.url));
}

export function pvgEnvVars(processEnv: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PVG_DATA_DIR", "PVG_HOME_DIR", "PVG_CLAUDE_SETTINGS"]) {
    const v = processEnv[k];
    if (v) out[k] = v;
  }
  return out;
}

export interface InitOptions {
  dryRun: boolean;
  protectData: boolean;
  command: string;
  now: Date;
  platform: NodeJS.Platform;
}

export interface InitResult {
  changes: string[];
  backupPath: string | null;
  baselined: number;
  command: string;
}

export function runInit(env: Env, o: InitOptions): InitResult {
  const settings = readSettings(env.claudeSettingsPath);
  const cfg = loadConfig(configPath(env.dataDir));
  const changes: string[] = [];
  let base = settings;
  if (cfg.installedCommand && cfg.installedCommand !== o.command) {
    base = removeHooks(base, cfg.installedCommand);
    changes.push("replace previous pvg hook command");
  }
  for (const ev of HOOK_EVENTS) {
    const present = hookInstalledFor(base, ev, o.command);
    if (!present) changes.push(`add ${ev} hook${ev === "PostToolUse" ? ` (matcher ${POST_TOOL_MATCHER})` : ""}`);
  }
  let next = addHooks(base, o.command);
  if (o.protectData) {
    const rule = denyRuleFor(env);
    if (!(base.permissions?.deny ?? []).includes(rule)) changes.push(`add permission deny rule ${rule}`);
    next = addDenyRule(next, rule);
  }
  if (o.dryRun) return { changes, backupPath: null, baselined: 0, command: o.command };

  ensureDataDir(env.dataDir);
  const backupPath = changes.length > 0 ? writeSettingsWithBackup(env.claudeSettingsPath, next, o.now) : null;
  saveConfig(configPath(env.dataDir), { ...cfg, installedCommand: o.command });
  const store = Store.open(env.dataDir);
  let baselined = 0;
  try {
    const targets = userSurfaceTargets(env.home);
    const managed = managedClaudeMd(o.platform);
    if (managed) targets.push({ path: managed, scope: "managed", trackAbsent: false });
    baselined = baseline(targets, store, o.now.toISOString());
  } finally {
    store.close();
  }
  return { changes, backupPath, baselined, command: o.command };
}

export interface UninstallResult {
  removed: boolean;
  backupPath: string | null;
  purged: boolean;
  message: string;
}

export function runUninstall(env: Env, o: { purge: boolean; now: Date }): UninstallResult {
  const cfg = loadConfig(configPath(env.dataDir));
  let backupPath: string | null = null;
  let removed = false;
  if (cfg.installedCommand) {
    const settings = readSettings(env.claudeSettingsPath);
    const next = removeDenyRule(removeHooks(settings, cfg.installedCommand), denyRuleFor(env));
    backupPath = writeSettingsWithBackup(env.claudeSettingsPath, next, o.now);
    removed = true;
    if (!o.purge) saveConfig(configPath(env.dataDir), { ...cfg, installedCommand: null });
  }
  if (o.purge) rmSync(env.dataDir, { recursive: true, force: true });
  return {
    removed,
    backupPath,
    purged: o.purge,
    message: removed ? "Removed pvg hooks from Claude Code settings." : "pvg hooks were not installed.",
  };
}

function parseInitArgs(args: string[]) {
  return parseArgs({
    args,
    options: { "dry-run": { type: "boolean", default: false }, "protect-data": { type: "boolean", default: false } },
    allowPositionals: false,
  });
}

export function initCli(args: string[], env: Env, now: Date = new Date(), cliPath: string = defaultCliPath()): CmdResult {
  let parsed: ReturnType<typeof parseInitArgs>;
  try {
    parsed = parseInitArgs(args);
  } catch (e) {
    return usage((e as Error).message);
  }
  const dryRun = parsed.values["dry-run"] === true;
  const protectData = parsed.values["protect-data"] === true;
  const command = buildHookCommand(process.execPath, cliPath, pvgEnvVars(process.env));
  let r: InitResult;
  try {
    r = runInit(env, { dryRun, protectData, command, now, platform: process.platform });
  } catch (e) {
    return { code: 1, out: "", err: `pvg init failed: ${(e as Error).message}\n` };
  }
  const L: string[] = [];
  if (dryRun) L.push("pvg init (dry run: no files changed)");
  L.push(`Changes to ${env.claudeSettingsPath}:`);
  if (r.changes.length === 0) L.push("  No changes: pvg hooks are already installed.");
  for (const c of r.changes) L.push(`  - ${c}`);
  if (r.backupPath) L.push(`Backup of previous settings: ${r.backupPath}`);
  if (!dryRun) L.push(`Baselined ${r.baselined} user-level memory/instruction file(s).`, `Data directory: ${env.dataDir}`);
  if (!protectData) {
    L.push(`Recommended: run \`pvg init --protect-data\` to deny agents write access to ${env.dataDir} (adds Claude Code rule ${denyRuleFor(env)}).`);
  }
  L.push("Next: use Claude Code as usual, then run `pvg report`. Remove anytime with `pvg uninstall`.");
  return ok(L);
}

function parseUninstallArgs(args: string[]) {
  return parseArgs({ args, options: { purge: { type: "boolean", default: false } }, allowPositionals: false });
}

export function uninstallCli(args: string[], env: Env, now: Date = new Date()): CmdResult {
  let parsed: ReturnType<typeof parseUninstallArgs>;
  try {
    parsed = parseUninstallArgs(args);
  } catch (e) {
    return usage((e as Error).message);
  }
  let r: UninstallResult;
  try {
    r = runUninstall(env, { purge: parsed.values.purge === true, now });
  } catch (e) {
    return { code: 1, out: "", err: `pvg uninstall failed: ${(e as Error).message}\n` };
  }
  const L = [r.message];
  if (r.backupPath) L.push(`Backup of previous settings: ${r.backupPath}`);
  if (r.purged) L.push(`Deleted pvg data directory ${env.dataDir}.`);
  return ok(L);
}

export async function initCommand(args: string[]): Promise<number> {
  return emit(initCli(args, resolveEnv()));
}

export async function uninstallCommand(args: string[]): Promise<number> {
  return emit(uninstallCli(args, resolveEnv()));
}
