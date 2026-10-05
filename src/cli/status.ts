import { existsSync } from "node:fs";
import { Store } from "../core/store.ts";
import { tilde } from "../core/report.ts";
import { hooksInstalled, readSettings, type Settings } from "../claude-settings.ts";
import { loadConfig } from "../config.ts";
import { configPath, dbPath, errorLogPath, resolveEnv, trustPath, type Env } from "../paths.ts";
import { VERSION } from "../version.ts";
import { countErrorLines } from "./report.ts";
import { trustFileInvalid } from "./trust.ts";
import { emit, ok, type CmdResult } from "./result.ts";

const QUIET_DAYS = 7;
const QUOTED = "'((?:[^']|'\\\\'')*)'";
const HOOK_COMMAND_RE = new RegExp(`(?:^| )${QUOTED} --no-warnings ${QUOTED} hook$`);

// Node and CLI paths from an installed hook command: [ENV='…' ]'<node>' --no-warnings '<cli>' hook
export function hookCommandPaths(command: string): { node: string; cli: string } | null {
  const m = HOOK_COMMAND_RE.exec(command);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  const unquote = (s: string): string => s.replace(/'\\''/g, "'");
  return { node: unquote(m[1]), cli: unquote(m[2]) };
}

const TRUST_JSON_INVALID_MSG = "Trust rules: WARNING: trust.json is not valid JSON; your trust rules are not being applied (fix or delete it)";

export function runStatus(env: Env, now: Date = new Date()): CmdResult {
  const L: string[] = [`pvg ${VERSION}`];
  const cfg = loadConfig(configPath(env.dataDir));
  let settings: Settings = {};
  let settingsReadable = true;
  try {
    settings = readSettings(env.claudeSettingsPath);
  } catch {
    settingsReadable = false;
  }
  const installed = cfg.installedCommand !== null && hooksInstalled(settings, cfg.installedCommand);
  L.push(`Data directory: ${tilde(env.dataDir, env.home)}`);
  L.push(`Claude Code settings: ${tilde(env.claudeSettingsPath, env.home)}${settingsReadable ? "" : " (not valid JSON)"}`);
  L.push(`Hooks installed: ${installed ? "yes" : "no (run: pvg init)"}`);
  const paths = installed && cfg.installedCommand ? hookCommandPaths(cfg.installedCommand) : null;
  if (paths && (!existsSync(paths.node) || !existsSync(paths.cli))) {
    L.push("WARNING: hook command points to a missing Node or CLI path; re-run pvg init");
  }
  if (existsSync(dbPath(env.dataDir))) {
    const store = Store.open(env.dataDir);
    try {
      const counts = store.countByKind();
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      L.push(`Events: ${total} (${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")})`);
      const [last] = store.listEvents({ order: "desc", limit: 1 });
      if (last) L.push(`Last event: ${last.ts} (${last.kind})`);
      const quietMs = last ? now.getTime() - Date.parse(last.ts) : 0;
      if (installed && quietMs > QUIET_DAYS * 86_400_000) {
        L.push(`WARNING: no events recorded in ${Math.floor(quietMs / 86_400_000)} days — is recording working?`);
      }
      const chain = store.verifyChain();
      L.push(
        chain.ok
          ? `Log integrity: OK (${chain.count} events)`
          : `Log integrity: BROKEN at event #${chain.brokenAtId ?? "?"}: the log was edited outside pvg`,
      );
      const tamper = store.listEvents({ kind: "tamper" }).length;
      if (tamper > 0) L.push(`Tamper events: ${tamper} (pvg hooks were removed or changed while Claude Code was running)`);
    } finally {
      store.close();
    }
  } else {
    L.push("Events: none yet");
  }
  const errors = countErrorLines(env.dataDir);
  L.push(`Errors logged: ${errors}${errors > 0 ? ` (see ${tilde(errorLogPath(env.dataDir), env.home)})` : ""}`);

  // Check trust.json validity (ruling 2)
  const trustJsonPath = trustPath(env.dataDir);
  if (existsSync(trustJsonPath) && trustFileInvalid(trustJsonPath)) {
    L.push(TRUST_JSON_INVALID_MSG);
  }

  return ok(L);
}

export async function statusCommand(_args: string[]): Promise<number> {
  return emit(runStatus(resolveEnv()));
}
