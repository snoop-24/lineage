import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { STORED_KINDS, type StoredKind } from "../core/events.ts";
import { Store } from "../core/store.ts";
import { safe } from "../core/sanitize.ts";
import { dbPath, resolveEnv, type Env } from "../paths.ts";
import { emit, ok, usage, type CmdResult } from "./result.ts";

function parseLogArgs(args: string[]) {
  return parseArgs({
    args,
    options: { session: { type: "string" }, kind: { type: "string" }, limit: { type: "string", default: "50" } },
    allowPositionals: false,
  });
}

export function runLog(args: string[], env: Env): CmdResult {
  let parsed: ReturnType<typeof parseLogArgs>;
  try {
    parsed = parseLogArgs(args);
  } catch (e) {
    return usage((e as Error).message);
  }
  const kind = parsed.values.kind;
  if (kind !== undefined && !STORED_KINDS.includes(kind as StoredKind)) {
    return usage(`Unknown kind "${kind}". Kinds: ${STORED_KINDS.join(", ")}`);
  }
  const limit = Number(parsed.values.limit ?? "50");
  if (!Number.isInteger(limit) || limit <= 0) return usage("--limit must be a positive integer");
  if (!existsSync(dbPath(env.dataDir))) return ok(["No events yet."]);
  const store = Store.open(env.dataDir);
  try {
    const rows = store
      .listEvents({ sessionId: parsed.values.session, kind: kind as StoredKind | undefined, limit, order: "desc" })
      .reverse();
    if (rows.length === 0) return ok(["No matching events."]);
    return ok(rows.map((e) => safe(`#${e.id} ${e.ts} ${e.kind} ${e.toolName ?? "-"} ${e.surfacePath ?? e.sourceId ?? ""}`.trimEnd())));
  } finally {
    store.close();
  }
}

export async function logCommand(args: string[]): Promise<number> {
  return emit(runLog(args, resolveEnv()));
}
