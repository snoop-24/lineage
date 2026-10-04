import { appendFileSync } from "node:fs";
import { toCommonEvents, type ClaudeHookInput } from "../adapters/claude-code.ts";
import { record, type RecorderDeps } from "../core/recorder.ts";
import { Store } from "../core/store.ts";
import { loadTrust } from "../core/trust.ts";
import { loadConfig } from "../config.ts";
import { configPath, ensureDataDir, errorLogPath, resolveEnv, trustPath, type Env } from "../paths.ts";

export function logError(dataDir: string, err: unknown): void {
  try {
    ensureDataDir(dataDir);
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    appendFileSync(errorLogPath(dataDir), `${new Date().toISOString()} ${msg.replace(/\n/g, " | ")}\n`);
  } catch {
    // A hook must never fail the agent's action.
  }
}

export function handleHookInput(stdinText: string, env: Env, now: Date = new Date()): void {
  try {
    const input = JSON.parse(stdinText) as ClaudeHookInput;
    const events = toCommonEvents(input, now);
    if (events.length === 0) return;
    ensureDataDir(env.dataDir);
    const cfg = loadConfig(configPath(env.dataDir));
    const store = Store.open(env.dataDir);
    try {
      const deps: RecorderDeps = {
        store,
        trust: loadTrust(trustPath(env.dataDir)),
        home: env.home,
        platform: process.platform,
        settingsPath: env.claudeSettingsPath,
        installedCommand: cfg.installedCommand,
        ingestCapBytes: cfg.ingestCapBytes,
        retentionDays: cfg.retentionDays,
      };
      for (const ev of events) record(ev, deps);
    } finally {
      store.close();
    }
  } catch (err) {
    logError(env.dataDir, err);
  }
}

export async function readStdin(): Promise<string> {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}

export async function hookCommand(_args: string[]): Promise<number> {
  const env = resolveEnv();
  const text = await readStdin().catch((err: unknown) => {
    logError(env.dataDir, err);
    return "";
  });
  handleHookInput(text, env);
  return 0;
}
