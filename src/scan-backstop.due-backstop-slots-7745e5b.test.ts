import assert from "node:assert/strict";
import test from "node:test";
import { dueSlot } from "./scan-backstop";

test("due backstop slots", () => {
  assert.deepEqual(dueSlot(new Date("2026-10-13T06:00:00Z")), new Date("2026-10-13T05:30:00Z"));
  assert.deepEqual(dueSlot(new Date("2026-10-13T10:00:00Z")), new Date("2026-10-13T09:30:00Z"));
  assert.equal(dueSlot(new Date("2026-10-13T05:59:00Z")), null);
  assert.equal(dueSlot(new Date("2026-10-13T07:00:00Z")), null);
  assert.equal(dueSlot(new Date("2026-10-11T06:00:00Z")), null);
});
