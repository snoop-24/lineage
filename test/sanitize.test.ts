import { test } from "node:test";
import assert from "node:assert/strict";
import { safe } from "../src/core/sanitize.ts";

test("safe escapes C0 (except tab), DEL and C1 controls", () => {
  assert.equal(safe("\x1b[8mhidden"), "\\x1b[8mhidden");
  assert.equal(safe("a\tb"), "a\tb");
  assert.equal(safe("a\nb\rc\x00d"), "a\\x0ab\\x0dc\\x00d");
  assert.equal(safe("\x7f\x80\x9b\x9f"), "\\x7f\\x80\\x9b\\x9f");
  assert.equal(safe("\x1b]52;c;ZXZpbA==\x07"), "\\x1b]52;c;ZXZpbA==\\x07");
  assert.equal(safe("plain é ü 日本"), "plain é ü 日本");
});
