import assert from "node:assert/strict";
import test from "node:test";
import type {
  CanonicalDailyBar,
  CorporateAction,
  MarketProvider,
  ProviderSecurityRecord,
} from "./contracts";
import { etWallClockToUtc } from "./et-time";
import { securityId } from "./identity";
import { MarketsScanner } from "./scanner";
import { nextSessionOpen } from "./session-open";
import { ObjectMarketStorage } from "./object-storage";
import { MemoryObjectClient } from "./object-store";
import { usEquityCalendarSha256 } from "./us-calendar";

function providerRecord(
  providerSecurityId: string,
  symbol: string,
  assetType: "STOCK" | "ETF" = "STOCK",
): ProviderSecurityRecord {
  return {
    provider: "fixture-provider",
    providerSecurityId,
    symbol,
    assetType,
    country: "US",
    exchange: "NYSE",
    active: true,
    tradable: true,
  };
}

function bar(id: string, sessionDate: string, close: number): CanonicalDailyBar {
  return {
    securityId: id,
    sessionDate,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 1_000_000,
    observedAt: `${sessionDate}T21:00:00.000Z`,
    ingestedAt: `${sessionDate}T21:05:00.000Z`,
    dataQuality: "GOOD",
    corporateActionIds: [],
    flags: [],
    schemaVersion: "foundation-d-v0",
    revision: 1,
    provenance: {
      provider: "fixture-provider",
      dataset: "daily-ohlcv",
      retrievalId: `r-${sessionDate}-${id.slice(0, 8)}`,
      ingestionVersion: "test",
      normalizerVersion: "test",
    },
  };
}

/**
 * Clock starts at `startMs`. Advances to `freezeMs` on the first getDailyBars call so the
 * S2/NOT_DUE gate and host-style run-start see `start`, while S4 freeze sees `freeze`.
 */
class AdvancingClockProvider implements MarketProvider {
  readonly providerName = "fixture-provider";
  private advanced = false;
  constructor(
    private readonly clock: { ms: number },
    private readonly freezeMs: number,
    private readonly sessions: readonly string[],
  ) {}
  private universe(): ProviderSecurityRecord[] {
    return [providerRecord("issuer-1", "AAA"), providerRecord("issuer-spy", "SPY", "ETF")];
  }
  private barsFor(sessionDate: string): CanonicalDailyBar[] {
    const aaaId = securityId("fixture-provider", "issuer-1", "STOCK");
    const spyId = securityId("fixture-provider", "issuer-spy", "ETF");
    // Enough prior sessions so ranking has something to chew on.
    const prior = this.sessions;
    return prior.flatMap((d, i) => [bar(aaaId, d, 100 + i), bar(spyId, d, 400 + i)]).filter(
      (b) => b.sessionDate === sessionDate || prior.includes(b.sessionDate),
    );
  }
  async listApprovedSecurities(): Promise<ProviderSecurityRecord[]> {
    return this.universe();
  }
  async getDailyBars(sessionDate: string, ids: string[]): Promise<CanonicalDailyBar[]> {
    if (!this.advanced) {
      this.clock.ms = this.freezeMs;
      this.advanced = true;
    }
    return this.barsFor(sessionDate).filter((b) => b.sessionDate === sessionDate && ids.includes(b.securityId));
  }
  async getCorporateActions(): Promise<CorporateAction[]> {
    return [];
  }
}

async function runForward(opts: {
  sessionDate: string;
  start: Date;
  freeze: Date;
  historySessions: string[];
}) {
  const clock = { ms: opts.start.getTime() };
  const storage = new ObjectMarketStorage(new MemoryObjectClient());
  await storage.initialize();
  const provider = new AdvancingClockProvider(
    clock,
    opts.freeze.getTime(),
    opts.historySessions,
  );
  const report = await new MarketsScanner(
    provider,
    storage,
    undefined,
    undefined,
    () => new Date(clock.ms),
  ).run(opts.sessionDate, "FORWARD");
  return { report, storage, clock };
}

const CAL_SHA = usEquityCalendarSha256();

