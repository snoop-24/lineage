import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  classifySurfacePath, discoverSurfaces, parseImports, readSurface, rescanTargets, type SurfaceContext,
} from "../src/core/surfaces.ts";
import { sha256 } from "../src/core/hash.ts";
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

test("readSurface on chmod-000 file returns null; discoverSurfaces still works", () => {
  const isRoot = process.getuid?.() === 0;
  if (isRoot) {
    console.log("skipping (running as root)");
    return;
  }
  const { t, home, proj, ctx } = fixture();
  try {
    const chmodFile = join(proj, "CLAUDE.md");
    chmodSync(chmodFile, 0o000);
    try {
      assert.equal(readSurface(chmodFile), null);
      const found = discoverSurfaces(ctx);
      assert.ok(Array.isArray(found), "discoverSurfaces should not throw");
      const userClaude = found.find((s) => s.path === join(home, ".claude", "CLAUDE.md"));
      assert.ok(userClaude, "should still discover other surfaces");
    } finally {
      chmodSync(chmodFile, 0o644);
    }
  } finally {
    t.cleanup();
  }
});

test("symlink to skill dir is discovered at symlink path", () => {
  const { t, home, proj, ctx } = fixture();
  try {
    const outside = join(t.path, "outside");
    mkdirSync(outside, { recursive: true });
    put(join(outside, "SKILL.md"), "external skill\n");
    const skillsDir = join(home, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    const linkPath = join(skillsDir, "external");
    symlinkSync(outside, linkPath);
    const found = discoverSurfaces(ctx);
    const discovered = found.find((s) => s.path === join(skillsDir, "external", "SKILL.md"));
    assert.ok(discovered, "should discover SKILL.md via symlinked dir");
    assert.equal(discovered?.scope, "user");
  } finally {
    t.cleanup();
  }
});

test("symlink loop inside project .claude/rules does not hang", () => {
  const { t, proj, ctx } = fixture();
  try {
    const loopDir = join(proj, ".claude", "rules", "loop");
    mkdirSync(loopDir, { recursive: true });
    symlinkSync(loopDir, join(loopDir, "loop"));
    let completed = false;
    setTimeout(() => {
      if (!completed) {
        throw new Error("discoverSurfaces timed out (infinite loop?)");
      }
    }, 5000);
    const found = discoverSurfaces(ctx);
    completed = true;
    assert.ok(Array.isArray(found), "should complete despite symlink loop");
  } finally {
    t.cleanup();
  }
});

test("parseImports strips trailing punctuation", () => {
  assert.deepEqual(
    parseImports("See @docs/guide.md. And @docs/b.md, done", "/p/CLAUDE.md", "/h"),
    ["/p/docs/guide.md", "/p/docs/b.md"],
  );
});

test("invariant: truncated multibyte file sha matches re-read text", () => {
  const { t, proj } = fixture();
  try {
    const path = join(proj, "multibyte.txt");
    writeFileSync(path, "héllo");
    const result1 = readSurface(path, 2);
    assert.ok(result1, "should read truncated file");
    const result2 = readSurface(path, 2);
    assert.ok(result2, "should read again");
    assert.equal(
      result1.sha,
      sha256(Buffer.from(result1.text, "utf8")),
      "sha must match re-encoded text",
    );
    assert.equal(result1.sha, result2.sha, "consistent across reads");
  } finally {
    t.cleanup();
  }
});

test("F4: instruction basenames are case-insensitive on darwin only", () => {
  const { t, home, proj, ctx } = fixture();
  try {
    const darwin: SurfaceContext = { ...ctx, platform: "darwin" };
    assert.equal(classifySurfacePath(join(proj, "claude.md"), darwin), "project");
    assert.equal(classifySurfacePath(join(proj, "packages", "a", "Agents.md"), darwin), "project");
    assert.equal(classifySurfacePath(join(proj, "claude.LOCAL.md"), darwin), "project");
    assert.equal(classifySurfacePath(join(proj, ".claude", "skills", "x", "skill.md"), darwin), "project");
    assert.equal(classifySurfacePath(join(home, ".claude", "claude.md"), darwin), "user");
    assert.equal(classifySurfacePath(join(home, ".claude", "skills", "x", "Skill.md"), darwin), "user");
    assert.equal(classifySurfacePath(join(proj, "notes.md"), darwin), null);
    assert.equal(classifySurfacePath(join(proj, "claude.md"), ctx), null);
    assert.equal(classifySurfacePath(join(home, ".claude", "claude.md"), ctx), null);
  } finally {
    t.cleanup();
  }
});
