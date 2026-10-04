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

test("detects fetches in substitutions, subshells, keywords and git -C", () => {
  assert.deepEqual(ids("R=$(curl -s https://a.example/x)"), ["https://a.example/x"]);
  assert.deepEqual(ids('echo "$(curl -s https://b.example/y)"'), ["https://b.example/y"]);
  assert.deepEqual(ids("sleep 1 & curl https://c.example"), ["https://c.example"]);
  assert.deepEqual(ids("(curl https://e.example)"), ["https://e.example"]);
  assert.deepEqual(ids("if curl -s https://f.example; then echo ok; fi"), ["https://f.example"]);
  assert.deepEqual(ids("env -i curl https://g.example"), ["https://g.example"]);
  assert.deepEqual(ids("ls | xargs curl -O"), ["network:curl"]);
  assert.deepEqual(ids("git -C /repo pull"), ["network:git pull"]);
  assert.deepEqual(ids("git -C /repo clone https://github.com/x/y"), ["https://github.com/x/y"]);
  assert.deepEqual(ids("git -C /repo status"), []);
});
