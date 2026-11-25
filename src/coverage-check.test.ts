import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HELD_OUT_START_DATE,
  coverageCheckFailed,
  coverageCheckMain,
  formatCoverageSummaryMarkdown,
  parseCoverageCheckArgs,
  runCoverageCheck,
} from "./coverage-check";
import { writeDailyReplyDust } from "./daily-reply-dust";
import type { CanonicalDailyBar, SecurityMasterRecord } from "./contracts";
import { MARKET_SCHEMA_VERSION } from "./contracts";
import { MemoryObjectClient } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";
import type { ReplyDustBackend } from "./reply-dust";
import { writeTickerReferenceIndex } from "./ticker-reference-index";

const ZSTD_MAGIC = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd]);
const fakeBackend: ReplyDustBackend = {
  compress: (raw) => {
    const out = new Uint8Array(4 + raw.length);
    out.set(ZSTD_MAGIC, 0);
    out.set(raw, 4);
    return out;
  },
  decompress: (frame) => frame.subarray(4),
  sha256: (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest()),
};

function makeSecurity(overrides: Partial<SecurityMasterRecord> & { securityId: string; currentSymbol: string; status: "ACTIVE" | "INACTIVE" }): SecurityMasterRecord {
  return {
    historicalSymbols: [],
    providerIdentities: [{ provider: "massive-stocks", providerSecurityId: `figi:${overrides.securityId}` }],
    assetType: "STOCK",
    country: "US",
    exchange: "XNAS",
    tradable: overrides.status === "ACTIVE",
    eligibility: "LEVEL_3",
    barCount: 0,
    firstSeenAt: "2024-10-11",
    lastUniverseSeenAt: "2026-11-25",
    ...(overrides.status === "INACTIVE" ? { inactiveAt: "2026-10-15" } : {}),
    ...overrides,
  };
}

function makeBar(securityId: string, sessionDate: string, close = 12.3456): CanonicalDailyBar {
  return {
    securityId,
    sessionDate,
    open: close,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 1000,
    observedAt: `${sessionDate}T21:00:00Z`,
    ingestedAt: `${sessionDate}T21:05:00Z`,
    dataQuality: "GOOD",
    corporateActionIds: [],
    flags: [],
    schemaVersion: MARKET_SCHEMA_VERSION,
    revision: 1,
    provenance: { provider: "massive-stocks", dataset: "stocks-grouped-daily", retrievalId: `grouped-${sessionDate}`, ingestionVersion: "v0", normalizerVersion: "v0" },
  };
}

