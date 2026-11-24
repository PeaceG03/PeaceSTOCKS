import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { CanonicalDailyBar, CorporateAction, MarketProvider, ProviderSecurityRecord } from "./contracts";
import { securityId } from "./identity";
import { MemoryObjectClient } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";
import { MarketsScanner, SCAN_BAR_LOOKBACK_SESSIONS, scanBarWindowStart } from "./scanner";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

const D = "2026-10-05";
const D1 = "2026-10-06";
const MONTH_PREFIX = "permanent/daily-bars/";

function bar(id: string, date: string, close: number): CanonicalDailyBar {
  return {
    securityId: id,
    sessionDate: date,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 1000,
    observedAt: `${date}T21:00:00Z`,
    ingestedAt: `${date}T22:00:00Z`,
    dataQuality: "GOOD",
    corporateActionIds: [],
    flags: [],
    schemaVersion: "foundation-d-v0",
    revision: 1,
    provenance: { provider: "fixture-provider", dataset: "daily-ohlcv", retrievalId: "r", ingestionVersion: "t", normalizerVersion: "t" },
  };
}

/** Counts month-file reads and the most month-file reads in flight at once. */
class CountingClient extends MemoryObjectClient {
  monthReads = 0;
  inFlight = 0;
  maxInFlight = 0;
  override async get(key: string): Promise<Uint8Array | undefined> {
    if (!key.startsWith(MONTH_PREFIX)) return super.get(key);
    this.monthReads += 1;
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return await super.get(key);
    } finally {
      this.inFlight -= 1;
    }
  }
}

class Provider implements MarketProvider {
  readonly providerName = "fixture-provider";
  constructor(private readonly universe: ProviderSecurityRecord[], private readonly bars: CanonicalDailyBar[]) {}
  async listApprovedSecurities(): Promise<ProviderSecurityRecord[]> {
    return this.universe;
  }
  async getDailyBars(sessionDate: string, ids: string[]): Promise<CanonicalDailyBar[]> {
    return this.bars.filter((b) => b.sessionDate === sessionDate && ids.includes(b.securityId));
  }
  async getCorporateActions(): Promise<CorporateAction[]> {
    return [];
  }
}

/** 24 stored months (2024-10..2026-09), every trading day, for `ids` securities: a large fake history. */
async function seedHistory(client: MemoryObjectClient, ids: string[]): Promise<number> {
  let months = 0;
  for (let year = 2024, month = 10; months < 24; months += 1) {
    const ym = `${year}-${String(month).padStart(2, "0")}`;
    const rows: string[] = [];
    for (let day = 1; day <= 31; day += 1) {
      const date = `${ym}-${String(day).padStart(2, "0")}`;
      if (Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).getUTCMonth() + 1 !== month) continue;
      const kind = US_EQUITY_MARKET_CALENDAR.getSession(date).kind;
      if (kind !== "NORMAL" && kind !== "HALF_DAY") continue;
      for (const id of ids) rows.push(JSON.stringify(bar(id, date, 100 + day)));
    }
    await client.put(`${MONTH_PREFIX}${ym}.jsonl`, new TextEncoder().encode(rows.join("\n") + "\n"));
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

test("scan reads only the lookback window's months, one at a time, and counts bars once per run", async (t) => {
  const client = new CountingClient();
  const universe: ProviderSecurityRecord[] = [
    { provider: "fixture-provider", providerSecurityId: "i1", symbol: "AAA", assetType: "STOCK", country: "US", exchange: "NYSE", active: true, tradable: true },
  ];
  const id = securityId("fixture-provider", "i1", "STOCK");
  const filler = Array.from({ length: 20 }, (_, i) => `fill-${i}`);
  const months = await seedHistory(client, [id, ...filler]);
  const storage = new ObjectMarketStorage(client);
  const provider = new Provider(universe, [bar(id, D, 150), bar(id, D1, 151)]);
  const scanner = new MarketsScanner(provider, storage, undefined, undefined, () => new Date("2026-10-07T05:30:00.000Z"));

  await scanner.run(D, "EVIDENCE_ONLY");
  const firstSession = client.monthReads;
  await scanner.run(D1, "EVIDENCE_ONLY");
  const secondSession = client.monthReads - firstSession;
  t.diagnostic(`month reads: first=${firstSession} second=${secondSession} maxInFlight=${client.maxInFlight}`);

  // Window: SCAN_BAR_LOOKBACK_SESSIONS (100) back from D spans 6 calendar months.
  // Session 1: every stored month once for the bar counts, the window months, appendBars' month rewrite.
  assert.ok(firstSession <= months + 12, `first session read ${firstSession} month files (history ${months})`);
  // Session 2 reuses the counts: only the window and the rewritten month, never the whole history again.
  assert.ok(secondSession <= 12, `second session read ${secondSession} month files`);
  assert.equal(client.maxInFlight, 1, "month files are read one at a time");
});

test("loadBarsBetween returns only bars inside the window", async () => {
  const client = new CountingClient();
  await seedHistory(client, ["x"]);
  const storage = new ObjectMarketStorage(client);
  const from = scanBarWindowStart(D, US_EQUITY_MARKET_CALENDAR);
  const bars = await storage.loadBarsBetween(from, D);
  assert.ok(bars.length > 0);
  assert.ok(bars.every((b) => b.sessionDate >= from && b.sessionDate <= D));
  // One read per calendar month the window touches (6 for 100 sessions ending 2026-10-05).
  const windowMonths = (Number(D.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(D.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
  assert.equal(client.monthReads, windowMonths);
});

test("scanBarWindowStart holds exactly the lookback's trading sessions", () => {
  const from = scanBarWindowStart(D, US_EQUITY_MARKET_CALENDAR);
  let sessions = 0;
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= D; d.setUTCDate(d.getUTCDate() + 1)) {
    const kind = US_EQUITY_MARKET_CALENDAR.getSession(d.toISOString().slice(0, 10)).kind;
    if (kind === "NORMAL" || kind === "HALF_DAY") sessions += 1;
  }
  assert.equal(sessions, SCAN_BAR_LOOKBACK_SESSIONS);
  assert.ok(SCAN_BAR_LOOKBACK_SESSIONS >= 61, "MOMENTUM_60D / DRAWDOWN_60D need 61 closes");
});

test("bar counts stay exact after appendBars rewrites a month", async () => {
  const client = new CountingClient();
  await seedHistory(client, ["x"]);
  const storage = new ObjectMarketStorage(client);
  const before = (await storage.tallyBarCounts()).get("x") ?? 0;
  const reads = client.monthReads;
  await storage.appendBars([bar("x", "2026-10-01", 1), bar("x", "2026-10-02", 1)]);
  const after = (await storage.tallyBarCounts()).get("x") ?? 0;
  assert.equal(after, before + 2);
  assert.ok(client.monthReads - reads <= 3, "only the rewritten month is read again");
});

test("scanner.yml gives the scan host a 12 GB heap as a safety net", () => {
  const yml = readFileSync(new URL("../.github/workflows/scanner.yml", import.meta.url), "utf8");
  const start = yml.indexOf("      - name: Run online scanner host");
  const step = yml.slice(start, yml.indexOf("\n      - name:", start + 1));
  assert.match(step, /\n {10}NODE_OPTIONS: --max-old-space-size=12288\n/u);
});
