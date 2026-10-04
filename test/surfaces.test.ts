import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  classifySurfacePath, discoverSurfaces, parseImports, readSurface, rescanTargets, type SurfaceContext,
} from "../src/core/surfaces.ts";
import { tempDir } from "./helpers.ts";

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function fixture() {
  const t = tempDir();
  const home = join(t.path, "home");
  const proj = join(t.path, "proj");
  const memoryDir = join(home, ".claude", "projects", "p", "memory");
  mkdirSync(join(proj, ".git"), { recursive: true });
  put(join(proj, "CLAUDE.md"), "# P\nSee @docs/guide.md and email ops@x.example\n");
  put(join(proj, "docs", "guide.md"), "guide\n");
  put(join(proj, "packages", "a", "CLAUDE.md"), "nested\n");
  put(join(proj, "node_modules", "lib", "CLAUDE.md"), "dependency\n");
  put(join(proj, ".claude", "rules", "style.md"), "style\n");
  put(join(proj, ".claude", "skills", "deploy", "SKILL.md"), "skill\n");
  put(join(home, ".claude", "CLAUDE.md"), "user\n");
  put(join(home, ".claude", "rules", "global.md"), "global\n");
  put(join(memoryDir, "MEMORY.md"), "- fact\n");
  put(join(memoryDir, "topic.md"), "topic\n");
  const ctx: SurfaceContext = { home, projectRoot: proj, memoryDir, platform: "linux" };
  return { t, home, proj, memoryDir, ctx };
}

test("classifySurfacePath", () => {
  const { t, home, proj, memoryDir, ctx } = fixture();
  try {
    assert.equal(classifySurfacePath(join(proj, "CLAUDE.md"), ctx), "project");
    assert.equal(classifySurfacePath(join(proj, "packages", "a", "CLAUDE.md"), ctx), "project");
    assert.equal(classifySurfacePath(join(proj, ".claude", "rules", "style.md"), ctx), "project");
    assert.equal(classifySurfacePath(join(proj, ".claude", "skills", "deploy", "SKILL.md"), ctx), "project");
    assert.equal(classifySurfacePath(join(proj, ".claude", "settings.json"), ctx), "project");
    assert.equal(classifySurfacePath(join(proj, "src", "index.ts"), ctx), null);
    assert.equal(classifySurfacePath(join(home, ".claude", "CLAUDE.md"), ctx), "user");
    assert.equal(classifySurfacePath(join(home, ".claude", "rules", "global.md"), ctx), "user");
    assert.equal(classifySurfacePath(join(memoryDir, "topic.md"), ctx), "memory");
    assert.equal(classifySurfacePath(join(home, ".claude", "projects", "other", "memory", "x.md"), ctx), "memory");
    assert.equal(classifySurfacePath("/etc/claude-code/CLAUDE.md", ctx), "managed");
    assert.equal(classifySurfacePath("/elsewhere/AGENTS.md", ctx), "project");
  } finally {
    t.cleanup();
  }
});

test("discoverSurfaces finds every surface, skips dependencies, follows imports", () => {
  const { t, home, proj, memoryDir, ctx } = fixture();
  try {
    const found = new Map(discoverSurfaces(ctx).map((s) => [s.path, s]));
    for (const p of [
      join(proj, "CLAUDE.md"),
      join(proj, "packages", "a", "CLAUDE.md"),
      join(proj, ".claude", "rules", "style.md"),
      join(proj, ".claude", "skills", "deploy", "SKILL.md"),
      join(home, ".claude", "CLAUDE.md"),
      join(home, ".claude", "rules", "global.md"),
      join(memoryDir, "MEMORY.md"),
      join(memoryDir, "topic.md"),
    ]) {
      assert.ok(found.has(p), `missing ${p}`);
    }
    assert.equal(found.get(join(proj, "docs", "guide.md"))?.scope, "import");
    assert.equal(found.get(join(proj, "AGENTS.md"))?.trackAbsent, true, "fixed files are tracked even when absent");
    assert.equal(found.get(join(home, ".claude", "settings.json"))?.trackAbsent, true);
    assert.ok(!found.has(join(proj, "node_modules", "lib", "CLAUDE.md")));
  } finally {
    t.cleanup();
  }
});

test("parseImports resolves relative and ~ paths and ignores emails", () => {
  assert.deepEqual(
    parseImports("mail ops@x.example and @docs/guide.md and @~/notes/a.md and @README", "/p/CLAUDE.md", "/h"),
    ["/p/docs/guide.md", "/h/notes/a.md"],
  );
});

test("readSurface: missing, directory, file, truncation", () => {
  const { t, proj } = fixture();
  try {
    assert.equal(readSurface(join(proj, "nope.md")), null);
    assert.equal(readSurface(join(proj, "docs")), null);
    assert.equal(readSurface(join(proj, "docs", "guide.md"))?.text, "guide\n");
    assert.equal(readSurface(join(proj, "docs", "guide.md"), 3)?.text, "gui");
  } finally {
    t.cleanup();
  }
});

test("rescanTargets: this project's known surfaces + live memory listing, not other projects", () => {
  const { t, proj, memoryDir, ctx } = fixture();
  try {
    const known = [
      { path: join(proj, "packages", "a", "CLAUDE.md"), scope: "project", projectRoot: proj, lastSha: "x", lastSeenAt: "t" },
      { path: "/other/CLAUDE.md", scope: "project", projectRoot: "/other", lastSha: "x", lastSeenAt: "t" },
    ];
    put(join(memoryDir, "new.md"), "new\n");
    const paths = new Set(rescanTargets(ctx, known).map((s) => s.path));
    assert.ok(paths.has(join(proj, "packages", "a", "CLAUDE.md")));
    assert.ok(paths.has(join(proj, "CLAUDE.md")));
    assert.ok(paths.has(join(memoryDir, "new.md")));
    assert.ok(!paths.has("/other/CLAUDE.md"));
  } finally {
    t.cleanup();
  }
});