test("S4 nextSessionOpen: Friday → Monday; pre-Labor-Day Fri → Tue; half-day → next Mon", () => {
  // Fri 2026-10-02 → Mon 2026-10-05 09:30 EDT = 13:30Z
  const fri = nextSessionOpen("2026-10-02")!;
  assert.equal(fri.nextSessionDate, "2026-10-05");
  assert.equal(fri.nextSessionOpen.toISOString(), etWallClockToUtc("2026-10-05", 9, 30).toISOString());

  // Fri 2026-09-04 before Labor Day Mon 09-07 → Tue 09-08
  const preHoliday = nextSessionOpen("2026-09-04")!;
  assert.equal(preHoliday.nextSessionDate, "2026-09-08");
  assert.equal(
    preHoliday.nextSessionOpen.toISOString(),
    etWallClockToUtc("2026-09-08", 9, 30).toISOString(),
  );

  // Half day Fri 2026-11-27 (day after Thanksgiving) → Mon 2026-11-30
  const half = nextSessionOpen("2026-11-27")!;
  assert.equal(half.nextSessionDate, "2026-11-30");
  assert.equal(half.nextSessionOpen.toISOString(), etWallClockToUtc("2026-11-30", 9, 30).toISOString());
});

test("S4: D=Friday freeze Sat 05:40Z → FROZEN with correct nextSessionOpen", async () => {
  const D = "2026-10-02";
  const start = new Date("2026-10-03T05:30:00.000Z");
  const freeze = new Date("2026-10-03T05:40:00.000Z");
  const expectedOpen = etWallClockToUtc("2026-10-05", 9, 30);
  const { report, storage } = await runForward({
    sessionDate: D,
    start,
    freeze,
    historySessions: ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", D],
  });
  assert.equal(report.predictionStatus, "FROZEN");
  assert.ok(
    report.predictionReason === "PREDICTIONS_FROZEN" ||
      report.predictionReason === "NO_QUALIFYING_CANDIDATES",
  );
  assert.equal(report.predictedAt, freeze.toISOString());
  assert.equal(report.nextSessionDate, "2026-10-05");
  assert.equal(report.nextSessionOpen, expectedOpen.toISOString());
  assert.equal(report.calendarSha256, CAL_SHA);
  const statuses = await storage.loadPredictionStatuses(D);
  const frozen = statuses.find((s) => s.status === "FROZEN");
  assert.ok(frozen);
  assert.equal(frozen!.predictedAt, freeze.toISOString());
  assert.equal(frozen!.nextSessionOpen, expectedOpen.toISOString());
  assert.equal(frozen!.nextSessionDate, "2026-10-05");
  assert.equal(frozen!.calendarSha256, CAL_SHA);
  assert.ok((await storage.loadPredictions(D)).length > 0);
  assert.ok((await storage.loadBeliefs(D)).length > 0);
});

test("S4: D=Fri before Labor Day → nextSessionOpen is Tue 09-08 09:30 ET", async () => {
  const D = "2026-09-04";
  const start = new Date("2026-09-05T05:30:00.000Z");
  const freeze = new Date("2026-09-05T05:40:00.000Z");
  const { report } = await runForward({
    sessionDate: D,
    start,
    freeze,
    historySessions: ["2026-09-01", "2026-09-02", "2026-09-03", D],
  });
  assert.equal(report.predictionStatus, "FROZEN");
  assert.equal(report.nextSessionDate, "2026-09-08");
  assert.equal(report.nextSessionOpen, etWallClockToUtc("2026-09-08", 9, 30).toISOString());
});

test("S4: D=half day 2026-11-27 → nextSessionOpen Mon 11-30 09:30 ET", async () => {
  const D = "2026-11-27";
  const start = new Date("2026-11-28T05:30:00.000Z");
  const freeze = new Date("2026-11-28T05:40:00.000Z");
  const { report } = await runForward({
    sessionDate: D,
    start,
    freeze,
    historySessions: ["2026-11-24", "2026-11-25", "2026-11-26", D],
  });
  assert.equal(report.predictionStatus, "FROZEN");
  assert.equal(report.nextSessionDate, "2026-11-30");
  assert.equal(report.nextSessionOpen, etWallClockToUtc("2026-11-30", 9, 30).toISOString());
});

