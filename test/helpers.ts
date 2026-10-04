import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.ts";
import type { RecorderDeps } from "../src/core/recorder.ts";

export function tempDir(prefix = "pvg-test-"): { path: string; cleanup: () => void } {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export function recorderFixture() {
  const t = tempDir();
  const home = join(t.path, "home");
  const proj = join(t.path, "proj");
  const data = join(t.path, "data");
  const memoryDir = join(home, ".claude", "projects", "p", "memory");
  mkdirSync(join(proj, ".git"), { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(data);
  writeFileSync(join(proj, "CLAUDE.md"), "# Project\n");
  writeFileSync(join(memoryDir, "MEMORY.md"), "- existing fact\n");
  const store = Store.open(data);
  const deps: RecorderDeps = {
    store,
    trust: { rules: [] },
    home,
    platform: "linux",
    settingsPath: join(home, ".claude", "settings.json"),
    installedCommand: null,
    ingestCapBytes: 1_048_576,
    retentionDays: 30,
  };
  let n = 0;
  const ts = (): string => new Date(Date.UTC(2026, 9, 2, 12, 0, n++)).toISOString();
  const base = (sessionId: string) => ({ sessionId, ts: ts(), projectRoot: proj, agentId: null, memoryDir });
  const cleanup = (): void => {
    store.close();
    t.cleanup();
  };
  return { home, proj, data, memoryDir, store, deps, base, cleanup };
}
