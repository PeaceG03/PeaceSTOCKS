import assert from "node:assert/strict";
import test from "node:test";
import type { ScannerRunReport } from "./contracts";
import { HEALTH_CHECK_LATEST_KEY } from "./health-check";
import { healthCheckinKey } from "./health-checkins";
import { MemoryObjectClient } from "./object-store";
import { loadSiteData, SITE_HEALTH_LATEST_KEY, type SiteReader } from "./site-data";
import { renderSitePage, SITE_HEADERS } from "./site-page";
import * as sitePage from "./site-page";

const enc = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

function report(sessionDate: string, status: ScannerRunReport["status"], failures: string[] = []): ScannerRunReport {
  return {
    runId: `scan_${sessionDate}`,
    session: { sessionDate, kind: "NORMAL", market: "US_EQUITIES", source: "test" },
    status,
    expectedSecurities: 10,
    processedSecurities: 10,
    validSecurities: failures.length ? 8 : 10,
    incompleteSecurities: failures.length ? 2 : 0,
    unresolvedFailures: failures,
    storage: { permanentBytesToday: 0, cacheBytes: 0, transientBytesCreated: 0, transientBytesDeleted: 0, rollingMbPerDay: 0, projectedGbPerYear: 0, targetUtilizationPercent: 0, categoryBytes: {} },
    scannerVersion: "scanner-v0.1",
    sourceCommit: "abc",
    completedAt: `${sessionDate}T22:00:00.000Z`,
    predictionStatus: "UNAVAILABLE",
  };
}

async function seeded(): Promise<MemoryObjectClient> {
  const client = new MemoryObjectClient();
  await client.put(SITE_HEALTH_LATEST_KEY, enc({ at: "2026-11-24T07:00:00.000Z", headline: "behind: scan (2 remaining)", attention: false, errors: 0, missing: 0, lines: ["behind: scan (2 remaining)", "errors: 0, missing: 0", "scan: behind, 2 remaining"] }));
  const scan = { schemaVersion: "health-checkin-v1", part: "scan", state: "BEHIND", at: "2026-11-24T06:43:00.000Z", message: "capped run", remaining: 2, runId: "r1" };
  await client.put(healthCheckinKey(scan as never, "n1"), enc(scan));
  const refill = { schemaVersion: "health-checkin-v1", part: "gap-refill", state: "OK", at: "2026-11-22T14:50:00.000Z" };
  await client.put(healthCheckinKey(refill as never, "n2"), enc(refill));
  await client.put("scheduler-host-state.json", enc({ lastObservedSessionDate: "2026-11-21" }));
  await client.put("runs/a.json", enc(report("2026-11-20", "COMPLETE")));
  await client.put("runs/b.json", enc(report("2026-11-21", "FAILED", ["EVIDENCE_PROVIDER_ERROR:<script>x</script>"])));
  return client;
}

test("site page: health, backlog, check-ins, per-session reports, and plain 'Predictions off'", async () => {
  assert.equal(SITE_HEALTH_LATEST_KEY, HEALTH_CHECK_LATEST_KEY);
  const data = await loadSiteData(await seeded(), { now: () => new Date("2026-11-24T08:00:00.000Z") });
  assert.equal(data.caughtUpThrough, "2026-11-21");
  assert.deepEqual(data.backlog, { remaining: 2, state: "BEHIND", message: "capped run" });
  assert.deepEqual(data.reports.map((r) => [r.sessionDate, r.status]), [["2026-11-21", "FAILED"], ["2026-11-20", "COMPLETE"]]);
  assert.deepEqual(data.checkins.map((c) => [c.part, c.state]), [["scan", "BEHIND"], ["gap-refill", "OK"]]);
  assert.equal(data.predictions.state, "off");
  assert.deepEqual(data.readErrors, []);
  const html = renderSitePage(data);
  assert.match(html, /<meta name="viewport"/u);
  assert.match(html, /Predictions off/u);
  assert.match(html, /Behind: 2 market days still to collect\./u);
  assert.match(html, /Collected through 2026-11-21/u);
  assert.match(html, /behind: scan \(2 remaining\)/u);
  assert.match(html, /2026-11-21[\s\S]*FAILED[\s\S]*2026-11-20[\s\S]*COMPLETE/u);
  assert.match(html, /Nov 23, 11:43 PM MT/u); // check-in time shown in Peace's zone
  assert.doesNotMatch(html, /<script/u); // stored text is escaped
  assert.match(html, /&lt;script&gt;/u);
  assert.match(SITE_HEADERS["content-security-policy"] ?? "", /default-src 'none'/u);
  assert.equal(SITE_HEADERS["cache-control"], "private, no-store");
});

test("site page: shows the latest picks by symbol only when prediction sets exist", async () => {
  const client = await seeded();
  await client.put("permanent/predictions/2026-11-21.jsonl", enc(`${JSON.stringify({ predictionId: "p", sessionDate: "2026-11-21", setType: "TOP_15_OVERALL", securityIds: ["sec-a", "sec-b", "sec-z"], scannerVersion: "v", configFingerprint: "f", frozenAt: "x" })}\n`));
  await client.put("permanent/security-master.json", enc([{ securityId: "sec-a", currentSymbol: "AAA" }, { securityId: "sec-b", currentSymbol: "BBB" }]));
  const data = await loadSiteData(client);
  assert.equal(data.predictions.state, "on");
  assert.deepEqual(data.predictions.picks, [{ setType: "TOP_15_OVERALL", symbols: ["AAA", "BBB", "sec-z"] }]);
  const html = renderSitePage(data);
  assert.doesNotMatch(html, /Predictions off/u);
  assert.match(html, /TOP_15_OVERALL<\/b>: AAA, BBB, sec-z/u);
});

