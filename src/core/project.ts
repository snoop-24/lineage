import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function findProjectRoot(cwd: string): string {
  const start = resolve(cwd);
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}