async function seedTestStore(options: { indexAsOf: string; omitInactive2InBars?: boolean; omitInactive1HeldOutBar?: boolean }) {
  const client = new MemoryObjectClient();
  const storage = new ObjectMarketStorage(client);

  const securities: SecurityMasterRecord[] = [
    makeSecurity({ securityId: "sec_active_AAA", currentSymbol: "AAA", status: "ACTIVE" }),
    makeSecurity({ securityId: "sec_inactive_DEL1", currentSymbol: "DEL1", status: "INACTIVE", inactiveAt: "2026-10-15" }),
    makeSecurity({ securityId: "sec_inactive_DEL2", currentSymbol: "DEL2", status: "INACTIVE", inactiveAt: "2026-10-15" }),
    // Shares currentSymbol AAA with ACTIVE record -> uncollectable due to symbol collision
    makeSecurity({ securityId: "sec_inactive_COL", currentSymbol: "AAA", status: "INACTIVE", inactiveAt: "2026-10-15" }),
  ];
  await storage.saveSecurities(securities);

  await writeTickerReferenceIndex(
    client,
    {
      pages: { active: 1, inactive: 1 },
      entries: [
        { pass: "active", page: 1, position: 0, ticker: "AAA", type: "CS", active: true, raw: JSON.stringify({ ticker: "AAA", type: "CS", active: true }) },
        { pass: "inactive", page: 1, position: 0, ticker: "DEL1", type: "CS", active: false, raw: JSON.stringify({ ticker: "DEL1", type: "CS", active: false }) },
      ],
    },
    { provider: "massive-stocks", asOf: options.indexAsOf },
    fakeBackend,
  );

  // Two sessions: one pre-heldout (2025-05-15) and one held-out (2026-09-10)
  const sessions = [
    {
      date: "2025-05-15",
      results: [
        { T: "AAA", o: 10, h: 11, l: 9, c: 10.5, v: 5000, t: 1747344000000, n: 10 },
        { T: "DEL1", o: 20, h: 21, l: 19, c: 20.5, v: 4000, t: 1747344000000, n: 10 },
        { T: "DEL2", o: 30, h: 31, l: 29, c: 30.5, v: 3000, t: 1747344000000, n: 10 },
      ],
    },
    {
      date: "2026-09-10",
      results: [
        { T: "AAA", o: 11, h: 12, l: 10, c: 11.5, v: 5100, t: 1789075200000, n: 10 },
        { T: "DEL1", o: 21, h: 22, l: 20, c: 21.5, v: 4100, t: 1789075200000, n: 10 },
      ],
    },
  ];

  for (const s of sessions) {
    const rawReply = new TextEncoder().encode(
      JSON.stringify({ status: "OK", resultsCount: s.results.length, results: s.results }),
    );
    await writeDailyReplyDust(
      client,
      {
        dataset: "stocks-grouped-daily",
        sessionDate: s.date,
        request: `/v2/aggs/grouped/locale/us/market/stocks/${s.date}`,
        fetchedAt: `${s.date}T21:05:00Z`,
        body: rawReply,
      },
      { provider: "massive-stocks", observedAt: `${s.date}T21:05:00Z` },
      fakeBackend,
    );
  }

  await storage.appendBars([
    makeBar("sec_active_AAA", "2025-05-15", 10.5),
    makeBar("sec_inactive_DEL1", "2025-05-15", 20.5),
    ...(options.omitInactive2InBars ? [] : [makeBar("sec_inactive_DEL2", "2025-05-15", 30.5)]),
    makeBar("sec_active_AAA", "2026-09-10", 11.5),
    ...(options.omitInactive1HeldOutBar ? [] : [makeBar("sec_inactive_DEL1", "2026-09-10", 21.5)]),
  ]);

  await storage.saveBackfillReopenProgress({
    schemaVersion: "backfill-reopen-state-v1",
    provider: "massive-stocks",
    completedSessions: ["2025-05-15", "2026-09-10"],
    updatedAt: "2026-11-25T14:53:53Z",
  });

  return client;
}

