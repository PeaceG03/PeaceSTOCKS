import assert from "node:assert/strict";
import test from "node:test";
import { lastScanSlot } from "./scan-backstop";

test("last scan slots", () => {
  assert.deepEqual(lastScanSlot(new Date("2026-10-13T05:30:00Z")), new Date("2026-10-13T05:30:00Z"));
  assert.deepEqual(lastScanSlot(new Date("2026-10-13T12:00:00Z")), new Date("2026-10-13T09:30:00Z"));
  assert.deepEqual(lastScanSlot(new Date("2026-10-13T05:29:00Z")), new Date("2026-10-10T09:30:00Z"));
  assert.deepEqual(lastScanSlot(new Date("2026-10-18T03:00:00Z")), new Date("2026-10-17T09:30:00Z"));
});
