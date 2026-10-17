import assert from "node:assert/strict";
import test from "node:test";
import { utcMinuteOfDay } from "./et-time";

test("utcMinuteOfDay returns the expected values", () => {
  assert.equal(utcMinuteOfDay(new Date("2026-10-16T05:30:00Z")), 330);
  assert.equal(utcMinuteOfDay(new Date("2026-10-16T00:00:00Z")), 0);
  assert.equal(utcMinuteOfDay(new Date("2026-10-16T23:59:59Z")), 1439);
});
