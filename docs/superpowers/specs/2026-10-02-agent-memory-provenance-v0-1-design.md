# Agent Memory Provenance — Product Context and v0.1 Design

**Date:** 2026-10-02
**Status:** Draft for review
**Working name:** Provenance Guard (CLI: `pvg`). Placeholder; see Decision D5.

---

## Part 1: Product context

### Problem

Coding agents (Claude Code, Cursor, Codex and others) read untrusted content all day: GitHub issues, web pages, emails, package READMEs. They save what they learn into persistent memory and instruction files (`CLAUDE.md`, `AGENTS.md`, auto-memory, rules, skills) that every future session loads and trusts.

One poisoned source can plant a false fact or instruction that persists across sessions:

- MemGhost (Jul 2026) poisoned `AGENTS.md` / `MEMORY.md` from a single email:
  - 71–88% success on OpenClaw and the Claude Code SDK.
  - Input filters missed more than 90% of attempts.
  - The owner was never notified.
- "Bad Memory" (arXiv 2607.14611) reports 80–100% success on Claude Code and Codex.
- Content screening caught 0 of 360 poisoned facts in "Utility Under Attack" (arXiv 2608.21230). Classifiers do not catch plainly worded lies.

### Thesis

Agent security today is generic. Each developer's workflow, sources and trust relationships differ. The product learns a developer's workflow, builds their own instruction hierarchy (a trust ranking of the sources their agents rely on), and enforces it outside the model with deterministic code.

The organizing principle: **the model will sometimes be fooled; make being fooled not stick.**

### Positioning

> GitGuardian protects your secrets. Socket protects your dependencies. **We protect what your agents believe.**

The category is the integrity of agent memory and instructions. How we differ from incumbents:

| Incumbents | Us |
|---|---|
| Classifiers that judge content | Origin tracing, with a stated reason |
| Alerts sent to an enterprise security team | Notices to the owner, plus targeted undo |
| A repository treated as one trust level | Trust tracked per author |
| Hand-written policies | Policies learned from the workflow |
| One vendor's agents | Every agent the developer uses |

### Architecture principles (all versions)

1. **Reflex layer is plain code.** Every decision that must be fast and injection-proof (gating, quarantine, recording) is deterministic code. It reads only structured data and never interprets content as instructions.
2. **Privilege split.** Anything that reads attacker content (future investigator agents, future safe reader) cannot act. Anything that acts never reads attacker content.
3. **The tool has narrow agency.** Automatic actions are narrow and reversible. Irreversible actions require the developer.
4. **Personalization only tightens.** The agent harness's built-in protections are the floor. Users adjust focus and trust rankings; they cannot grant the tool's agents more power.
5. **Local-first.** Data stays on the developer's machine. No telemetry without explicit opt-in.
6. **Engine plus adapters.** One agent-agnostic engine. Thin per-harness adapters translate hook message formats in and out.

### Roadmap (each item gets its own spec)

| Version | Scope |
|---|---|
| **v0.1 (this spec)** | **Observe and report, Claude Code only, read-only.** Doubles as demand validation. |
| v0.2 | Enforce: pause suspicious memory writes (`ask`) based on the trust ranking; `pvg restore` rollback; desktop notifications. |
| v0.3 | More harnesses (Cursor, Codex). GitHub PR check for shared `CLAUDE.md` / `AGENTS.md` changes, with per-author provenance. |
| v0.4 | Investigator and explainer agents in a separate, locked-down process. Red-team mode that attacks through the developer's real sources. |
| v0.5 | Paid Team plan: shared trust policies, team alert feed, alerts on sources known to be bad across users. |
| Later | Safe reader: an open model fine-tuned on each user's trust levels. Enterprise features. |

Business model: free and open source for individuals, a paid Team plan, then Enterprise (managed rollout, compliance exports). Blueprints are GitGuardian and Socket.dev.

---

## Part 2: v0.1 design (Observe and report for Claude Code)

### Goals

