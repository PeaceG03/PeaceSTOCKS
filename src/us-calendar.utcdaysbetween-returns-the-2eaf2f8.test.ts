import assert from "node:assert/strict";
import test from "node:test";
import { utcDaysBetween } from "./us-calendar";

test("utcDaysBetween returns the expected values", () => {
  assert.equal(utcDaysBetween(new Date("2024-02-28T00:00:00Z"), new Date("2024-03-01T00:00:00Z")), 2);
  assert.equal(utcDaysBetween(new Date("2024-03-01T00:00:00Z"), new Date("2024-02-28T00:00:00Z")), -2);
  assert.equal(utcDaysBetween(new Date("2026-10-16T05:00:00Z"), new Date("2026-10-16T20:00:00Z")), 1);
  assert.equal(utcDaysBetween(new Date("2026-10-16T05:00:00Z"), new Date("2026-10-16T10:00:00Z")), 0);
});
