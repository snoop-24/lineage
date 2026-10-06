# Claude Code hook payloads

Status: COMPLETE for the core tools. A first headless run (2026-10-03, Claude Code 2.1.263) failed to authenticate and captured only the pre-tool events. A second run (2026-10-05, after login) captured every core event. Fixtures are in `test/fixtures/claude-code/`, with the home directory replaced by `/home/tester`.

## Claude Code version

`claude --version` -> `2.1.290 (Claude Code)` for the second run. The run used `--settings scripts/capture-settings.json` in the sandbox `.capture/sandbox`, so the user's real `~/.claude/settings.json` was not touched. Permission mode was `acceptEdits`.

## Events captured

`SessionStart`, `InstructionsLoaded`, `UserPromptSubmit`, and `PostToolUse` for `WebFetch`, `Read` (twice: README.md and CLAUDE.md, the second read made by the agent before its Edit), `Bash`, `Edit` and `Write`: 9 lines.

## Common fields observed

- All events: `session_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `hook_event_name`.
- `SessionStart`: plus `source` (`"startup"`). No `permission_mode`.
- `InstructionsLoaded`: plus `file_path`, `memory_type`, `load_reason`. No `permission_mode`.
- `UserPromptSubmit`: plus `prompt_id`, `permission_mode`, `prompt`.
- `PostToolUse`: plus `prompt_id`, `permission_mode`, `effort`, `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms`.

No `agent_id` appeared on any event (it is optional in the adapter). `scratchpad_dir` and `effort` are new since 2.1.263 and are ignored by pvg.

## Per tool

`tool_response` is an object for every tool. pvg extracts text by walking every string in it, so the exact shape does not matter for ingest.

| Tool | `tool_input` keys | `tool_response` keys |
|---|---|---|
| Read | `file_path` | `type` (`"text"`), `file` { `filePath`, `content`, `numLines`, `startLine`, `totalLines` } |
| WebFetch | `url`, `prompt` | `bytes`, `code`, `codeText`, `result` (the model's summary, not the raw page), `durationMs`, `url` |
| Bash | `command`, `description` | `stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected` |
| Edit | `file_path`, `old_string`, `new_string`, `replace_all` | `filePath`, `oldString`, `newString`, `originalFile`, `structuredPatch`, `userModified`, `replaceAll` |
| Write | `file_path`, `content` | `type` (`"create"`), `filePath`, `content`, `structuredPatch`, `originalFile`, `userModified` |

Not captured: WebSearch (`tool_input.query`), NotebookEdit (`tool_input.notebook_path`), MultiEdit and MCP tools. Their names remain as documented, and the hook logs `unrecognized PostToolUse payload` to `errors.log` if one does not match.

## InstructionsLoaded

Fired once at session start for the sandbox `CLAUDE.md`: `file_path` absolute, `memory_type` `"Project"` (capitalised), `load_reason` `"session_start"`. Other values were not observed.

## ConfigChange

Registered but did not fire (expected: no settings changed mid-session).

## Differences from the plan

None for the names pvg uses: `tool_input.file_path`, `tool_input.url`, `tool_input.command`, `prompt`, `file_path`, `memory_type`, `load_reason` all match. `test/adapter.test.ts` checks each captured payload's extracted source and text.

One behaviour to note: WebFetch's `tool_response.result` is the model's summary of the page, not the raw page text. A planted fact usually survives summarisation (the demo depends on that), but exact 8-word overlaps are less likely than with `curl` through Bash, which returns the raw page in `stdout`.

## Open items

1. WebSearch, NotebookEdit, MultiEdit and MCP payloads are not captured.
2. Spec assumption 4: hooks fire in auto mode. Not verified (this run used `acceptEdits`).
3. Spec assumption 5: the `FileChanged` hook as a cheaper rescan. Not verified.
4. Whether 2.1.290 loads `AGENTS.md` as instructions was not checked; pvg does not trust `AGENTS.md` above the project.
