// Translates Claude Code hook stdin JSON into agent-agnostic CommonEvents. Never throws on odd input.
import { dirname, join, resolve } from "node:path";
import type { CommonEvent } from "../core/events.ts";
import { findProjectRoot } from "../core/project.ts";

export interface ClaudeHookInput {
  hook_event_name?: unknown;
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  permission_mode?: unknown;
  agent_id?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
  prompt?: unknown;
  file_path?: unknown;
  memory_type?: unknown;
  load_reason?: unknown;
  [k: string]: unknown;
}

interface Base {
  sessionId: string;
  ts: string;
  projectRoot: string;
  agentId: string | null;
  memoryDir: string | null;
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export function extractText(value: unknown, maxChars = 2_000_000): string {
  const parts: string[] = [];
  let total = 0;
  const visit = (v: unknown, depth: number): void => {
    if (total >= maxChars || depth > 20) return;
    if (typeof v === "string") {
      parts.push(v);
      total += v.length;
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
    } else if (v !== null && typeof v === "object") {
      for (const x of Object.values(v)) visit(x, depth + 1);
    }
  };
  visit(value, 0);
  return parts.join("\n").slice(0, maxChars);
}

export function memoryDirFromTranscript(transcriptPath: string | null): string | null {
  return transcriptPath ? join(dirname(transcriptPath), "memory") : null;
}

export function toCommonEvents(input: ClaudeHookInput, now: Date = new Date()): CommonEvent[] {
  const event = str(input.hook_event_name);
  const sessionId = str(input.session_id);
  const cwd = str(input.cwd);
  if (!event || !sessionId || !cwd) return [];
  const base: Base = {
    sessionId,
    ts: now.toISOString(),
    projectRoot: findProjectRoot(cwd),
    agentId: str(input.agent_id),
    memoryDir: memoryDirFromTranscript(str(input.transcript_path)),
  };
  switch (event) {
    case "SessionStart":
      return [{ ...base, kind: "session_start", permissionMode: str(input.permission_mode) }];
    case "UserPromptSubmit": {
      const text = str(input.prompt);
      return text ? [{ ...base, kind: "prompt", text }] : [];
    }
    case "PostToolUse":
      return toolEvents(input, cwd, base);
    case "InstructionsLoaded": {
      const fp = str(input.file_path);
      return fp
        ? [{ ...base, kind: "load", filePath: resolve(cwd, fp), memoryType: str(input.memory_type), loadReason: str(input.load_reason) }]
        : [];
    }
    case "ConfigChange":
      return [{ ...base, kind: "config_change", raw: JSON.stringify(input) }];
    default:
      return [];
  }
}

function toolEvents(input: ClaudeHookInput, cwd: string, base: Base): CommonEvent[] {
  const tool = str(input.tool_name);
  if (!tool) return [];
  const ti = (input.tool_input !== null && typeof input.tool_input === "object" ? input.tool_input : {}) as Record<string, unknown>;
  const text = (): string => extractText(input.tool_response);
  if (WRITE_TOOLS.has(tool)) {
    const fp = str(ti.file_path) ?? str(ti.notebook_path);
    return fp ? [{ ...base, kind: "file_write", toolName: tool, filePath: resolve(cwd, fp) }] : [];
  }
  if (tool === "Read") {
    const fp = str(ti.file_path);
    return fp ? [{ ...base, kind: "ingest", toolName: tool, sourceKind: "file", sourceId: resolve(cwd, fp), text: text() }] : [];
  }
  if (tool === "WebFetch") {
    const url = str(ti.url);
    return url ? [{ ...base, kind: "ingest", toolName: tool, sourceKind: "web", sourceId: url, text: text() }] : [];
  }
  if (tool === "WebSearch") {
    const q = str(ti.query);
    return q ? [{ ...base, kind: "ingest", toolName: tool, sourceKind: "search", sourceId: `search:${q}`, text: text() }] : [];
  }
  if (tool.startsWith("mcp__")) {
    const [, server, ...rest] = tool.split("__");
    if (!server) return [];
    return [{ ...base, kind: "ingest", toolName: tool, sourceKind: "mcp", sourceId: `mcp:${server}/${rest.join("__")}`, text: text() }];
  }
  if (tool === "Bash") {
    const command = str(ti.command);
    return command ? [{ ...base, kind: "bash", toolName: tool, command, output: text() }] : [];
  }
  return [];
}
