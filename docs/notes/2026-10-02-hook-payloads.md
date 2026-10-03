# Claude Code hook payloads (partial capture)

Status: PARTIAL. One headless `claude -p` run was made on 2026-10-03. It failed to authenticate before any model call, so only the pre-tool events were captured. PostToolUse was never exercised. Fixtures are in `test/fixtures/claude-code/`.

## Claude Code version

`claude --version` -> `2.1.263 (Claude Code)`. `claude --help` lists `--settings <file-or-json>`, so the separate settings file approach worked and the user's real `~/.claude/settings.json` was not touched.

## Capture run and auth failure

The brief's Step 5 command was run once (sandbox at `.capture/sandbox`, `--settings scripts/capture-settings.json`, `--permission-mode acceptEdits`). Output:

```
Failed to authenticate: OAuth session expired and could not be refreshed
```

`claude auth status` reported `"loggedIn": false, "authMethod": "none"`. The run was not retried and no risky flags were used. `capture.jsonl` had 3 lines. No tool ran (sandbox `CLAUDE.md` unchanged, no `notes.md`).

Events captured: `SessionStart`, `InstructionsLoaded`, `UserPromptSubmit`. Fixtures: `SessionStart.json`, `InstructionsLoaded.json`, `UserPromptSubmit.json`.

## Common fields observed

Present on all three captured events: `session_id`, `transcript_path`, `cwd`, `hook_event_name`.

Per event, the exact keys:

- `SessionStart`: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `source` (value `"startup"`). No `permission_mode`.
- `InstructionsLoaded`: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `file_path`, `memory_type`, `load_reason`. No `permission_mode`.
- `UserPromptSubmit`: `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode` (value `"acceptEdits"`), `hook_event_name`, `prompt`.

`permission_mode` is absent on SessionStart (and on InstructionsLoaded); it appears on UserPromptSubmit. No `agent_id` key appeared on any captured event.

Note: the fixtures replace the home directory with `/home/tester`, including the "-"-encoded form inside `transcript_path` (`-home-tester-IH-guard-research--capture-sandbox`).

## Per tool (Write, Edit, Read, WebFetch, Bash)

UNVERIFIED. No PostToolUse event was captured. All of the following names are UNVERIFIED, pending a re-capture after login:

- `tool_name`, `tool_input` and `tool_response` on PostToolUse
- `tool_input.file_path` (Write, Edit, Read)
- `tool_input.url` (WebFetch)
- `tool_input.query` (WebSearch)
- `tool_input.command` (Bash)
- `tool_input.notebook_path` (NotebookEdit)
- the type and shape of `tool_response` for each tool

## InstructionsLoaded (spec assumption 2)

The event exists in 2.1.263 and fired once at session start, for the sandbox project `CLAUDE.md` only (`README.md` was not loaded as instructions). Observed values:

- `file_path`: `/home/tester/IH-guard-research/.capture/sandbox/CLAUDE.md` (absolute path)
- `memory_type`: `"Project"` (capitalised)
- `load_reason`: `"session_start"`

Other `memory_type` and `load_reason` values were not observed (for example for user-level memory, nested files or `@include`).

## ConfigChange

Registered in the settings file but did not fire in this run (expected: no settings changed mid-session).

## Differences from this plan

Names Task 10 uses, checked against the captured fixtures:

- `prompt`: matches (UserPromptSubmit).
- `file_path`: matches (InstructionsLoaded).
- `memory_type`: matches as a key name. Value is capitalised: `"Project"`, not `"project"`. Compare case-insensitively or use the captured casing.
- `load_reason`: matches as a key name (value `"session_start"`).
- `agent_id`: not present on any captured event (absent, not renamed). Treat as optional.
- `tool_input.file_path`, `tool_input.url`, `tool_input.query`, `tool_input.command`, `tool_input.notebook_path`: UNVERIFIED (no PostToolUse captured).

Extra keys seen that the plan does not mention: `prompt_id` and `permission_mode` (UserPromptSubmit), `source` (SessionStart).

## Open items

1. Re-capture PostToolUse (WebFetch, Read, Bash, Edit, Write, and ideally WebSearch/NotebookEdit/MCP) after the user logs in to Claude Code, then re-run `scripts/split-capture.mjs` and fill in the "Per tool" and "Differences" sections. Until then Task 10's PostToolUse names are unconfirmed.
2. Spec assumption 4: hooks fire in auto mode. Not verified in v0.1.
3. Spec assumption 5: the `FileChanged` hook as a cheaper rescan. Not verified in v0.1.
