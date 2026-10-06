import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Store } from "../core/store.ts";
import { classifiedIngests } from "../core/report.ts";
import {
  addRule, inferRule, loadTrust, parseTier, proposeTrust, removeRule, saveTrust, TIER_NAMES,
  type ProposalItem, type TrustRule,
} from "../core/trust.ts";
import { dbPath, ensureDataDir, resolveEnv, trustPath, type Env } from "../paths.ts";
import { emit, ok, usage, type CmdResult } from "./result.ts";

const ADD_USAGE = "Usage: pvg trust add <source> --tier <trusted|dependency|external>";
const TRUST_JSON_INVALID_MSG = "trust.json is not valid JSON; fix or delete it before changing trust rules";

export function trustFileInvalid(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const content = readFileSync(path, "utf8");
    const parsed = JSON.parse(content);
    return parsed === null || typeof parsed !== "object";
  } catch {
    return true;
  }
}

function currentProposals(env: Env, now: Date): ProposalItem[] {
  if (!existsSync(dbPath(env.dataDir))) return [];
  const store = Store.open(env.dataDir);
  try {
    const cfg = loadTrust(trustPath(env.dataDir));
    const sinceIso = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    const ingests = classifiedIngests(store, cfg, { sinceIso, projectRoot: null, home: env.home });
    const proposals = proposeTrust(ingests);
    // Filter out proposals that already have a rule with the same type and match
    return proposals.filter((p) => !cfg.rules.some((r) => r.type === p.type && r.match === p.match));
  } finally {
    store.close();
  }
}

function parseAddArgs(args: string[]) {
  return parseArgs({ args, options: { tier: { type: "string" } }, allowPositionals: true });
}

export function runTrust(args: string[], env: Env, now: Date = new Date()): CmdResult {
  const [sub = "list", ...rest] = args;
  const path = trustPath(env.dataDir);

  if (sub === "list") {
    const cfg = loadTrust(path);
    const L: string[] = [];
    if (cfg.rules.length === 0) {
      L.push("No trust rules yet. Defaults: your prompts, workspace files, your own ~/.claude memory and instruction files, and CLAUDE.md files above the project are trusted; web, MCP, network, dependency and other outside-project files are untrusted.");
    } else {
      L.push("Trust rules:");
      for (const r of cfg.rules) L.push(`  ${r.type} ${r.match} ${r.tier} (${TIER_NAMES[r.tier]})`);
    }
    const proposals = currentProposals(env, now);
    if (proposals.length > 0) {
      L.push("Proposed (run `pvg trust accept`):");
      for (const p of proposals) L.push(`  ${p.type} ${p.match} (${p.reads} reads, ${p.sessions} sessions)`);
    }
    return ok(L);
  }

  if (sub === "add") {
    let parsed: ReturnType<typeof parseAddArgs>;
    try {
      parsed = parseAddArgs(rest);
    } catch (e) {
      return usage(`${(e as Error).message}\n${ADD_USAGE}`);
    }
    const source = parsed.positionals[0];
    const tier = parseTier(parsed.values.tier ?? "");
    if (!source || !tier) return usage(ADD_USAGE);
    if (trustFileInvalid(path)) return { code: 1, out: "", err: `${TRUST_JSON_INVALID_MSG}\n` };
    ensureDataDir(env.dataDir);
    const rule: TrustRule = { ...inferRule(source), tier };
    saveTrust(path, addRule(loadTrust(path), rule));
    return ok([`Added rule: ${rule.type} ${rule.match} → ${rule.tier} (${TIER_NAMES[rule.tier]})`]);
  }

  if (sub === "remove") {
    const source = rest[0];
    if (!source) return usage("Usage: pvg trust remove <source>");
    if (trustFileInvalid(path)) return { code: 1, out: "", err: `${TRUST_JSON_INVALID_MSG}\n` };
    const key = inferRule(source);
    const r = removeRule(loadTrust(path), key.type, key.match);
    if (r.removed) saveTrust(path, r.cfg);
    return ok([r.removed ? `Removed rule: ${key.type} ${key.match}` : `No rule for ${key.type} ${key.match}`]);
  }

  if (sub === "accept") {
    if (trustFileInvalid(path)) return { code: 1, out: "", err: `${TRUST_JSON_INVALID_MSG}\n` };
    const proposals = currentProposals(env, now);
    if (proposals.length === 0) return ok(["No proposals to accept yet."]);
    ensureDataDir(env.dataDir);
    let cfg = loadTrust(path);
    for (const p of proposals) cfg = addRule(cfg, { type: p.type, match: p.match, tier: "T2" });
    saveTrust(path, cfg);
    return ok(["Trusted:", ...proposals.map((p) => `  ${p.type} ${p.match}`)]);
  }

  return usage(`Unknown trust subcommand: ${sub}`);
}

export async function trustCommand(args: string[]): Promise<number> {
  return emit(runTrust(args, resolveEnv()));
}
