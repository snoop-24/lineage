export type SourceKind = "web" | "search" | "mcp" | "file" | "network";
export type Tier = "T0" | "T1" | "T2" | "T3" | "T4";
export type StoredKind =
  | "session_start"
  | "prompt"
  | "ingest"
  | "write"
  | "scan_change"
  | "load"
  | "config_change"
  | "tamper";

export const STORED_KINDS: readonly StoredKind[] = [
  "session_start",
  "prompt",
  "ingest",
  "write",
  "scan_change",
  "load",
  "config_change",
  "tamper",
];

interface EventBase {
  sessionId: string;
  ts: string;
  projectRoot: string;
  agentId: string | null;
  memoryDir: string | null;
}

export type CommonEvent =
  | (EventBase & { kind: "session_start"; permissionMode: string | null })
  | (EventBase & { kind: "prompt"; text: string })
  | (EventBase & { kind: "ingest"; toolName: string; sourceKind: SourceKind; sourceId: string; text: string })
  | (EventBase & { kind: "file_write"; toolName: string; filePath: string })
  | (EventBase & { kind: "bash"; toolName: string; command: string; output: string })
  | (EventBase & { kind: "load"; filePath: string; memoryType: string | null; loadReason: string | null })
  | (EventBase & { kind: "config_change"; raw: string });
