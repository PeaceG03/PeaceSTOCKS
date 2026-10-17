import assert from "node:assert/strict";
import test from "node:test";
import { tenMinRangePrefix } from "./tenmin-range-reply-dust";

test("range prefix", () => {
  assert.equal(tenMinRangePrefix("2026-01-01", "2026-01-31"), "permanent/tenmin-reply-dust/2026-01-01_2026-01-31");
  assert.equal(tenMinRangePrefix("2026-01-01", "2026-01-01"), "permanent/tenmin-reply-dust/2026-01-01_2026-01-01");
  assert.throws(() => tenMinRangePrefix("2026-02-01", "2026-01-01"), /INVALID_RANGE/);
});
