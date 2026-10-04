import { test } from "node:test";
import assert from "node:assert/strict";
import { detectNetworkSources } from "../src/core/bash-parse.ts";

const ids = (cmd: string) => detectNetworkSources(cmd).map((s) => s.sourceId);

test("finds URLs passed to network tools", () => {
  assert.deepEqual(ids("curl -s https://a.example/p | head -c 200"), ["https://a.example/p"]);
  assert.deepEqual(ids("cd x && FOO=1 wget http://b.example/f.txt"), ["http://b.example/f.txt"]);
  assert.deepEqual(ids("sudo curl https://c.example"), ["https://c.example"]);
  assert.deepEqual(ids("git clone https://github.com/x/y"), ["https://github.com/x/y"]);
});

test("network tools without URLs get a tool-level source id", () => {
  assert.deepEqual(ids("gh issue view 12"), ["network:gh issue"]);
  assert.deepEqual(ids("git fetch origin"), ["network:git fetch"]);
});

test("ignores non-network commands", () => {
  assert.deepEqual(ids("git status"), []);
  assert.deepEqual(ids("echo curl https://d.example"), []);
  assert.deepEqual(ids("python3 -c \"open('CLAUDE.md','a').write('x')\""), []);
});

test("deduplicates", () => {
  assert.deepEqual(ids("curl https://a.example; curl https://a.example"), ["https://a.example"]);
});
