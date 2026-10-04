import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Store } from "../core/store.ts";
import { loadTrust } from "../core/trust.ts";
import { findProjectRoot } from "../core/project.ts";
import { buildReport, renderMarkdown, renderText, reportJson, type ReportHealth } from "../core/report.ts";
import { hooksInstalled, readSettings, type Settings } from "../claude-settings.ts";
import { loadConfig, type PvgConfig } from "../config.ts";
import { configPath, dbPath, errorLogPath, resolveEnv, trustPath, type Env } from "../paths.ts";
import { emit, usage, type CmdResult } from "./result.ts";

export function parseSince(s: string, now: Date): string {
  const m = /^(\d+)([dh])$/.exec(s);
  if (!m) throw new Error(`Invalid --since "${s}": use e.g. 7d or 24h`);
  const n = Number(m[1]);
  const ms = m[2] === "d" ? n * 86_400_000 : n * 3_600_000;
  return new Date(now.getTime() - ms).toISOString();
}

export function countErrorLines(dataDir: string): number {
  const p = errorLogPath(dataDir);
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.length > 0).length : 0;
}

export function collectHealth(store: Store, env: Env, cfg: PvgConfig): ReportHealth {
  let settings: Settings = {};
  try {
    settings = readSettings(env.claudeSettingsPath);
  } catch {
    settings = {};
  }
  return {
    hooksInstalled: cfg.installedCommand !== null && hooksInstalled(settings, cfg.installedCommand),
    tamperEvents: store.listEvents({ kind: "tamper" }).length,
    chainOk: store.verifyChain().ok,
    errorLines: countErrorLines(env.dataDir),
  };
}

function parseReportArgs(args: string[]) {
  return parseArgs({
    args,
    options: {
      since: { type: "string", default: "7d" },
      project: { type: "string" },
      md: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
}

export function runReport(args: string[], env: Env, now: Date = new Date()): CmdResult {
  let parsed: ReturnType<typeof parseReportArgs>;
  let sinceIso: string;
  try {
    parsed = parseReportArgs(args);
    sinceIso = parseSince(parsed.values.since ?? "7d", now);
  } catch (e) {
    return usage((e as Error).message);
  }
  if (!existsSync(dbPath(env.dataDir))) {
    return { code: 1, out: "", err: "No data yet. Run `pvg init`, then use Claude Code for a while.\n" };
  }
  const cfg = loadConfig(configPath(env.dataDir));
  const store = Store.open(env.dataDir);
  try {
    const projectRoot = parsed.values.project ? findProjectRoot(resolve(parsed.values.project)) : null;
    const report = buildReport(store, loadTrust(trustPath(env.dataDir)), {
      sinceIso,
      projectRoot,
      home: env.home,
      health: collectHealth(store, env, cfg),
      now,
    });
    if (parsed.values.md) writeFileSync(parsed.values.md, renderMarkdown(report));
    return { code: 0, out: parsed.values.json === true ? reportJson(report) : renderText(report), err: "" };
  } finally {
    store.close();
  }
}

export async function reportCommand(args: string[]): Promise<number> {
  return emit(runReport(args, resolveEnv()));
}
