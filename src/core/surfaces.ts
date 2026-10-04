import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { sha256 } from "./hash.ts";
import type { SurfaceRow } from "./store.ts";

export type SurfaceScope = "project" | "user" | "managed" | "memory" | "import";

export interface SurfaceContext {
  home: string;
  projectRoot: string;
  memoryDir: string | null;
  platform: NodeJS.Platform;
}

export interface SurfaceTarget {
  path: string;
  scope: SurfaceScope;
  trackAbsent: boolean;
}

export interface WalkLimits {
  maxDepth: number;
  maxEntries: number;
}

export const DEFAULT_LIMITS: WalkLimits = { maxDepth: 6, maxEntries: 20_000 };

export const PROJECT_FILES = [
  "CLAUDE.md",
  ".claude/CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  ".claude/settings.json",
  ".claude/settings.local.json",
];

const INSTRUCTION_BASENAMES = new Set(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".venv", "venv", "vendor", "target", ".next", "coverage"]);
const IMPORT_RE = /(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[\w.-]+(?:\/[\w.-]+)*)/g;

export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function managedClaudeMd(platform: NodeJS.Platform): string | null {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/CLAUDE.md";
  if (platform === "linux") return "/etc/claude-code/CLAUDE.md";
  return null;
}

export function classifySurfacePath(filePath: string, ctx: SurfaceContext): SurfaceScope | null {
  const p = resolve(filePath);
  const claudeHome = join(ctx.home, ".claude");
  const projectsDir = join(claudeHome, "projects");
  if (ctx.memoryDir && isInside(p, ctx.memoryDir)) return "memory";
  if (isInside(p, projectsDir) && relative(projectsDir, p).split("/")[1] === "memory") return "memory";
  if (p === managedClaudeMd(ctx.platform)) return "managed";
  if (p === join(claudeHome, "CLAUDE.md") || p === join(claudeHome, "settings.json")) return "user";
  if (isInside(p, join(claudeHome, "rules")) && p.endsWith(".md")) return "user";
  if (isInside(p, join(claudeHome, "skills")) && basename(p) === "SKILL.md") return "user";
  if (isInside(p, ctx.projectRoot)) {
    const rel = relative(ctx.projectRoot, p);
    if (PROJECT_FILES.includes(rel)) return "project";
    if (rel.startsWith(".claude/rules/") && p.endsWith(".md")) return "project";
    if (/(^|\/)\.claude\/skills\/.+\/SKILL\.md$/.test(rel)) return "project";
  }
  if (INSTRUCTION_BASENAMES.has(basename(p))) return "project";
  return null;
}

export function readSurface(path: string, capBytes = 1_048_576): { sha: string; text: string } | null {
  try {
    if (!statSync(path).isFile()) return null;
  } catch {
    return null;
  }
  const buf = readFileSync(path);
  const text = (buf.length > capBytes ? buf.subarray(0, capBytes) : buf).toString("utf8");
  return { sha: sha256(Buffer.from(text, "utf8")), text };
}

export function parseImports(text: string, fromFile: string, home: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(IMPORT_RE)) {
    const raw = m[1];
    if (!raw || (!raw.includes("/") && !raw.endsWith(".md"))) continue;
    const p = raw.startsWith("~/") ? join(home, raw.slice(2)) : isAbsolute(raw) ? raw : resolve(dirname(fromFile), raw);
    out.add(resolve(p));
  }
  return [...out];
}

function walk(root: string, limits: WalkLimits, onFile: (path: string) => void): void {
  if (!existsSync(root)) return;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let seen = 0;
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) break;
    let entries;
    try {
      entries = readdirSync(next.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      seen += 1;
      if (seen > limits.maxEntries) return;
      const full = join(next.dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && next.depth < limits.maxDepth) stack.push({ dir: full, depth: next.depth + 1 });
      } else if (e.isFile()) {
        onFile(full);
      }
    }
  }
}

export function listFiles(dir: string, limits: WalkLimits = DEFAULT_LIMITS): string[] {
  const out: string[] = [];
  walk(dir, limits, (p) => out.push(p));
  return out.sort();
}

