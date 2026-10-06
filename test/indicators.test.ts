import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
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

test("extractIndicators stays fast on long unbroken input", () => {
  // Test with 200k repeated "a"
  const start1 = performance.now();
  extractIndicators("a".repeat(200_000));
  const end1 = performance.now();
  const time1 = end1 - start1;
  console.log(`  200k × "a": ${time1.toFixed(2)} ms`);
  assert.ok(time1 < 1000, `expected < 1000ms, got ${time1.toFixed(2)}ms`);

  // Test with 200k repeated "1"
  const start2 = performance.now();
  extractIndicators("1".repeat(200_000));
  const end2 = performance.now();
  const time2 = end2 - start2;
  console.log(`  200k × "1": ${time2.toFixed(2)} ms`);
  assert.ok(time2 < 1000, `expected < 1000ms, got ${time2.toFixed(2)}ms`);

  // Test with 100k repeated "a."
  const start3 = performance.now();
  extractIndicators("a.".repeat(100_000));
  const end3 = performance.now();
  const time3 = end3 - start3;
  console.log(`  100k × "a.": ${time3.toFixed(2)} ms`);
  assert.ok(time3 < 1000, `expected < 1000ms, got ${time3.toFixed(2)}ms`);
});

test("M1: dotted code identifiers are not domains; real and example domains still are", () => {
  const ind = extractIndicators("Use Object.keys(x) and fs.readFileSync(p); also path.join and console.log. Mail ops@acme-backup.com, see acme-status.example, docs.python.org, x.co.uk, a.de and evil.io");
  const domains = [...ind].filter((i) => i.startsWith("domain:")).sort();
  assert.deepEqual(domains, [
    "domain:a.de", "domain:acme-backup.com", "domain:acme-status.example", "domain:docs.python.org", "domain:evil.io", "domain:x.co.uk",
  ]);
});
