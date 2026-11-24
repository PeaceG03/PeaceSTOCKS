import assert from "node:assert/strict";
import test from "node:test";
import { expectedTenMinBars, presentTenMinBars, tenMinSessionDone } from "./tenmin-day-done";

// 2026-10-09 is a normal Friday; 2026-11-27 (day after Thanksgiving) is an NYSE half day.
const NORMAL = "2026-10-09";
const HALF = "2026-11-27";
const names = ["sec_a", "sec_b"];

test("done-day: 39 ten-minute bars on a normal day, 21 on a half day (half-day calendar)", () => {
  assert.equal(expectedTenMinBars(NORMAL), 39);
  assert.equal(expectedTenMinBars(HALF), 21);
  assert.equal(expectedTenMinBars("2026-10-10"), 0, "Saturday");
});

test("done-day: every stock needs all bars AND its daily bar saved", () => {
  const all = new Set(names);
  const full = new Map(names.map((n) => [n, 39]));
  assert.equal(tenMinSessionDone({ sessionDate: NORMAL, selected: names, savedBars: full, dailyBarsSaved: all }).done, true);

  const short = tenMinSessionDone({ sessionDate: NORMAL, selected: names, savedBars: new Map([["sec_a", 39], ["sec_b", 38]]), dailyBarsSaved: all });
  assert.equal(short.done, false, "one stock at 38 of 39 bars");
  assert.deepEqual(short.shortNames, ["sec_b"]);

  const noDaily = tenMinSessionDone({ sessionDate: NORMAL, selected: names, savedBars: full, dailyBarsSaved: new Set(["sec_a"]) });
  assert.equal(noDaily.done, false, "ten-minute bars alone do not finish the day");
  assert.deepEqual(noDaily.missingDailyBars, ["sec_b"]);
});

test("done-day: a gap refill alone (daily bars saved, no ten-minute bars) does not count", () => {
  const r = tenMinSessionDone({ sessionDate: NORMAL, selected: names, savedBars: new Map(), dailyBarsSaved: new Set(names) });
  assert.equal(r.done, false);
  assert.deepEqual(r.shortNames, names);
});

test("done-day: a scan report alone (nothing selected or saved) does not count", () => {
  assert.equal(tenMinSessionDone({ sessionDate: NORMAL, selected: [], savedBars: new Map(), dailyBarsSaved: new Set() }).done, false);
});

test("done-day: a half day is done at 21 bars, and 21 is short on a normal day", () => {
  const saved = new Map(names.map((n) => [n, 21]));
  assert.equal(tenMinSessionDone({ sessionDate: HALF, selected: names, savedBars: saved, dailyBarsSaved: new Set(names) }).done, true);
  assert.equal(tenMinSessionDone({ sessionDate: NORMAL, selected: names, savedBars: saved, dailyBarsSaved: new Set(names) }).done, false);
});

test("done-day: placeholder (PROVIDER_MISSING) bars are not saved bars", () => {
  assert.equal(presentTenMinBars([{ state: "VALID_TRADED" }, { state: "NO_TRADE" }, { state: "PROVIDER_MISSING" }]), 2);
});
