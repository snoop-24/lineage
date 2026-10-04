#!/usr/bin/env node
import { VERSION } from "./version.ts";
import { hookCommand } from "./cli/hook.ts";

process.umask(0o077);

type Command = (args: string[]) => Promise<number>;

const HELP = `pvg — memory provenance for coding agents (v${VERSION}, observe and report)

Usage:
  pvg init [--dry-run] [--protect-data]   Install Claude Code hooks (backs up settings first)
  pvg uninstall [--purge]                 Remove pvg hooks (and, with --purge, all pvg data)
  pvg report [--since 7d] [--project <dir>] [--md <file>] [--json]
  pvg trust list | add <source> --tier <tier> | remove <source> | accept
  pvg status                              Install health, log integrity, errors
  pvg log [--session <id>] [--kind <kind>] [--limit <n>]
`;

const commands: Record<string, Command> = {
  hook: hookCommand,
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
