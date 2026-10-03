import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface PvgConfig {
  installedCommand: string | null;
  retentionDays: number;
  ingestCapBytes: number;
}

export const DEFAULT_CONFIG: PvgConfig = { installedCommand: null, retentionDays: 30, ingestCapBytes: 1_048_576 };

export function loadConfig(path: string): PvgConfig {
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Record<keyof PvgConfig, unknown>>;
  const positive = (v: unknown, fallback: number): number => (typeof v === "number" && v > 0 ? v : fallback);
  return {
    installedCommand: typeof raw.installedCommand === "string" ? raw.installedCommand : null,
    retentionDays: positive(raw.retentionDays, DEFAULT_CONFIG.retentionDays),
    ingestCapBytes: positive(raw.ingestCapBytes, DEFAULT_CONFIG.ingestCapBytes),
  };
}

export function saveConfig(path: string, cfg: PvgConfig): void {
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
}