test("site data: bounded run-report reads, newest by listing date, and a failed read still renders", async () => {
  const client = await seeded();
  for (let i = 1; i <= 9; i += 1) await client.put(`runs/old${i}.json`, enc(report(`2026-10-0${i}`, "COMPLETE")));
  let gets = 0;
  const reader: SiteReader = {
    async get(key) {
      if (key.startsWith("runs/")) gets += 1;
      if (key === "scheduler-host-state.json") throw new Error("boom");
      return client.get(key);
    },
    list: (prefix) => client.list(prefix),
    async listSizes(prefix) {
      const keys = await client.list(prefix);
      return keys.map((key) => ({ key, size: 1, lastModified: key.startsWith("runs/old") ? "2026-10-01T00:00:00Z" : "2026-11-23T00:00:00Z" }));
    },
  };
  const data = await loadSiteData(reader, { maxReports: 2 });
  assert.equal(gets, 2);
  assert.deepEqual(data.reports.map((r) => r.sessionDate), ["2026-11-21", "2026-11-20"]);
  assert.deepEqual(data.readErrors, ["scheduler"]);
  assert.match(renderSitePage(data), /Could not read: scheduler/u);
});

const SAMPLE_PAGE: Parameters<typeof renderSitePage>[0] = {
  generatedAt: "2026-11-24T09:00:00.000Z",
  checkins: [
    { part: "scan", name: "Scan", state: "OK", at: "2026-11-24T06:43:00.000Z", message: "all good" },
    { part: "gap-refill", name: "Gap refill", state: "OK", at: "2026-11-22T14:50:00.000Z" },
  ],
  caughtUpThrough: "2026-11-23",
  backlog: { state: "OK" },
  reports: [
    {
      sessionDate: "2026-11-21",
      status: "FAILED",
      completedAt: "2026-11-21T22:00:00.000Z",
      expected: 10,
      valid: 8,
      incomplete: 2,
      failures: ["MISSING_SECURITY_EVIDENCE", "EVIDENCE_PROVIDER_ERROR:<script>x</script>", "<_foo_&>"],
      failureCount: 3,
    },
    {
      sessionDate: "2026-11-20",
      status: "COMPLETE",
      completedAt: "2026-11-20T22:00:00.000Z",
      expected: 10,
      valid: 10,
      incomplete: 0,
      failures: [],
      failureCount: 0,
    },
  ],
  predictions: { state: "off", picks: [] },
  readErrors: [],
};

test("wrapAtUnderscores: escapes first, then inserts <wbr> after each underscore", () => {
  assert.equal(sitePage.wrapAtUnderscores("MISSING_SECURITY_EVIDENCE"), "MISSING_<wbr>SECURITY_<wbr>EVIDENCE");
  assert.equal(sitePage.wrapAtUnderscores("<_foo_&>"), "&lt;_<wbr>foo_<wbr>&amp;&gt;");
  assert.equal(sitePage.wrapAtUnderscores("nope"), "nope");
  assert.equal(sitePage.wrapAtUnderscores(""), "");
});

test("site page: phone layout stacks session and check-in rows; issue codes wrap at underscores and stay escaped", () => {
  const html = renderSitePage(SAMPLE_PAGE);
  assert.match(html, /@media \(max-width:480px\)/u);
  assert.match(html, /\.stack,\.stack tbody,\.stack tr,\.stack td\{display:block/u);
  assert.match(html, /html,body\{max-width:100%;overflow-x:hidden\}/u);
  assert.match(html, /\.table-wrap\{[^}]*overflow-x:hidden/u);
  assert.match(html, /\.session-date,\.when,\.valid\{white-space:nowrap\}/u);
  assert.match(html, /\.issues\{overflow-wrap:anywhere/u);
  assert.equal(html.match(/<div class="table-wrap">/gu)?.length, 2);
  assert.match(html, /<div class="table-wrap"><table class="stack">/u);
  assert.match(html, /data-label="Session"/u);
  assert.match(html, /data-label="Status"/u);
  assert.match(html, /data-label="Valid"/u);
  assert.match(html, /data-label="Part"/u);
  assert.match(html, /data-label="State"/u);
  assert.match(html, /data-label="When"/u);
  assert.match(html, /<span class="session-date">2026-11-21<\/span>/u);
  assert.match(html, /<span class="valid">8 \/ 10<\/span>/u);
  assert.match(html, /MISSING_<wbr>SECURITY_<wbr>EVIDENCE/u);
  assert.match(html, /EVIDENCE_<wbr>PROVIDER_<wbr>ERROR:&lt;script&gt;x&lt;\/script&gt;/u);
  assert.match(html, /&lt;_<wbr>foo_<wbr>&amp;&gt;/u);
  assert.doesNotMatch(html, /<script/u);
  assert.doesNotMatch(html, /MISSING_SECURITY_EVIDENCE/u);
  assert.doesNotMatch(html, /&lt;wbr&gt;/u);
});

