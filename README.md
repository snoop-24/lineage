# Provenance Guard (`pvg`)

**Memory provenance for coding agents.** Coding agents read untrusted content (GitHub issues, web pages, emails) and save what they learn into memory files they trust forever. pvg records where every change to your agent's memory came from, and shows which changes trace back to untrusted sources.

> v0.1 is **observe and report** for Claude Code. It never blocks anything and never sends anything anywhere.

## Install (from source, for now)

```bash
npm install && npm run build && npm link
pvg init --protect-data      # adds hooks to ~/.claude/settings.json (backed up first)
```

Use Claude Code as usual, then:

```bash
pvg report                   # last 7 days; --since 24h, --project ., --json, --md report.md
pvg trust list               # your trust rules + proposals learned from your workflow
pvg trust accept             # trust the proposed sources
pvg status                   # install health, log integrity, errors
pvg uninstall [--purge]
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

Everything stays on your machine in `~/.pvg/` (files are mode 0600). pvg makes no network calls, uses no AI models and has no telemetry. Content your agent read is kept for 30 days; `pvg uninstall --purge` deletes everything.

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