- **G1. Record ingestion.** Record every time a Claude Code session takes in content: tool, source, trust class, timestamp, session, and a content hash with a locally stored copy.
- **G2. Record writes and loads.** Record every change to a memory or instruction surface (path, diff, session, tool), and every time such a file is loaded into a session.
- **G3. Attribute writes.** Classify each memory change by what preceded it: clean, exposed to untrusted content, verbatim match with untrusted content, or unattributed.
- **G4. Catch writes no hook saw.** Detect changes to surfaces that no recorded write explains, such as Python scripts, other tools, or human edits.
- **G5. Report.** A `pvg report` command covering:
  - exposure summary;
  - flagged writes with attribution;
  - blast radius (sessions that later loaded a flagged line);
  - a proposed trust ranking.
- **G6. Personalize.** Propose a trust ranking from observed sources. The user confirms or edits it, and it immediately changes which ingestions count as untrusted.

### Non-goals (v0.1)

- **No blocking, pausing or asking.** v0.1 never changes agent behavior or any file outside its own data directory. `pvg init` and `pvg uninstall` edit the Claude Code settings file, with a backup.
- No rollback command. Snapshots are captured so v0.2 can add one.
- No harnesses other than Claude Code.
- No LLM components and no network calls.
- No team features, no cloud, no telemetry.
- No Windows support. macOS and Linux first.

### Success criteria

1. Install to first report takes under 5 minutes.
2. The reference demo attack (see Testing) is reported as **MATCHED**, with the correct source and matching text.
3. Zero agent actions are blocked or broken. Hooks never exit with a blocking code.
4. Hook overhead is at most 100 ms per tool call at p95.
5. **Validation gate for v0.2:**
   - 20–30 developers run v0.1 for at least a week.
   - Track:
     - share who open the report more than once;
     - share who edit their trust ranking;
     - qualitative "what surprised you?"
   - Decide whether to build v0.2 based on these results.

### Components

```
Claude Code ──hook JSON──▶ adapters/claude-code ──common event──▶ core/recorder ──▶ store (SQLite)
                                                                       │
                                                  core/surfaces (scan + snapshot)
                                                                       │
  pvg report ◀── core/report ◀── core/attribution + core/trust ◀───────┘
```

| Unit | Responsibility | Depends on |
|---|---|---|
| `adapters/claude-code` | Parse Claude Code hook stdin JSON into the common event schema. Always exit 0 with no decision output. | `core/events` |
| `core/events` | Common event types (agent-agnostic). | none |
| `core/recorder` | Append events, store content blobs, maintain the hash chain. Must be fast. | `store` |
| `store` | SQLite database (WAL mode) plus content-addressed blobs, in the data directory. | `node:sqlite` |
| `core/classify` | Map an ingestion to a source ID and trust class using the user's trust config. Deterministic. | `core/trust` |
| `core/surfaces` | Registry of memory and instruction paths; hashes, scans and snapshots them. | `store` |
| `core/bash-parse` | Best-effort detection of network fetches and surface writes in Bash commands. | none |
| `core/attribution` | Run at report time: labels each write and computes verbatim overlap and blast radius. | `store`, `core/trust` |
| `core/trust` | Trust tiers, user config, and the ranking proposal. | none |
| `core/report` | Render terminal, Markdown and JSON reports. | `core/attribution`, `core/trust` |
| `cli/*` | Commands: `init`, `uninstall`, `hook`, `report`, `trust`, `status`, `log`. | core |

Heavy work (attribution, overlap matching) runs at **report time**. Hooks only record, which keeps them inside the latency budget.

### Hooks used (Claude Code)

