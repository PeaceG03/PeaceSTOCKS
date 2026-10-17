import assert from "node:assert/strict";
import test from "node:test";
import { utcDateKey } from "./et-time";

test("utcDateKey returns the expected values", () => {
  assert.equal(utcDateKey(new Date("2026-10-16T23:59:59Z")), "2026-10-16");
  assert.equal(utcDateKey(new Date("2024-02-29T00:00:00Z")), "2024-02-29");
  assert.equal(utcDateKey(new Date("2026-01-01T04:59:00Z")), "2026-01-01");
});