export function userSurfaceTargets(home: string, limits: WalkLimits = DEFAULT_LIMITS): SurfaceTarget[] {
  const claudeHome = join(home, ".claude");
  const out: SurfaceTarget[] = [
    { path: join(claudeHome, "CLAUDE.md"), scope: "user", trackAbsent: true },
    { path: join(claudeHome, "settings.json"), scope: "user", trackAbsent: true },
  ];
  for (const f of listFiles(join(claudeHome, "rules"), limits)) {
    if (f.endsWith(".md")) out.push({ path: f, scope: "user", trackAbsent: false });
  }
  for (const f of listFiles(join(claudeHome, "skills"), limits)) {
    if (basename(f) === "SKILL.md") out.push({ path: f, scope: "user", trackAbsent: false });
  }
  return out;
}

function projectTargets(ctx: SurfaceContext, limits: WalkLimits): SurfaceTarget[] {
  const out: SurfaceTarget[] = PROJECT_FILES.map((rel) => ({ path: join(ctx.projectRoot, rel), scope: "project", trackAbsent: true }));
  for (const f of listFiles(join(ctx.projectRoot, ".claude", "rules"), limits)) {
    if (f.endsWith(".md")) out.push({ path: f, scope: "project", trackAbsent: false });
  }
  for (const f of listFiles(join(ctx.projectRoot, ".claude", "skills"), limits)) {
    if (basename(f) === "SKILL.md") out.push({ path: f, scope: "project", trackAbsent: false });
  }
  return out;
}

function memoryTargets(ctx: SurfaceContext, limits: WalkLimits): SurfaceTarget[] {
  if (!ctx.memoryDir) return [];
  return [
    { path: join(ctx.memoryDir, "MEMORY.md"), scope: "memory", trackAbsent: true },
    ...listFiles(ctx.memoryDir, limits).map((p): SurfaceTarget => ({ path: p, scope: "memory", trackAbsent: false })),
  ];
}

function dedupe(targets: SurfaceTarget[]): SurfaceTarget[] {
  const m = new Map<string, SurfaceTarget>();
  for (const t of targets) {
    const p = resolve(t.path);
    const existing = m.get(p);
    if (!existing) m.set(p, { ...t, path: p });
    else if (t.trackAbsent) existing.trackAbsent = true;
  }
  return [...m.values()];
}

export function discoverSurfaces(ctx: SurfaceContext, limits: WalkLimits = DEFAULT_LIMITS): SurfaceTarget[] {
  const targets: SurfaceTarget[] = [...projectTargets(ctx, limits)];
  walk(ctx.projectRoot, limits, (p) => {
    if (INSTRUCTION_BASENAMES.has(basename(p))) targets.push({ path: p, scope: "project", trackAbsent: false });
  });
  targets.push(...userSurfaceTargets(ctx.home, limits), ...memoryTargets(ctx, limits));
  const managed = managedClaudeMd(ctx.platform);
  if (managed && existsSync(managed)) targets.push({ path: managed, scope: "managed", trackAbsent: false });
  const base = dedupe(targets);
  const imports: SurfaceTarget[] = [];
  for (const t of base) {
    if (!t.path.endsWith(".md")) continue;
    const s = readSurface(t.path);
    if (!s) continue;
    for (const imp of parseImports(s.text, t.path, ctx.home)) {
      if (existsSync(imp)) imports.push({ path: imp, scope: "import", trackAbsent: false });
    }
  }
  return dedupe([...base, ...imports]);
}

export function rescanTargets(ctx: SurfaceContext, known: SurfaceRow[], limits: WalkLimits = DEFAULT_LIMITS): SurfaceTarget[] {
  const fromStore = known
    .filter(
      (r) =>
        ((r.scope === "project" || r.scope === "import") && r.projectRoot === ctx.projectRoot) ||
        r.scope === "user" ||
        (r.scope === "memory" && ctx.memoryDir !== null && isInside(r.path, ctx.memoryDir)),
    )
    .map((r): SurfaceTarget => ({ path: r.path, scope: r.scope as SurfaceScope, trackAbsent: false }));
  return dedupe([...projectTargets(ctx, limits), ...userSurfaceTargets(ctx.home, limits), ...memoryTargets(ctx, limits), ...fromStore]);
}
