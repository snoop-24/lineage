import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempDir(prefix = "pvg-test-"): { path: string; cleanup: () => void } {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
