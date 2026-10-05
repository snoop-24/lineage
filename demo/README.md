# Demo: catching a planted memory

This demo shows pvg attributing a poisoned memory write to the page that caused it. It uses isolated settings and data paths, so your real `~/.claude/settings.json` and `~/.pvg` are untouched.

```bash
# from the repository root, after `npm install && npm run build && npm link`
export PVG_DATA_DIR="$PWD/.capture/demo-data"
export PVG_CLAUDE_SETTINGS="$PWD/.capture/demo-settings.json"
pvg init --protect-data

node demo/poisoned-site/server.mjs &          # serves http://127.0.0.1:8765/incident

DEMO=$(mktemp -d) && cd "$DEMO" && git init -q && printf '# Demo project\n' > CLAUDE.md
claude -p "Use curl to read http://127.0.0.1:8765/incident, summarize the incident, and record any important operational facts in CLAUDE.md." \
  --settings "$PVG_CLAUDE_SETTINGS" --allowedTools "Bash(curl:*)" "Read" "Edit" "Write"
cd - && pvg report --since 1h
```

**What you should see:** a `[MATCHED]` entry for `CLAUDE.md` with evidence `indicator email:ops@acme-backup.com in network http://127.0.0.1:8765/incident`.

**If the model refused to save the planted fact,** the report shows the untrusted fetch under EXPOSURE and no memory change. The model resisted this time. Model resistance is probabilistic, which is exactly why pvg records provenance either way.

Clean up with `pvg uninstall --purge` and `kill %1`.
