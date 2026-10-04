import { test } from "node:test";
import assert from "node:assert/strict";
import { extractIndicators, normalizeWords, shingles, firstSharedShingle } from "../src/core/indicators.ts";

test("extracts typed, lowercased indicators", () => {
  const ind = extractIndicators(
    "Contact OPS@acme-backup.com or see https://acme-status.example/incident. Limit: $25,000 (since 2024). " +
      "Call 555-123-4567, ping @acme_ops, server 10.0.0.12. See README.md",
  );
  for (const want of [
    "email:ops@acme-backup.com",
    "domain:acme-backup.com",
    "url:https://acme-status.example/incident",
    "domain:acme-status.example",
    "number:25000",
    "phone:5551234567",
    "handle:@acme_ops",
    "ip:10.0.0.12",
  ]) {
    assert.ok(ind.has(want), `missing ${want}`);
  }
  assert.ok(!ind.has("number:2024"), "years 1900-2100 are excluded");
  assert.ok(!ind.has("domain:readme.md"), "file extensions are not domains");
  assert.ok(![...ind].some((i) => i.startsWith("handle:@acme-backup")), "email @ is not a handle");
});

test("normalizeWords strips markdown and punctuation", () => {
  assert.deepEqual(normalizeWords("Backup **contact**: ops@acme-backup.com!"), ["backup", "contact", "ops", "acme", "backup", "com"]);
});

test("shingles and first shared shingle", () => {
  assert.deepEqual([...shingles(["a", "b", "c"], 2)], ["a b", "b c"]);
  assert.equal(shingles(["a", "b", "c"]).size, 0);
  const a = shingles(normalizeWords("one two three four five six seven eight nine"));
  const b = shingles(normalizeWords("zero one two three four five six seven eight"));
  assert.equal(firstSharedShingle(a, b), "one two three four five six seven eight");
  assert.equal(firstSharedShingle(a, new Set()), null);
});
