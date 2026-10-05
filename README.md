# Provenance Guard (`pvg`)

**Memory provenance for coding agents.** Coding agents read untrusted content (GitHub issues, web pages, emails) and save what they learn into memory files they trust forever. pvg records where every change to your agent's memory came from, and shows which changes trace back to untrusted sources.

> v0.1 is **observe and report** for Claude Code. It never blocks your agent's work and never sends anything anywhere.

## Install (from source, for now)

Requires Node.js 22.13 or later.

```bash
npm install && npm run build && npm link
pvg init --protect-data      # adds hooks and a deny rule protecting ~/.pvg to ~/.claude/settings.json (backed up first)
```

Use Claude Code as usual, then:

```bash
pvg init [--dry-run] [--protect-data]       # install (or repeat to reset)
pvg report [--since 7d] [--project <dir>] [--md <file>] [--json]
pvg trust list | add <source> --tier <tier> | remove <source> | accept
pvg status                                  # install health, log integrity, errors
pvg log [--session <id>] [--kind <kind>] [--limit <n>]
pvg uninstall [--purge]                     # removes exactly what init added; --purge also deletes data
```

## What the labels mean

| Label | Meaning |
|---|---|
| MATCHED | The new memory text overlaps content from an untrusted source read earlier in the session |
| UNATTRIBUTED (in session) | Memory changed through a shell command or script during a session |
| EXPOSED | Untrusted content was read earlier in the session, with no overlap found |
| UNATTRIBUTED (between sessions) | Changed outside any session (often a human edit) |
| CLEAN | No untrusted content was read before the change |

## Privacy

Everything stays on your machine in `~/.pvg/` (files are mode 0600). pvg makes no network calls, uses no AI models and has no telemetry.

pvg stores locally: your prompts, snapshots of memory and instruction files (current and previous versions), and Bash command strings. These are kept until `pvg uninstall --purge`. Only content read from untrusted sources (web pages, MCP results, network fetches, files outside your project) expires after 30 days. The timestamped settings.json backups that init and uninstall write remain after `pvg uninstall --purge`; delete them manually if needed.

## Limitations (v0.1)

- **Claude Code only;** macOS and Linux.
- **No blocking:** pausing suspicious writes comes in v0.2.
- **Script writes are caught only after the Bash command that made them finishes.**
- **Files that already existed when pvg first saw them are baselined silently.**
- **Indicator matching can produce occasional false matches** on common values.
- **The event log detects edits to past entries, but not deletion of the newest entries** (no external anchor).
- **`--protect-data` blocks Claude's edit tools, not shell commands** that write to `~/.pvg`.

## License

Apache-2.0
