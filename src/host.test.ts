import assert from "node:assert/strict";
import test from "node:test";
import { findMissedEligibleSessions } from "./host";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

test("scheduler host catches up eligible sessions but skips weekends and NYSE holidays", () => {
  const missed = findMissedEligibleSessions(
    "2026-07-02",
    "2026-07-06",
    new Set(["2026-07-02"]),
    US_EQUITY_MARKET_CALENDAR,
  );
  assert.deepEqual(missed, ["2026-07-06"]);
});

test("scheduler host does not requeue completed sessions", () => {
  const missed = findMissedEligibleSessions(
    "2026-08-25",
    "2026-08-26",
    new Set(["2026-08-25", "2026-08-26"]),
    US_EQUITY_MARKET_CALENDAR,
  );
  assert.deepEqual(missed, []);
});

test("scheduler host catch-up excludes the current session before close", () => {
  const missed = findMissedEligibleSessions(
    "2026-08-30",
    "2026-08-31",
    new Set(),
    US_EQUITY_MARKET_CALENDAR,
  );
  assert.deepEqual(missed, ["2026-08-31"]);
});
