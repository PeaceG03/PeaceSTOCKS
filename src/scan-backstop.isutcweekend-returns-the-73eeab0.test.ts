import assert from "node:assert/strict";
import test from "node:test";
import { isUtcWeekend } from "./scan-backstop";

test("isUtcWeekend returns the expected values", () => {
  assert.equal(isUtcWeekend(new Date("2026-10-17T12:00:00Z")), true);
  assert.equal(isUtcWeekend(new Date("2026-10-18T00:00:00Z")), true);
  assert.equal(isUtcWeekend(new Date("2026-10-16T23:30:00Z")), false);
  assert.equal(isUtcWeekend(new Date("2026-10-19T00:00:00Z")), false);
});