test("runCoverageCheck aggregates security master, per-month/held-out bars, Reply Dust expected coverage, and leaks zero tickers/ids/prices", async () => {
  const client = await seedTestStore({ indexAsOf: "2026-11-25" });
  const report = await runCoverageCheck(client, {
    replyDustBackend: fakeBackend,
    liveAsOfFloor: "2026-11-24",
    now: new Date("2026-11-25T17:00:00Z"),
  });

  assert.equal(report.securityMaster.totalRecords, 4);
  assert.deepEqual(report.securityMaster.byStatus, { ACTIVE: 1, INACTIVE: 3 });
  assert.equal(report.securityMaster.inactiveTotal, 3);
  assert.equal(report.securityMaster.inactiveSharingActiveSymbol, 1);
  assert.equal(report.securityMaster.lastUniverseSeenAtMax, "2026-11-25");

  assert.equal(report.tickerReferenceIndex.present, true);
  assert.equal(report.tickerReferenceIndex.asOf, "2026-11-25");
  assert.equal(report.tickerReferenceIndex.asOfIsLiveDate, true);

  assert.equal(report.reopenState.present, true);
  assert.equal(report.reopenState.completedSessionsCount, 2);

  assert.equal(report.dailyBars.totalRows, 5);
  assert.deepEqual(report.dailyBars.rowsByStatus, { ACTIVE: 2, INACTIVE: 3 });
  assert.deepEqual(report.dailyBars.preHeldOutRowsByStatus, { ACTIVE: 1, INACTIVE: 2 });
  assert.deepEqual(report.dailyBars.heldOutRowsByStatus, { ACTIVE: 1, INACTIVE: 1 });
  assert.equal(report.dailyBars.inactiveIdsWithAnyBar, 2);
  assert.equal(report.dailyBars.inactiveIdsWithZeroBars, 1);
  assert.equal(report.dailyBars.inactiveIdsBeforeHeldOut, 2);
  assert.equal(report.dailyBars.inactiveIdsInHeldOut, 1);
  assert.equal(report.dailyBars.inactiveIdsOnlyBeforeHeldOut, 1);
  assert.equal(report.dailyBars.inactiveIdsInBothWindows, 1);
  assert.deepEqual(
    report.dailyBars.months.map((m) => ({ month: m.month, inactiveRows: m.inactiveRows, activeRows: m.activeRows })),
    [
      { month: "2025-05", inactiveRows: 2, activeRows: 1 },
      { month: "2026-09", inactiveRows: 1, activeRows: 1 },
    ],
  );

  assert.ok(report.replyDustReopen);
  assert.equal(report.replyDustReopen.expectedInactiveIdsCount, 2);
  assert.equal(report.replyDustReopen.expectedInactiveIdsPresentInBars, 2);
  assert.equal(report.replyDustReopen.expectedInactiveIdsMissingFromBars, 0);
  assert.equal(report.replyDustReopen.expectedInactiveIdsCoverageFraction, 1);
  assert.equal(report.replyDustReopen.expectedInactiveRowsTotal, 3);
  assert.equal(report.replyDustReopen.expectedInactiveRowsHeldOut, 1);
  assert.equal(report.replyDustReopen.expectedInactivePairsTotal, 3);
  assert.equal(report.replyDustReopen.expectedInactivePairsPresentInBars, 3);
  assert.equal(report.replyDustReopen.expectedInactivePairsMissingFromBars, 0);
  assert.equal(report.replyDustReopen.expectedInactivePairsCoverageFraction, 1);
  assert.equal(report.replyDustReopen.expectedInactivePairsHeldOutTotal, 1);
  assert.equal(report.replyDustReopen.expectedInactivePairsHeldOutPresentInBars, 1);
  assert.equal(report.replyDustReopen.expectedInactivePairsHeldOutMissingFromBars, 0);
  assert.equal(report.replyDustReopen.expectedInactivePairsHeldOutCoverageFraction, 1);
  assert.equal(report.replyDustReopen.idempotencyWouldAddInactiveRows, 0);
  assert.deepEqual(report.anomalies, []);
  assert.equal(coverageCheckFailed(report), false);

  // Aggregates only: zero tickers, securityIds, or prices in JSON or summary markdown
  const serialized = JSON.stringify(report);
  const summary = formatCoverageSummaryMarkdown(report);
  for (const forbidden of ["sec_active_AAA", "sec_inactive_DEL1", "sec_inactive_DEL2", "sec_inactive_COL", "AAA", "DEL1", "DEL2", "10.5", "20.5", "30.5", "21.5"]) {
    assert.ok(!serialized.includes(forbidden), `JSON leaked ${forbidden}`);
    assert.ok(!summary.includes(forbidden), `summary leaked ${forbidden}`);
  }
});

test("runCoverageCheck flags missing expected INACTIVE ids and historical chunk asOf date", async () => {
  const client = await seedTestStore({ indexAsOf: "2025-05-19", omitInactive2InBars: true });
  const report = await runCoverageCheck(client, {
    replyDustBackend: fakeBackend,
    liveAsOfFloor: "2026-11-24",
    now: new Date("2026-11-25T17:00:00Z"),
  });

  assert.equal(report.tickerReferenceIndex.asOf, "2025-05-19");
  assert.equal(report.tickerReferenceIndex.asOfIsLiveDate, false);
  assert.equal(report.replyDustReopen!.expectedInactiveIdsCount, 2);
  assert.equal(report.replyDustReopen!.expectedInactiveIdsPresentInBars, 1);
  assert.equal(report.replyDustReopen!.expectedInactiveIdsMissingFromBars, 1);
  assert.equal(report.replyDustReopen!.expectedInactivePairsTotal, 3);
  assert.equal(report.replyDustReopen!.expectedInactivePairsPresentInBars, 2);
  assert.equal(report.replyDustReopen!.expectedInactivePairsMissingFromBars, 1);
  assert.equal(report.replyDustReopen!.expectedInactivePairsCoverageFraction, 2 / 3);
  assert.equal(report.replyDustReopen!.expectedInactivePairsHeldOutTotal, 1);
  assert.equal(report.replyDustReopen!.expectedInactivePairsHeldOutPresentInBars, 1);
  assert.equal(report.replyDustReopen!.expectedInactivePairsHeldOutMissingFromBars, 0);
  assert.equal(report.replyDustReopen!.idempotencyWouldAddInactiveRows, 1);
  assert.ok(report.anomalies.some((a) => a.startsWith("INDEX_ASOF_NOT_LIVE")));
  assert.ok(report.anomalies.some((a) => a.startsWith("EXPECTED_INACTIVE_PAIRS_MISSING")));
  assert.ok(report.anomalies.some((a) => a.startsWith("EXPECTED_INACTIVE_IDS_MISSING")));
  assert.ok(report.anomalies.some((a) => a.startsWith("IDEMPOTENCY_WOULD_ADD_ROWS")));
  assert.equal(coverageCheckFailed(report), true);
});

