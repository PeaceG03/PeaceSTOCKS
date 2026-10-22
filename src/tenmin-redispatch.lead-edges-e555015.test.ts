import assert from "node:assert/strict";
import test from "node:test";
import { minutesUntilGuardWindowEnd } from "./tenmin-redispatch";

test("lead edges", () => {
  assert.equal(minutesUntilGuardWindowEnd(new Date("2026-10-13T05:04:00Z")), undefined);
  assert.equal(minutesUntilGuardWindowEnd(new Date("2026-10-13T05:04:30Z")), undefined);
  assert.equal(minutesUntilGuardWindowEnd(new Date("2026-10-13T09:04:00Z")), undefined);
  assert.equal(minutesUntilGuardWindowEnd(new Date("2026-10-13T05:10:00Z")), 65);
});