test("S4: run starts 09:20 ET (passes gate) but freeze exactly at 09:30 ET → FREEZE_AFTER_OPEN, no predictions", async () => {
  const D = "2026-10-06"; // Tue; next open Wed 10-07
  const open = etWallClockToUtc("2026-10-07", 9, 30);
  assert.equal(open.toISOString(), "2026-10-07T13:30:00.000Z");
  const start = new Date(open.getTime() - 10 * 60_000); // 09:20 ET
  const freeze = new Date(open.getTime()); // exactly 09:30:00
  const { report, storage } = await runForward({
    sessionDate: D,
    start,
    freeze,
    historySessions: ["2026-10-01", "2026-10-02", "2026-10-05", D],
  });
  assert.equal(report.predictionStatus, "UNAVAILABLE");
  assert.equal(report.predictionReason, "FREEZE_AFTER_OPEN");
  assert.equal(report.predictedAt, freeze.toISOString());
  assert.equal(report.nextSessionOpen, open.toISOString());
  assert.equal(report.nextSessionDate, "2026-10-07");
  assert.equal(report.calendarSha256, CAL_SHA);
  assert.equal((await storage.loadPredictions(D)).length, 0);
  assert.equal((await storage.loadBeliefs(D)).length, 0);
  const statuses = await storage.loadPredictionStatuses(D);
  assert.ok(statuses.some((s) => s.reason === "FREEZE_AFTER_OPEN" && s.status === "UNAVAILABLE"));
  assert.ok(statuses.every((s) => s.status !== "FROZEN"));
});

test("S4: freeze at 09:29:59 ET → FROZEN with predictedAt = that instant", async () => {
  const D = "2026-10-06";
  const open = etWallClockToUtc("2026-10-07", 9, 30);
  const start = new Date(open.getTime() - 10 * 60_000);
  const freeze = new Date(open.getTime() - 1000); // 09:29:59
  const { report, storage } = await runForward({
    sessionDate: D,
    start,
    freeze,
    historySessions: ["2026-10-01", "2026-10-02", "2026-10-05", D],
  });
  assert.equal(report.predictionStatus, "FROZEN");
  assert.equal(report.predictedAt, freeze.toISOString());
  assert.equal(report.nextSessionOpen, open.toISOString());
  const frozen = (await storage.loadPredictionStatuses(D)).find((s) => s.status === "FROZEN");
  assert.equal(frozen?.predictedAt, freeze.toISOString());
  assert.ok((await storage.loadPredictions(D)).length > 0);
});

test("S4: retry after FREEZE_AFTER_OPEN stays evidence-only and does not conflict", async () => {
  const D = "2026-10-06";
  const open = etWallClockToUtc("2026-10-07", 9, 30);
  const start = new Date(open.getTime() - 10 * 60_000);
  const freeze = new Date(open.getTime());
  const clock = { ms: start.getTime() };
  const storage = new ObjectMarketStorage(new MemoryObjectClient());
  await storage.initialize();
  const history = ["2026-10-01", "2026-10-02", "2026-10-05", D];
  const provider1 = new AdvancingClockProvider(clock, freeze.getTime(), history);
  const first = await new MarketsScanner(
    provider1,
    storage,
    undefined,
    undefined,
    () => new Date(clock.ms),
  ).run(D, "FORWARD");
  assert.equal(first.predictionReason, "FREEZE_AFTER_OPEN");

  // Later retry: both S2-style EVIDENCE_ONLY mode and a late FORWARD freeze stay non-FROZEN.
  const late = new Date(open.getTime() + 60_000);
  const provider2 = new AdvancingClockProvider({ ms: late.getTime() }, late.getTime(), history);
  const retryEvidence = await new MarketsScanner(
    provider2,
    storage,
    undefined,
    undefined,
    () => late,
  ).run(D, "EVIDENCE_ONLY");
  assert.equal(retryEvidence.predictionReason, "EVIDENCE_ONLY");
  assert.equal(retryEvidence.predictionStatus, "UNAVAILABLE");

  const provider3 = new AdvancingClockProvider({ ms: late.getTime() }, late.getTime(), history);
  const retryForward = await new MarketsScanner(
    provider3,
    storage,
    undefined,
    undefined,
    () => late,
  ).run(D, "FORWARD");
  assert.equal(retryForward.predictionReason, "FREEZE_AFTER_OPEN");
  assert.equal((await storage.loadPredictions(D)).length, 0);
  const statuses = await storage.loadPredictionStatuses(D);
  assert.ok(statuses.length >= 2);
  assert.ok(statuses.every((s) => s.status === "UNAVAILABLE"));
  assert.ok(!statuses.some((s) => s.status === "FROZEN"));
});
