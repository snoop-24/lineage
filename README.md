# Lineage (`lineage`)

**Memory provenance for coding agents.** Coding agents read untrusted content (GitHub issues, web pages, emails) and save what they learn into memory files they trust forever. Lineage records where every change to your agent's memory came from, and shows which changes trace back to untrusted sources.

> v0.1 is **observe and report** for Claude Code. It never blocks your agent's work and never sends anything anywhere.

## Install (from source, for now)

Requires Node.js 22.13 or later.

```bash
npm install && npm run build && npm link
lineage init --protect-data      # adds hooks and a deny rule protecting ~/.lineage to ~/.claude/settings.json (backed up first)
```

Use Claude Code as usual, then:

```bash
lineage init [--dry-run] [--protect-data]       # install (or repeat to reset)
lineage report [--since 7d] [--project <dir>] [--md <file>] [--json]
lineage trust list | add <source> --tier <tier> | remove <source> | accept
lineage status                                  # install health, log integrity, errors
lineage log [--session <id>] [--kind <kind>] [--limit <n>]
lineage uninstall [--purge]                     # removes exactly what init added; --purge also deletes data
```

## What the labels mean

| Label | Meaning |
|---|---|
| MATCHED | The new memory text overlaps content from an untrusted source read earlier in the session |
| UNATTRIBUTED (in session) | Memory changed through a shell command, script or MCP tool during a session |
| EXPOSED | Untrusted content was read earlier in the session, with no overlap found |
| UNATTRIBUTED (between sessions) | Changed outside any session (often a human edit) |
| CLEAN | No untrusted content was read before the change |

Changes to Claude Code settings files (`.claude/settings.json`, `.claude/settings.local.json`) are listed separately under SETTINGS CHANGES; entries marked `!` touch hooks or remove lineage's deny rule.

## Privacy

Everything stays on your machine in `~/.lineage/` (files are mode 0600). Lineage makes no network calls, uses no AI models and has no telemetry.

Lineage stores locally: your prompts, snapshots of memory and instruction files (current and previous versions), and Bash command strings. These are kept until `lineage uninstall --purge`. Only content read from untrusted sources (web pages, MCP results, network fetches, files outside your project other than your own files under `~/.claude` and `CLAUDE.md` files in folders above the project) expires after 30 days. `errors.log` holds error messages only, with no prompt or tool content. The timestamped settings.json backups that init and uninstall write remain after `lineage uninstall --purge`; delete them manually if needed.

## Limitations (v0.1)

- **Claude Code only;** macOS and Linux.
- **No blocking:** pausing suspicious writes comes in v0.2.
- **Script writes are caught only after the Bash command or MCP call that made them finishes.**
- **Files that already existed when Lineage first saw them are baselined silently.**
- **Indicator matching can produce occasional false matches** on common values.
- **The event log detects edits to past entries, but not deletion of the newest entries** (no external anchor).
- **`--protect-data` blocks Claude's edit tools, not shell commands** that write to `~/.lineage`.
- **Sessions already running when you install are picked up on their next event.** A memory file outside `~/.claude/projects/*/memory/` that changed before that event becomes the new baseline, so that one change is not reported.
- **Attribution only looks at untrusted content read earlier in the same session;** content read in an earlier session is not linked to a later change.
- **Files inside the project, including repos cloned into it, are trusted by default.** Demote them with `lineage trust add '/abs/path/**' --tier untrusted`.
- **Outside the project, only your own memory and instruction files are trusted:** `~/.claude/CLAUDE.md`, `~/.claude/rules/`, `~/.claude/skills/`, `~/.claude/projects/*/memory/`, and `CLAUDE.md` / `CLAUDE.local.md` in folders above the project. A `CLAUDE.md`, `AGENTS.md` or `SKILL.md` anywhere else, including inside `node_modules`, is untrusted.
- **Not yet verified against a real Claude Code session:** the PostToolUse payload field names and the live demo.

## License

Apache-2.0