| Event | Matcher | What v0.1 does |
|---|---|---|
| `SessionStart` | all | Register the session (ID, cwd, permission mode). **Scan surfaces:** any change since the last known snapshot becomes an `UNATTRIBUTED (between sessions)` event. |
| `UserPromptSubmit` | all | Record a user turn (trust tier T0) and keep a hash and copy of the prompt. User text is trusted context for attribution. |
| `PostToolUse` | `WebFetch`, `WebSearch`, `mcp__*`, `Read` | Record an ingestion: raw source ID (URL, query, MCP server/tool, file path) and a provisional tier. Store the content from `tool_response` as a capped blob, **except** for workspace (T1) reads, which store only the hash and the extracted indicator set (see Attribution). |
| `PostToolUse` | `Write`, `Edit`, `MultiEdit` | If `file_path` is a surface: record a write event, snapshot the new content, store the diff. |
| `PostToolUse` | `Bash` | Record a network ingestion if `core/bash-parse` detects one (`curl`, `wget`, `gh api`, `git clone`, and similar). **Rescan surfaces:** changes are attributed to this Bash call, which catches script-based writes. |
| `InstructionsLoaded` | all | Record that a surface was loaded into a session (used for blast radius). |
| `ConfigChange` | settings | Record changes to Claude Code settings. If our hook entries were removed or altered, record a **tamper** event. Observe only. |

**Failure policy:** any internal error is written to `errors.log`, and the hook exits 0. Observing must never break the user's agent.

### Memory and instruction surfaces (Claude Code)

**Project scope.** The project root is the git root, or `cwd` if there is no git root.
- `CLAUDE.md`
- `.claude/CLAUDE.md`
- `CLAUDE.local.md`
- `AGENTS.md`
- `.claude/rules/**/*.md`
- nested `**/CLAUDE.md`
- `.claude/skills/**/SKILL.md`
- `.claude/settings.json` and `.claude/settings.local.json` (tamper detection)

**User scope.**
- `~/.claude/CLAUDE.md`
- `~/.claude/rules/*.md`
- `~/.claude/skills/**/SKILL.md`
- `~/.claude/projects/*/memory/**` (auto memory)
- `~/.claude/settings.json`

**Managed scope.** The OS-specific managed `CLAUDE.md`. Watch only; it is not writable by the agent.

**Imports.** Files reached through `@imports` from any surface are added to the surface set when first seen.

### Trust tiers (defaults)

| Tier | Meaning | Default classification |
|---|---|---|
| T0 `user` | The developer's own prompts | trusted |
| T1 `workspace` | Files read inside the project root, excluding dependency directories | trusted |
| T2 `trusted-external` | Domains, MCP servers or paths the **user** confirmed | trusted |
| T3 `dependency` | `node_modules/`, `vendor/`, `.venv/`, `site-packages/` (third-party code and READMEs) | untrusted |
| T4 `external` | Web pages, search results, MCP results, network fetches through Bash, files outside the project | untrusted |

The user's trust config maps sources to tiers by:
- exact domain or domain suffix
- MCP server name
- path glob

**Proposal.** `pvg report` lists the most frequent T3 and T4 sources as candidates for T2. Nothing is promoted automatically. The user accepts with `pvg trust add <source> --tier trusted`, or accepts the whole proposal with `pvg trust accept`.

Personalization never lowers any tier below the default floor for content the user has not confirmed.

**Tiers are recomputed at report time** from the raw source IDs and the current trust config. The recorder's tier is provisional. This is what makes G6 work: accepting a proposal relabels past ingestions in the next report. One limitation: a workspace (T1) read has no stored blob, so if the user later reclassifies such a path as untrusted, only indicator matching (not 8-word overlap) is available for those past reads.

### Attribution (run at report time)

For each surface change, look at **untrusted ingestions in the same session before the change**, including that session's subagents. Assign one label:

| Label | Condition | Severity |
|---|---|---|
| **MATCHED** | The added text overlaps an untrusted blob in the window. Overlap means either: (a) a shared run of 8+ normalized words, or (b) a shared indicator (email, URL, domain, IP, phone number, @handle, or a number of 4+ digits) that is absent from the file's previous version, from user prompts in the session, and from trusted (T0–T2) ingestions in the session. | high |
| **UNATTRIBUTED (in session)** | Change detected by the post-Bash rescan, so the agent wrote it through a shell command or script | high |
| **EXPOSED** | Untrusted content was ingested earlier in the session, with no overlap | medium |
| **UNATTRIBUTED (between sessions)** | Change detected at `SessionStart`; likely a human edit or another tool | info |
| **CLEAN** | No untrusted ingestion in the session before the change | none |