test("coverageCheckMain requires read-only R2 keys and writes artifact + summary without touching write keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cov-check-"));
  try {
    const outPath = join(dir, "coverage-check.json");
    const summaryPath = join(dir, "summary.md");
    await assert.rejects(
      () => coverageCheckMain(["--out", outPath], { PEACESTOCKS_R2_ACCESS_KEY_ID: "write-id", PEACESTOCKS_R2_SECRET_ACCESS_KEY: "write-sec" }),
      /R2_CONFIG_REQUIRED/u,
    );

    const parsed = parseCoverageCheckArgs(["--out", outPath, "--skip-reply-dust"]);
    assert.equal(parsed.outJson, outPath);
    assert.equal(parsed.skipReplyDust, true);

    const client = await seedTestStore({ indexAsOf: "2026-11-25" });
    const report = await coverageCheckMain(
      ["--out", outPath, "--skip-reply-dust"],
      { GITHUB_STEP_SUMMARY: summaryPath },
      { reader: client, now: () => new Date("2026-11-25T17:00:00Z") },
    );
    assert.equal(report.replyDustReopen, undefined);
    const jsonText = readFileSync(outPath, "utf8");
    const sumText = readFileSync(summaryPath, "utf8");
    assert.equal(JSON.parse(jsonText).securityMaster.inactiveTotal, 3);
    assert.match(sumText, /PeaceSTOCKS Read-Only Coverage Check/u);
    assert.ok(!jsonText.includes("DEL1") && !sumText.includes("DEL1"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("dropping one held-out expected pair yields pair fraction < 1, EXPECTED_INACTIVE_PAIRS_MISSING, and a non-zero exit after writing outputs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cov-check-heldout-"));
  try {
    const outPath = join(dir, "coverage-check.json");
    const summaryPath = join(dir, "summary.md");
    const client = await seedTestStore({ indexAsOf: "2026-11-25", omitInactive1HeldOutBar: true });
    const report = await coverageCheckMain(
      ["--out", outPath],
      { GITHUB_STEP_SUMMARY: summaryPath },
      { reader: client, replyDustBackend: fakeBackend, now: () => new Date("2026-11-25T17:00:00Z") },
    );

    assert.equal(report.replyDustReopen!.expectedInactivePairsTotal, 3);
    assert.equal(report.replyDustReopen!.expectedInactivePairsPresentInBars, 2);
    assert.equal(report.replyDustReopen!.expectedInactivePairsMissingFromBars, 1);
    assert.ok(report.replyDustReopen!.expectedInactivePairsCoverageFraction !== null);
    assert.ok(report.replyDustReopen!.expectedInactivePairsCoverageFraction! < 1);
    assert.notEqual(report.replyDustReopen!.expectedInactivePairsCoverageFraction, 1);
    assert.equal(report.replyDustReopen!.expectedInactivePairsHeldOutTotal, 1);
    assert.equal(report.replyDustReopen!.expectedInactivePairsHeldOutPresentInBars, 0);
    assert.equal(report.replyDustReopen!.expectedInactivePairsHeldOutMissingFromBars, 1);
    assert.equal(report.replyDustReopen!.expectedInactivePairsHeldOutCoverageFraction, 0);
    // Id-level any-bar coverage stays 2/2 (the dropped pair's id still has a pre-held-out bar)
    assert.equal(report.replyDustReopen!.expectedInactiveIdsPresentInBars, 2);
    assert.equal(report.replyDustReopen!.expectedInactiveIdsMissingFromBars, 0);
    assert.equal(report.replyDustReopen!.expectedInactiveIdsCoverageFraction, 1);
    assert.ok(report.anomalies.some((a) => a === "EXPECTED_INACTIVE_PAIRS_MISSING:1"));
    assert.ok(!report.anomalies.some((a) => a.startsWith("EXPECTED_INACTIVE_IDS_MISSING")));
    assert.ok(report.anomalies.some((a) => a.startsWith("IDEMPOTENCY_WOULD_ADD_ROWS")));
    assert.equal(coverageCheckFailed(report), true);

    const jsonText = readFileSync(outPath, "utf8");
    const sumText = readFileSync(summaryPath, "utf8");
    const parsed = JSON.parse(jsonText) as typeof report;
    assert.equal(parsed.replyDustReopen!.expectedInactivePairsCoverageFraction, 2 / 3);
    assert.match(sumText, /Expected `INACTIVE` pairs \(`securityId\|sessionDate\|revision`\) present in live bars: \*\*2 \/ 3\*\* \(66\.67%; missing: \*\*1\*\*\)/u);
    assert.match(sumText, /Held-out expected `INACTIVE` pairs \(`>= 2026-08-27`\): \*\*0 \/ 1\*\* \(0\.00%; missing: \*\*1\*\*\)/u);
    assert.doesNotMatch(sumText, /100\.00%/u);
    assert.match(sumText, /EXPECTED_INACTIVE_PAIRS_MISSING:1/u);
    assert.ok(!jsonText.includes("DEL1") && !sumText.includes("DEL1"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("held-out window is inclusive at HELD_OUT_START_DATE 2026-08-27", async () => {
  assert.equal(HELD_OUT_START_DATE, "2026-08-27");

  const client = new MemoryObjectClient();
  const storage = new ObjectMarketStorage(client);
  const securities: SecurityMasterRecord[] = [
    makeSecurity({ securityId: "sec_active_AAA", currentSymbol: "AAA", status: "ACTIVE" }),
    makeSecurity({ securityId: "sec_inactive_DEL1", currentSymbol: "DEL1", status: "INACTIVE", inactiveAt: "2026-10-15" }),
  ];
  await storage.saveSecurities(securities);
  await writeTickerReferenceIndex(
    client,
    {
      pages: { active: 1, inactive: 1 },
      entries: [
        { pass: "active", page: 1, position: 0, ticker: "AAA", type: "CS", active: true, raw: JSON.stringify({ ticker: "AAA", type: "CS", active: true }) },
        { pass: "inactive", page: 1, position: 0, ticker: "DEL1", type: "CS", active: false, raw: JSON.stringify({ ticker: "DEL1", type: "CS", active: false }) },
      ],
    },
    { provider: "massive-stocks", asOf: "2026-11-25" },
    fakeBackend,
  );

  const sessions = [
    {
      date: "2026-08-26",
      results: [
        { T: "AAA", o: 10, h: 11, l: 9, c: 10.5, v: 5000, t: 1787692800000, n: 10 },
        { T: "DEL1", o: 20, h: 21, l: 19, c: 20.5, v: 4000, t: 1787692800000, n: 10 },
      ],
    },
    {
      date: "2026-08-27",
      results: [
        { T: "AAA", o: 11, h: 12, l: 10, c: 11.5, v: 5100, t: 1787779200000, n: 10 },
        { T: "DEL1", o: 21, h: 22, l: 20, c: 21.5, v: 4100, t: 1787779200000, n: 10 },
      ],
    },
  ];
  for (const s of sessions) {
    const rawReply = new TextEncoder().encode(
      JSON.stringify({ status: "OK", resultsCount: s.results.length, results: s.results }),
    );
    await writeDailyReplyDust(
      client,
      {
        dataset: "stocks-grouped-daily",
        sessionDate: s.date,
        request: `/v2/aggs/grouped/locale/us/market/stocks/${s.date}`,
        fetchedAt: `${s.date}T21:05:00Z`,
        body: rawReply,
      },
      { provider: "massive-stocks", observedAt: `${s.date}T21:05:00Z` },
      fakeBackend,
    );
  }
  await storage.appendBars([
    makeBar("sec_active_AAA", "2026-08-26", 10.5),
    makeBar("sec_inactive_DEL1", "2026-08-26", 20.5),
    makeBar("sec_active_AAA", "2026-08-27", 11.5),
    makeBar("sec_inactive_DEL1", "2026-08-27", 21.5),
  ]);

  const report = await runCoverageCheck(client, {
    replyDustBackend: fakeBackend,
    liveAsOfFloor: "2026-11-24",
    now: new Date("2026-11-25T17:00:00Z"),
  });

  assert.equal(report.heldOutStart, "2026-08-27");
  assert.equal(report.heldOutStart, HELD_OUT_START_DATE);
  assert.deepEqual(report.dailyBars.preHeldOutRowsByStatus, { ACTIVE: 1, INACTIVE: 1 });
  assert.deepEqual(report.dailyBars.heldOutRowsByStatus, { ACTIVE: 1, INACTIVE: 1 });
  assert.equal(report.dailyBars.inactiveIdsBeforeHeldOut, 1);
  assert.equal(report.dailyBars.inactiveIdsInHeldOut, 1);
  assert.equal(report.replyDustReopen!.expectedInactivePairsTotal, 2);
  assert.equal(report.replyDustReopen!.expectedInactivePairsPresentInBars, 2);
  assert.equal(report.replyDustReopen!.expectedInactivePairsMissingFromBars, 0);
  assert.equal(report.replyDustReopen!.expectedInactivePairsHeldOutTotal, 1);
  assert.equal(report.replyDustReopen!.expectedInactivePairsHeldOutPresentInBars, 1);
  assert.equal(report.replyDustReopen!.expectedInactivePairsHeldOutMissingFromBars, 0);
  assert.equal(report.replyDustReopen!.expectedInactiveRowsHeldOut, 1);
  assert.deepEqual(
    report.dailyBars.months.map((m) => ({
      month: m.month,
      inactivePreHeldOutRows: m.inactivePreHeldOutRows,
      inactiveHeldOutRows: m.inactiveHeldOutRows,
    })),
    [{ month: "2026-08", inactivePreHeldOutRows: 1, inactiveHeldOutRows: 1 }],
  );
});

test("coverage-check.yml workflow wiring: manual-only, main-only, site env, read-only keys & permissions", () => {
  const yml = readFileSync(new URL("../.github/workflows/coverage-check.yml", import.meta.url), "utf8");
  const triggers = yml.slice(yml.indexOf("\non:"), yml.indexOf("\npermissions:"));
  assert.match(triggers, /workflow_dispatch:/u);
  assert.doesNotMatch(triggers, /\b(push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch|workflow_call):/u);
  assert.doesNotMatch(yml, /cron:/u);
  assert.match(yml, /\npermissions:\n  contents: read\n/u);

  const jobStart = yml.indexOf("\n  coverage:\n");
  assert.ok(jobStart >= 0, "coverage job present");
  const jobHeader = yml.slice(jobStart, yml.indexOf("\n    steps:\n", jobStart));
  assert.match(jobHeader, /\n    if: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}|\n    if: github\.ref == 'refs\/heads\/main'\n/u);
  assert.match(jobHeader, /\n    environment: site\n/u);

  // Never references write keys or unrelated secrets
  assert.doesNotMatch(yml, /PEACESTOCKS_R2_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)\b/u);
  assert.doesNotMatch(yml, /MASSIVE_API_KEY|CLOUDFLARE_API_TOKEN|NET_RERUN_DISPATCH_TOKEN|PEACESTOCKS_SITE_ALLOWED_EMAIL/u);
  assert.match(yml, /secrets\.PEACESTOCKS_R2_READ_ACCESS_KEY_ID\b/u);
  assert.match(yml, /secrets\.PEACESTOCKS_R2_READ_SECRET_ACCESS_KEY\b/u);
  assert.match(yml, /secrets\.PEACESTOCKS_R2_ACCOUNT_ID\b/u);
  assert.match(yml, /secrets\.PEACESTOCKS_R2_BUCKET\b/u);
  assert.match(yml, /src\/coverage-check\.ts/u);
  assert.match(yml, /actions\/upload-artifact@v4/u);
  assert.match(yml, /\n        if: \$\{\{ always\(\) \}\}\n        uses: actions\/upload-artifact@v4\n/u);
  assert.doesNotMatch(yml, /continue-on-error:.*coverage-check/u);

  for (const line of yml.split("\n")) {
    if (/\$\{\{/u.test(line)) assert.match(line, /^\s+(?:[A-Za-z0-9_-]+|if): .*\$\{\{ [^}]+ \}\}/u, line);
  }
});
