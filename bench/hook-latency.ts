// Usage: npm run bench   (builds first). Exit code 1 if a target is missed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { record, type RecorderDeps } from "../src/core/recorder.ts";
import { errorLogPath } from "../src/paths.ts";
import { Store } from "../src/core/store.ts";
import { tempDir } from "../test/helpers.ts";

const p95 = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(s.length * 0.95) - 1)] ?? 0;
};

const HOOK_RUNS = 30;
const t = tempDir("pvg-bench-");
try {
  const home = join(t.path, "home");
  const proj = join(t.path, "proj");
  const data = join(t.path, "data");
  const projDir = join(home, ".claude", "projects", "-proj");
  const memoryDir = join(projDir, "memory");
  mkdirSync(join(proj, ".git"), { recursive: true });
  mkdirSync(join(proj, ".claude", "rules"), { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(proj, "CLAUDE.md"), "# Bench\n");
  for (let i = 0; i < 40; i++) writeFileSync(join(proj, ".claude", "rules", `rule-${i}.md`), `rule ${i}\n`);

  const env = { ...process.env, PVG_DATA_DIR: data, PVG_HOME_DIR: home, PVG_CLAUDE_SETTINGS: join(home, ".claude", "settings.json") };
  const transcript = join(projDir, "bench.jsonl");
  const send = (payload: object) =>
    spawnSync(process.execPath, ["--no-warnings", "dist/cli.js", "hook"], { input: JSON.stringify(payload), env, encoding: "utf8" });

  send({ hook_event_name: "SessionStart", session_id: "bench", cwd: proj, transcript_path: transcript });
  const hookTimes: number[] = [];
  for (let i = 0; i < HOOK_RUNS; i++) {
    const t0 = performance.now();
    const r = send({
      hook_event_name: "PostToolUse", session_id: "bench", cwd: proj, transcript_path: transcript,
      tool_name: "WebFetch", tool_input: { url: `https://example.com/${i}` }, tool_response: "x".repeat(20_000),
    });
    hookTimes.push(performance.now() - t0);
    if (r.status !== 0) throw new Error(`hook exited ${String(r.status)}: ${r.stderr}`);
  }

  // The hook always exits 0, so a fast run proves nothing unless the events were actually recorded.
  const store = Store.open(data);
  try {
    const recorded = store.listEvents({ kind: "ingest" }).length;
    if (recorded !== HOOK_RUNS) throw new Error(`bench invalid: hook recorded ${recorded}/${HOOK_RUNS} events`);
    const logPath = errorLogPath(data);
    if (existsSync(logPath) && readFileSync(logPath, "utf8").trim() !== "") throw new Error("bench invalid: errors.log not empty");

    const deps: RecorderDeps = {
      store, trust: { rules: [] }, home, platform: process.platform, settingsPath: join(home, ".claude", "settings.json"),
      installedCommand: null, ingestCapBytes: 1_048_576, retentionDays: 30,
    };
    const surfaces = store.listSurfaces().length;
    const rescanTimes: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      record({ sessionId: "bench", ts: new Date().toISOString(), projectRoot: proj, agentId: null, memoryDir, kind: "bash", toolName: "Bash", command: "ls", output: "" }, deps);
      rescanTimes.push(performance.now() - t0);
    }

    const hookP95 = p95(hookTimes);
    const rescanP95 = p95(rescanTimes);
    console.log(`hook p95: ${hookP95.toFixed(1)} ms (target <= 100)`);
    console.log(`rescan p95: ${rescanP95.toFixed(1)} ms over ${surfaces} surfaces (target <= 30)`);
    process.exitCode = hookP95 > 100 || rescanP95 > 30 ? 1 : 0;
  } finally {
    store.close();
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg.startsWith("bench invalid") ? msg : `bench invalid: ${msg}`);
  process.exitCode = 1;
} finally {
  t.cleanup();
}
