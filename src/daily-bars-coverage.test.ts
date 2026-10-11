import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  checkDailyBarsCoverage,
  dailyBarsCoverage,
  dailyBarsExpectedLatest,
  previousTradingSession,
  tradingSessionsInRange,
} from "./daily-bars-coverage";
import { MemoryObjectClient } from "./object-store";

const pack = (d: string) => [`permanent/daily-bars-sidecar/${d}/manifest.json`, `permanent/daily-bars-sidecar/${d}/sidecar.dbs`];
const month = (m: string) => `permanent/daily-bars/${m}.jsonl`;
function store(sessions: string[]) {
  return {
    packKeys: sessions.flatMap(pack),
    monthKeys: [...new Set(sessions.map((d) => d.slice(0, 7)))].map(month),
  };
}

test("coverage: the two real holes (2025-09-22..09-30 and 2025-10-29..2026-08-20) are found exactly", () => {
  const all = tradingSessionsInRange("2024-10-07", "2026-10-09");
  assert.equal(all.length, 504);
  const kept = all.filter((d) => !(d >= "2025-09-22" && d <= "2025-09-30") && !(d >= "2025-10-29" && d <= "2026-08-20"));
  assert.equal(kept.length, 294);
  const report = dailyBarsCoverage({ ...store(kept), expectedLatest: "2026-10-08" });
  assert.equal(report.ok, false);
  assert.deepEqual(report.missingRanges, [
    { from: "2025-09-22", to: "2025-09-30", sessions: 7 },
    { from: "2025-10-29", to: "2026-08-20", sessions: 203 },
  ]);
  assert.equal(report.missingSessions.length, 210);
  assert.deepEqual(report.missingMonthFiles, ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"]);
  assert.deepEqual(report.failures, ["DAILY_BARS_COVERAGE_GAP:210:2025-09-22..2025-09-30,2025-10-29..2026-08-20"]);
  // Filled: OK.
  const full = dailyBarsCoverage({ ...store(all), expectedLatest: "2026-10-08" });
  assert.deepEqual([full.ok, full.missingSessions, full.failures], [true, [], []]);
});

test("coverage: weekends, holidays and special closures are never gaps; half days and 2027-12-31 are sessions", () => {
  const sessions = tradingSessionsInRange("2024-12-20", "2028-01-05");
  for (const closed of ["2024-12-25", "2025-01-01", "2025-01-09", "2025-11-27", "2025-12-25", "2026-01-01", "2026-04-03", "2027-12-24", "2028-01-01", "2028-01-02"])
    assert.ok(!sessions.includes(closed), closed);
  for (const open of ["2024-12-24", "2025-11-28", "2027-12-31", "2028-01-03"]) assert.ok(sessions.includes(open), open);
  assert.equal(dailyBarsCoverage({ ...store(sessions) }).ok, true);
  // Drop 2027-12-31: flagged (the fixed calendar expects it).
  const r = dailyBarsCoverage({ ...store(sessions.filter((d) => d !== "2027-12-31")) });
  assert.deepEqual(r.missingRanges, [{ from: "2027-12-31", to: "2027-12-31", sessions: 1 }]);
  // A gap across a holiday is one contiguous range of trading sessions.
  const r2 = dailyBarsCoverage({ ...store(sessions.filter((d) => d < "2025-12-23" || d > "2025-12-29")) });
  assert.deepEqual(r2.missingRanges, [{ from: "2025-12-23", to: "2025-12-29", sessions: 4 }]);
});

test("coverage: a session counts only with both its pack and its month JSONL", () => {
  const sessions = tradingSessionsInRange("2025-09-02", "2025-10-31");
  const s = store(sessions);
  const noOct = dailyBarsCoverage({ packKeys: s.packKeys, monthKeys: s.monthKeys.filter((k) => !k.includes("2025-10")) });
  assert.equal(noOct.missingSessions.length, sessions.filter((d) => d.startsWith("2025-10")).length);
  assert.deepEqual(noOct.missingMonthFiles, ["2025-10"]);
  // The .dbs alone (no manifest) is not a stored session.
  const noManifest = dailyBarsCoverage({ packKeys: s.packKeys.filter((k) => k !== "permanent/daily-bars-sidecar/2025-09-15/manifest.json"), monthKeys: s.monthKeys });
  assert.deepEqual(noManifest.missingSessions, ["2025-09-15"]);
  assert.equal(dailyBarsCoverage({ packKeys: [], monthKeys: [] }).failures[0], "DAILY_BARS_COVERAGE_EMPTY");
});

test("coverage: stale when the newest stored session is older than expected (missing tail sessions listed too)", () => {
  const sessions = tradingSessionsInRange("2026-09-01", "2026-10-02");
  const r = dailyBarsCoverage({ ...store(sessions), expectedLatest: "2026-10-08" });
  assert.equal(r.ok, false);
  assert.deepEqual(r.stale, { latestStored: "2026-10-02", expectedAtLeast: "2026-10-08" });
  assert.deepEqual(r.missingRanges, [{ from: "2026-10-05", to: "2026-10-08", sessions: 4 }]);
  assert.equal(r.failures.length, 2);
});

test("expected latest: one session of slack behind the last completed ET session", () => {
  // Sun Oct 11 2026: last completed = Fri Oct 9; must have at least Thu Oct 8.
  assert.equal(dailyBarsExpectedLatest(new Date("2026-10-11T13:00:00Z")), "2026-10-08");
  // Tue 05:45Z (scan just ran for Mon): last completed Mon Oct 12 -> at least Fri Oct 9.
  assert.equal(dailyBarsExpectedLatest(new Date("2026-10-13T05:45:00Z")), "2026-10-09");
  assert.equal(previousTradingSession("2025-11-28"), "2025-11-26");
});

test("checkDailyBarsCoverage lists the two prefixes only (no GET)", async () => {
  const client = new MemoryObjectClient();
  for (const d of tradingSessionsInRange("2026-10-01", "2026-10-09").filter((x) => x !== "2026-10-06")) {
    for (const key of pack(d)) await client.put(key, new Uint8Array([1]));
    await client.put(month(d.slice(0, 7)), new Uint8Array([1]));
  }
  let gets = 0;
  const wrapped = { list: (p: string) => client.list(p), get: async () => { gets += 1; return undefined; } };
  const report = await checkDailyBarsCoverage(wrapped, { now: new Date("2026-10-11T13:00:00Z") });
  assert.deepEqual(report.missingSessions, ["2026-10-06"]);
  assert.equal(gets, 0);
});

test("scanner.yml: the scan job runs the coverage check after the scan, even when the scan failed", async () => {
  const yml = await readFile(new URL("../.github/workflows/scanner.yml", import.meta.url), "utf8");
  const scan = yml.slice(yml.indexOf("\n  scan:\n"), yml.indexOf("\n  tenmin_daily:\n"));
  const host = scan.indexOf("name: Run online scanner host");
  const check = scan.indexOf("name: Daily-bars coverage check");
  assert.ok(host > 0 && check > host);
  const step = scan.slice(check, check + 600);
  assert.match(step, /if: \$\{\{ always\(\) \}\}/u);
  assert.match(step, /run: pnpm exec tsx src\/daily-bars-coverage\.ts/u);
  assert.doesNotMatch(step, /continue-on-error/u);
});
