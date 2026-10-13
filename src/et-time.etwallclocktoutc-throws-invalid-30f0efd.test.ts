import assert from "node:assert/strict";
import test from "node:test";
import { etWallClockToUtc } from "./et-time";

test("etWallClockToUtc throws INVALID_WALL_CLOCK", () => {
  assert.throws(() => etWallClockToUtc("2026-10-13", 24, 0), /INVALID_WALL_CLOCK/);
  assert.throws(() => etWallClockToUtc("2026-10-13", 9, 60), /INVALID_WALL_CLOCK/);
  assert.throws(() => etWallClockToUtc("2026-10-13", 9.5, 0), /INVALID_WALL_CLOCK/);
  assert.equal(etWallClockToUtc("2026-10-13", 9, 30).toISOString(), "2026-10-13T13:30:00.000Z");
});