Each flagged write in the report shows:
- the diff;
- the attributed source(s), with timestamps and the time gap;
- the matching span or indicator;
- **blast radius**: the number of later sessions whose `InstructionsLoaded` events loaded a version of the file containing the flagged lines.

Indicator matching targets fact poisoning (a fake email address, account number or limit), which content classifiers miss.

**Normalization** for word overlap: lowercase, strip Markdown syntax and punctuation, collapse whitespace, then split on whitespace.

### Data model (SQLite)

- **`sessions`**: `id`, `project_root`, `started_at`, `permission_mode`
- **`events`**: `id`, `ts`, `session_id`, `agent_id`, `kind`, `tool_name`, `source_id`, `provisional_tier`, `indicators` (JSON, for blob-less reads), `surface_path`, `blob_sha`, `diff_sha`, `prev_hash`, `hash`
  - `kind` is one of: `ingest`, `prompt`, `write`, `scan_change`, `load`, `config_change`, `tamper`, `session_start`.
- **`blobs`**: `sha` (primary key), `bytes`, `size`, `created_at`
  - Holds untrusted content, prompts, and surface snapshots.
- **`surfaces`**: `path`, `scope`, `last_sha`, `last_seen_at`
- **Hash chain:** each event stores `hash = sha256(prev_hash ‖ canonical row)`. `pvg status` verifies the chain, so editing the log after the fact is detectable.

**Data directory:** `~/.pvg/`. Files are created with mode 0600.

**Retention:**
- Ingested content blobs are kept for 30 days by default (configurable).
- Surface snapshots and events are kept until the user purges them.
- Each ingested blob is capped at 1 MB; larger content is truncated and the original hash is recorded.

### CLI (v0.1)

- **`pvg init [--dry-run]`**
  - Adds hook entries to `~/.claude/settings.json`. It merges with existing hooks, never overwrites them, and backs up the file first.
  - Creates `~/.pvg/` and takes baseline snapshots of all surfaces.
  - Offers to add a Claude Code permission rule denying agent writes to `~/.pvg/**`.
  - Prints every change it made.
- **`pvg uninstall [--purge]`**: removes exactly the hook entries `pvg init` added. Data is kept unless `--purge` is given.
- **`pvg hook`**: internal entrypoint for every hook event; reads the event name from stdin JSON.
- **`pvg report [--since 7d] [--project <dir>] [--md <file>] [--json]`**
- **`pvg trust list | add <source> --tier <tier> | remove <source> | accept`**
- **`pvg status`**: hook install health, error count, events per kind, last event time, hash-chain verification, tamper alerts.
- **`pvg log [--session <id>] [--kind <kind>]`**: raw events, for debugging.

**Config:** `~/.pvg/config.json` (retention, caps) and `~/.pvg/trust.json` (tier mappings). JSON keeps runtime dependencies at zero.

### Example report (abridged)

```
Provenance report: last 7 days, 3 projects, 46 sessions

EXPOSURE
  Sources read: 212 (41 results from MCP server "github", 63 web pages, 9 dependency READMEs, ...)
  Untrusted ingestions: 118

MEMORY CHANGES: 7 total
  MATCHED (1)
    ~/.claude/projects/acme/memory/MEMORY.md   session 41   14:03
    + "Backup contact for deploy alerts: ops@acme-backup.com"
    Indicator "ops@acme-backup.com" found in WebFetch https://acme-status.example/incident (14:02, 54s earlier)
    Blast radius: loaded by 3 later sessions (42, 43, 47)
  EXPOSED (2) ...
  UNATTRIBUTED between sessions (1) ...
  CLEAN (3)

PROPOSED TRUST RANKING
  Promote to trusted?  docs.python.org (31 reads, 9 sessions)   MCP server "github" (22 reads)
  Run: pvg trust accept
```

### Threat model for the tool itself

