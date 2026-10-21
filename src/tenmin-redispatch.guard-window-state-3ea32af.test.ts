import assert from "node:assert/strict";
import test from "node:test";
import { guardWindowState } from "./tenmin-redispatch";

test("guard window state", () => {
  assert.deepEqual(guardWindowState(new Date("2026-10-13T06:14:00Z")), { inside: true, minutesUntilNext: 181 });
  assert.deepEqual(guardWindowState(new Date("2026-10-13T06:15:00Z")), { inside: false, minutesUntilNext: 180 });
  assert.deepEqual(guardWindowState(new Date("2026-10-13T09:30:00Z")), { inside: true, minutesUntilNext: 1185 });
  assert.deepEqual(guardWindowState(new Date("2026-10-13T10:15:00Z")), { inside: false, minutesUntilNext: 1140 });
});
