import assert from "node:assert/strict";
import test from "node:test";
import { MemoryObjectClient } from "./object-store";
import { SCAN_HEALTH_LATEST_KEY, type ScanHealthRecord } from "./scan-health";
import { loadSiteData } from "./site-data";
import { renderSitePage, scanHealthBlock } from "./site-page";

const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const record: ScanHealthRecord = {
  schemaVersion: "scan-health-v1",
  sessionDate: "2026-11-20",
  runId: "scan_x",
  runStatus: "COMPLETE",
  completedAt: "2026-11-21T10:05:00.000Z",
  nextSessionDate: "2026-11-23",
  nextSessionOpen: "2026-11-23T14:30:00.000Z",
  finishedBeforeOpen: true,
  freezeStatus: "FROZEN",
  freezeReason: "PREDICTIONS_FROZEN",
  frozenOnTime: true,
  namesExpected: 9400,
  namesCovered: 9350,
  eligibilityFloorExcluded: { total: 5600, byReason: { FLOOR_DOLLAR_VOLUME: 4000, FLOOR_HISTORY: 100, FLOOR_PRICE: 1500 } },
  splitGuardExcluded: { total: 140, byReason: { SPLIT_LIKE_MOVE_UNRECORDED: 140 } },
};

test("site: the Health card shows the newest nightly scan record (before the open, freeze, coverage, floor and split counts)", async () => {
  const client = new MemoryObjectClient();
  await client.put(SCAN_HEALTH_LATEST_KEY, enc(record));
  const data = await loadSiteData(client, { now: () => new Date("2026-11-24T08:00:00.000Z") });
  assert.deepEqual(data.readErrors, []);
  assert.equal(data.scanHealth?.sessionDate, "2026-11-20");
  assert.equal(data.scanHealth?.floorExcluded, 5600);
  assert.equal(data.scanHealth?.splitExcluded, 140);
  const html = renderSitePage(data);
  const health = html.slice(html.indexOf("<h2>Health</h2>"), html.indexOf("<h2>Catch-up</h2>"));
  assert.match(health, /No health check has been saved yet\./u);
  assert.match(health, /Nightly scan/u);
  assert.match(health, /Session 2026-11-20/u);
  assert.match(health, /class="ok">Finished before the open/u);
  assert.match(health, /finished Nov 21, 3:05 AM MT, open Nov 23, 7:30 AM MT/u);
  assert.match(health, /Picks frozen on time/u);
  assert.match(health, /Names covered: 9350 of 9400/u);
  assert.match(health, /Left out by the eligibility floor: 5600 \(dollar volume under \$5M 4000, under 60 sessions of history 100, price under \$5 1500\)/u);
  assert.match(health, /Left out by the split guard: 140 \(split-like move with no record 140\)/u);
});

test("site: a late or missing scan record reads plainly", async () => {
  const late = renderSitePage(
    await loadSiteData(
      (() => {
        const c = new MemoryObjectClient();
        void c.put(SCAN_HEALTH_LATEST_KEY, enc({ ...record, finishedBeforeOpen: false, frozenOnTime: false, freezeStatus: "UNAVAILABLE", freezeReason: "FREEZE_AFTER_OPEN" }));
        return c;
      })(),
    ),
  );
  assert.match(late, /class="bad">Finished after the open/u);
  assert.match(late, /Picks not frozen on time<\/span> <span class="mute">UNAVAILABLE FREEZE_<wbr>AFTER_<wbr>OPEN/u);
  const none = renderSitePage(await loadSiteData(new MemoryObjectClient()));
  assert.match(none, /No nightly scan record has been saved yet\./u);
  // Unknown open: never claimed as before the open.
  assert.match(scanHealthBlock({ ...(await loadSiteData(new MemoryObjectClient())).scanHealth!, ...{ sessionDate: "d", completedAt: "", finishedBeforeOpen: null, freezeStatus: "NO_DECISION", frozenOnTime: false, namesExpected: 0, namesCovered: 0, floorExcluded: 0, floorByReason: {}, splitExcluded: 0, splitByReason: {} } }), /Open time unknown/u);
});

test("site: scan record fields are escaped", async () => {
  const bad = "<script>alert(1)</script>";
  const c = new MemoryObjectClient();
  await c.put(SCAN_HEALTH_LATEST_KEY, enc({ ...record, sessionDate: bad, freezeStatus: bad, freezeReason: bad, frozenOnTime: false, eligibilityFloorExcluded: { total: 1, byReason: { [bad]: 1 } } }));
  const html = renderSitePage(await loadSiteData(c));
  assert.equal(html.includes(bad), false);
  assert.doesNotMatch(html, /<script/u);
});
