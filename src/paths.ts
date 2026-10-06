import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Env {
  home: string;
  dataDir: string;
  claudeSettingsPath: string;
}

export function resolveEnv(env: NodeJS.ProcessEnv = process.env): Env {
  const home = env.LINEAGE_HOME_DIR ?? homedir();
  return {
    home,
    dataDir: env.LINEAGE_DATA_DIR ?? join(home, ".lineage"),
    claudeSettingsPath: env.LINEAGE_CLAUDE_SETTINGS ?? join(home, ".claude", "settings.json"),
  };
}

export function ensureDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
}

export const dbPath = (dataDir: string): string => join(dataDir, "lineage.db");
export const errorLogPath = (dataDir: string): string => join(dataDir, "errors.log");
export const configPath = (dataDir: string): string => join(dataDir, "config.json");
export const trustPath = (dataDir: string): string => join(dataDir, "trust.json");