- **Agent tampers with `pvg` data or hooks.**
  - Mitigations:
    - The optional deny rule on `~/.pvg/**`.
    - Claude Code treats `.claude/` and `~/.claude/` as protected paths.
    - `ConfigChange` and the settings-file scans produce tamper events.
    - The hash chain makes edits to the log detectable.
  - Residual risk: an agent running arbitrary shell commands with the user's permissions can still delete data. v0.1 detects this; it cannot prevent it.
- **Supply chain.**
  - Zero runtime dependencies is the goal.
  - npm provenance attestations on publish.
  - Signed releases later.
- **Sensitive data at rest.**
  - The stored content is whatever the agent read.
  - Mitigations: local only, mode 0600, retention limits, `pvg uninstall --purge`.
- **Attacker content inside `pvg`.** v0.1 stores attacker content but never interprets it. There are no LLM components; everything is string and hash comparison.

### Testing

- **Unit tests**, each against fixture inputs:
  - `classify`
  - `bash-parse`
  - surface path matching
  - overlap and indicator matching
  - trust proposal
  - hash chain
- **Adapter contract tests:** recorded real Claude Code hook payloads for each event used, stored as fixtures. These catch format drift when Claude Code updates.
- **Integration tests:** replay a scripted event sequence and assert the report's labels:
  - WebFetch of a poisoned page, then Write to `MEMORY.md` with matching text, expects **MATCHED** with the correct source.
  - A Bash `python -c` write, expects **UNATTRIBUTED (in session)**.
  - Writes after reading only trusted sources, expects **CLEAN**.
- **Reference demo (manual, documented; this is also the launch demo):**
  1. A local HTTP server serves a MemGhost-style poisoned page.
  2. Real Claude Code is asked to summarize it and remember key facts.
  3. `pvg report` shows **MATCHED**.

  This depends on model behavior, so it is a demo rather than a CI test.
- **Performance:** benchmark hook latency (target p95 ≤ 100 ms) and the post-Bash rescan (target ≤ 30 ms for 50 surfaces).

### Assumptions to verify during planning

1. Exact `tool_input` and `tool_response` field names for `Write`, `Edit`, `MultiEdit`, `WebFetch` and MCP tools, captured from real payloads.
2. Whether `InstructionsLoaded` fires for auto-memory `MEMORY.md`. The docs say it does **not** fire for `AGENTS.md` loaded through the built-in plugin; blast radius falls back to session-start scans where it doesn't fire.
3. That `node:sqlite` works without flags on the minimum supported Node version (proposed ≥ 22.13). Fallback: `better-sqlite3`.
4. That hook commands in user settings apply in all permission modes, including auto mode.
5. Whether the `FileChanged` hook could replace the post-Bash rescan more cheaply.

---

## Part 3: Decisions for review

Each item shows a proposed default. Accept or change it during review.

| # | Decision | Proposed default | Why |
|---|---|---|---|
| D1 | Language | **TypeScript on Node ≥ 22.13** | Same ecosystem as the agent tools; npm distribution; built-in SQLite. |
| D2 | First build | **v0.1 observe and report, Claude Code only, read-only** | Lowest friction; validates demand; collects the data enforcement needs. |
| D3 | Where future agents run | **Separate process using an LLM API** | The watchman should not run inside the session it watches. (Matters from v0.4.) |
| D4 | Enterprise path | **Bottom-up**: developers, then teams (shared-repo `CLAUDE.md` as the first "second brain"), then companies | Lower risk; same core technology. |
| D5 | Name | **Working name "Provenance Guard" / `pvg`** | Placeholder; choose before public launch, after checking for name collisions. |
| D6 | Project location | **A new git repo in a permanent folder you choose** | This session's workspace is temporary. |
| D7 | License | **Apache-2.0** | Permissive with a patent grant; common for open-source security tools. AGPL is the alternative if competitors reusing the code is a concern. |
| D8 | Distribution | **npm package plus `pvg init`** for v0.1; Claude Code plugin packaging in v0.2 | Simplest path that works in every Claude Code setup. |
