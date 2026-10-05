import { existsSync, readFileSync } from "node:fs";
import { Store } from "../core/store.ts";
import { tilde } from "../core/report.ts";
import { hooksInstalled, readSettings, type Settings } from "../claude-settings.ts";
import { loadConfig } from "../config.ts";
import { configPath, dbPath, errorLogPath, resolveEnv, trustPath, type Env } from "../paths.ts";
import { VERSION } from "../version.ts";
import { countErrorLines } from "./report.ts";
import { emit, ok, type CmdResult } from "./result.ts";

export function runStatus(env: Env): CmdResult {
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
  if (existsSync(dbPath(env.dataDir))) {
    const store = Store.open(env.dataDir);
    try {
      const counts = store.countByKind();
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      L.push(`Events: ${total} (${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")})`);
      const [last] = store.listEvents({ order: "desc", limit: 1 });
      if (last) L.push(`Last event: ${last.ts} (${last.kind})`);
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
  if (existsSync(trustJsonPath)) {
    try {
      const content = readFileSync(trustJsonPath, "utf8");
      const parsed = JSON.parse(content);
      if (parsed === null || typeof parsed !== "object") {
        L.push("Trust rules: WARNING: trust.json is not valid JSON; your trust rules are not being applied (fix or delete it)");
      }
    } catch {
      L.push("Trust rules: WARNING: trust.json is not valid JSON; your trust rules are not being applied (fix or delete it)");
    }
  }

  return ok(L);
}

export async function statusCommand(_args: string[]): Promise<number> {
  return emit(runStatus(resolveEnv()));
}
