#!/usr/bin/env node
import { VERSION } from "./version.ts";
import { hookCommand } from "./cli/hook.ts";
import { initCommand, uninstallCommand } from "./cli/install.ts";
import { reportCommand } from "./cli/report.ts";
import { trustCommand } from "./cli/trust.ts";
import { statusCommand } from "./cli/status.ts";
import { logCommand } from "./cli/log.ts";

process.umask(0o077);

type Command = (args: string[]) => Promise<number>;

const HELP = `lineage — memory provenance for coding agents (v${VERSION}, observe and report)

Usage:
  lineage init [--dry-run] [--protect-data]   Install Claude Code hooks (backs up settings first)
  lineage uninstall [--purge]                 Remove lineage hooks (and, with --purge, all lineage data)
  lineage report [--since 7d] [--project <dir>] [--md <file>] [--json]
  lineage trust list | add <source> --tier <tier> | remove <source> | accept
  lineage status                              Install health, log integrity, errors
  lineage log [--session <id>] [--kind <kind>] [--limit <n>]
`;

const commands: Record<string, Command> = {
  hook: hookCommand,
  init: initCommand,
  uninstall: uninstallCommand,
  report: reportCommand,
  trust: trustCommand,
  status: statusCommand,
  log: logCommand,
};

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!Object.hasOwn(commands, cmd)) {
    process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
    return 2;
  }
  const run = commands[cmd]!;
  return run(rest);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
