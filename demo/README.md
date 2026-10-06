# Demo: catching a planted memory

This demo shows pvg attributing a poisoned memory write to the page that caused it. It uses isolated settings and data paths, so your real `~/.claude/settings.json` and `~/.pvg` are untouched.

## Try it yourself (interactive)

```bash
demo/sandbox.sh                                       # your default model
demo/sandbox.sh --model claude-haiku-4-5-20251001     # a model more likely to fall for the page
```

This sets up an isolated pvg install, starts the poisoned page and opens Claude Code in a throwaway project. Ask it to read `http://127.0.0.1:8765/incident` and record important facts in `CLAUDE.md`, then type `/exit`: the script prints the new `CLAUDE.md` and pvg's report, then deletes the sandbox. Needs Node 24 and a logged-in `claude`; no `npm link` required.

## Scripted run

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

**What you should see:** a `[MATCHED]` entry for `CLAUDE.md` (printed in full with the temp project path) with evidence `indicator email:ops@acme-backup.com in network http://127.0.0.1:8765/incident`.

**If the model refused to save the planted fact,** which strong models often do, you will usually still see the incident summary it wrote labeled `[MATCHED]`, with evidence such as `indicator number:4721`: the note's content came from the untrusted page even though the planted contact did not. To watch the planted fact land, add `--model claude-haiku-4-5-20251001` to the `claude -p` command. Model resistance is probabilistic, which is exactly why pvg records provenance either way.

Clean up by running **in the same shell** (with `PVG_DATA_DIR` and `PVG_CLAUDE_SETTINGS` still exported):

```bash
pvg uninstall --purge
rm -f "$PVG_CLAUDE_SETTINGS"
kill %1
```

If you run `pvg uninstall --purge` in a different shell without the env vars exported, it will act on your real `~/.pvg` and `~/.claude/settings.json`.
