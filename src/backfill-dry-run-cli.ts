/**
 * Backfill dry run (pre-upgrade readiness). Runs the real backfill job (src/backfill-job.ts) against
 * the in-process fake Massive (src/fake-massive.ts) into an IN-MEMORY store. No network, no
 * credentials, no bucket: the base URL is https://massive.invalid and the fake refuses any other.
 *
 *   tsx src/backfill-dry-run-cli.ts --data <local raw dir> --out <dir> \
 *     [--slice-from 2026-11-02 --slice-to 2026-11-06] [--paid-from 2021-11-01 --paid-to 2024-10-31] \
 *     [--interval-ms 12500] [--latency-ms 250] [--paid-tickers 200]
 *
 * 1. Slice: the fake serves grouped-daily replies rebuilt from the LOCAL stored bars of a few real
 *    sessions; the job is interrupted after 2 sessions and resumed; the stored bars are compared
 *    field by field with the local source.
 * 2. Paid tier: a synthetic market, plan window from --paid-from. A probe one week before it must
 *    stop with PLAN_WINDOW; then the whole range runs with a virtual clock at the request spacing
 *    (plus simulated latency) to count requests and hours.
 * Prints aggregates only (no symbols, no ids) and writes <out>/dry-run.json.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SecurityMasterRecord } from "./contracts";
import { runBackfillJob, type BackfillJobReport } from "./backfill-job";
import { FAKE_MASSIVE_BASE_URL, fakeMassive, syntheticMarket, type FakeGroupedRow, type FakeTicker } from "./fake-massive";
import { MemoryObjectClient } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";
import { symbolOn } from "./pit-universe";

function arg(args: string[], key: string, fallback?: string): string {
  const i = args.indexOf(`--${key}`);
  const v = i < 0 ? fallback : args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`MISSING_ARG:${key}`);
  return v;
}

interface LocalBar { securityId: string; sessionDate: string; open: number; high: number; low: number; close: number; volume: number; revision: number }

async function localBars(root: string, from: string, to: string): Promise<Map<string, Map<string, LocalBar>>> {
  const byDate = new Map<string, Map<string, LocalBar>>();
  const months = new Set([from.slice(0, 7), to.slice(0, 7)]);
  for (const month of [...months].sort()) {
    const path = join(root, "permanent/daily-bars", `${month}.jsonl`);
    if (!existsSync(path)) continue;
    for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
      if (!line) continue;
      const b = JSON.parse(line) as LocalBar;
      if (b.sessionDate < from || b.sessionDate > to) continue;
      let day = byDate.get(b.sessionDate);
      if (!day) byDate.set(b.sessionDate, (day = new Map()));
      const prior = day.get(b.securityId);
      if (!prior || b.revision >= prior.revision) day.set(b.securityId, b);
    }
  }
  return byDate;
}

function virtualClock(latencyMs: number) {
  let now = Date.parse("2026-11-24T12:00:00Z");
  return {
    clock: () => now,
    sleep: async (ms: number) => {
      await new Promise((r) => setImmediate(r));
      now += ms;
    },
    latency: () => {
      now += latencyMs;
      return undefined;
    },
    now: () => new Date(now).toISOString(),
  };
}

const pinned = () => "*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***";

async function storedBytes(client: MemoryObjectClient, prefixes: string[]): Promise<number> {
  let total = 0;
  for (const prefix of prefixes) for (const item of await client.listSizes(prefix)) total += item.size;
  return total;
}

export async function dryRunMain(args: string[]): Promise<void> {
  const root = arg(args, "data");
  const out = arg(args, "out");
  mkdirSync(out, { recursive: true });
  const interval = Number(arg(args, "interval-ms", "12500"));
  const latencyMs = Number(arg(args, "latency-ms", "250"));
  const sliceFrom = arg(args, "slice-from", "2026-11-02");
  const sliceTo = arg(args, "slice-to", "2026-11-06");
  const paidFrom = arg(args, "paid-from", "2021-11-01");
  const paidTo = arg(args, "paid-to", "2024-10-31");
  const log = (line: string) => console.log(`[dry-run] ${line}`);
  const summary = (r: BackfillJobReport) =>
    `status=${r.status}${r.stopReason ? ` stop=${r.stopReason}` : ""} checkpoint=${r.checkpointSessions} verified=${r.sessionsVerified} packsWritten=${r.packsWritten} sealedBefore=${r.packsAlreadySealed} rows=${r.barRows} distinct=${r.distinctBarKeys} requests=${r.requests} minGapMs=${r.minRequestGapMs}`;

  // 1. Slice of the local 2-year window.
  const master = JSON.parse(readFileSync(join(root, "permanent/security-master.json"), "utf8")) as SecurityMasterRecord[];
  const massiveId = (s: SecurityMasterRecord) => s.providerIdentities.find((p) => p.provider === "massive-stocks")?.providerSecurityId;
  const tickers: FakeTicker[] = master.flatMap((s) => {
    const figi = massiveId(s);
    return figi
      ? [{ ticker: s.currentSymbol, figi, type: s.assetType === "ETF" ? ("ETF" as const) : ("CS" as const), active: s.status === "ACTIVE", ...(s.delistedAt ? { delistedDate: s.delistedAt } : {}) }]
      : [];
  });
  const source = await localBars(root, sliceFrom, sliceTo);
  const byId = new Map(master.map((s) => [s.securityId, s]));
  // Why a local row cannot be replayed through grouped daily (it has no symbol that day, or shares one).
  const unreplayable = new Map<string, "NO_SYMBOL_ON_DATE" | "NO_PROVIDER_ID" | "SYMBOL_SHARED">();
  const grouped = (date: string): FakeGroupedRow[] => {
    const rows: FakeGroupedRow[] = [];
    const seen = new Set<string>();
    for (const bar of source.get(date)?.values() ?? []) {
      const security = byId.get(bar.securityId);
      const symbol = security ? symbolOn(security, date) : undefined;
      if (!security || !massiveId(security)) unreplayable.set(`${date}|${bar.securityId}`, "NO_PROVIDER_ID");
      if (!symbol) unreplayable.set(`${date}|${bar.securityId}`, "NO_SYMBOL_ON_DATE");
      if (!symbol || seen.has(symbol)) {
        if (symbol) unreplayable.set(`${date}|${bar.securityId}`, "SYMBOL_SHARED");
        continue;
      }
      seen.add(symbol);
      rows.push({ T: symbol, o: bar.open, h: bar.high, l: bar.low, c: bar.close, v: bar.volume });
    }
    return rows;
  };
  const sliceClient = new MemoryObjectClient();
  const sliceStorage = new ObjectMarketStorage(sliceClient);
  const sliceClock = virtualClock(latencyMs);
  const sliceFake = fakeMassive({ tickers, grouped, onRequest: sliceClock.latency });
  const sliceOptions = (maxSessions?: number) => ({
    from: sliceFrom, to: sliceTo, storage: sliceStorage, store: sliceClient, fetchImpl: sliceFake.fetchImpl, apiKey: "dry-run-not-a-key",
    baseUrl: FAKE_MASSIVE_BASE_URL, minRequestIntervalMs: interval, clock: sliceClock.clock, sleep: sliceClock.sleep, now: sliceClock.now,
    zstdVersionProbe: pinned, ...(maxSessions !== undefined ? { maxSessions } : {}),
  });
  const interrupted = await runBackfillJob(sliceOptions(2));
  log(`slice ${sliceFrom}..${sliceTo} run 1 (stopped after 2 sessions): ${summary(interrupted)}`);
  const groupedBefore = sliceFake.calls.grouped.length;
  const resumed = await runBackfillJob(sliceOptions());
  log(`slice run 2 (resume): ${summary(resumed)} groupedFetchedOnResume=${sliceFake.calls.grouped.length - groupedBefore}`);
  let compared = 0;
  let mismatched = 0;
  let missing = 0;
  const missingBy: Record<string, number> = {};
  for (const [date, bars] of source) {
    const stored = new Map((await sliceStorage.loadBars(date)).map((b) => [b.securityId, b]));
    for (const bar of bars.values()) {
      const got = stored.get(bar.securityId);
      if (!got) {
        missing += 1;
        const why = unreplayable.get(`${date}|${bar.securityId}`) ?? "DROPPED_BY_BACKFILL";
        missingBy[why] = (missingBy[why] ?? 0) + 1;
        continue;
      }
      compared += 1;
      if (got.open !== bar.open || got.high !== bar.high || got.low !== bar.low || got.close !== bar.close || got.volume !== bar.volume) mismatched += 1;
    }
  }
  const sliceSessions = resumed.checkpointSessions;
  const sliceBytes = await storedBytes(sliceClient, ["permanent/daily-reply-dust/", "permanent/daily-bars-sidecar/"]);
  const jsonlBytes = await storedBytes(sliceClient, ["permanent/daily-bars/"]);
  log(`slice round trip: compared=${compared} mismatched=${mismatched} sourceRowsNotStored=${missing} ${JSON.stringify(missingBy)}`);
  log(`slice bytes per session: packs+dust=${Math.round(sliceBytes / Math.max(1, sliceSessions))} jsonl=${Math.round(jsonlBytes / Math.max(1, sliceSessions))}`);

  // 2. Mocked paid tier.
  const market = syntheticMarket(Number(arg(args, "paid-tickers", "200")));
  const paidClient = new MemoryObjectClient();
  const paidStorage = new ObjectMarketStorage(paidClient);
  const paidClock = virtualClock(latencyMs);
  const paidFake = fakeMassive({ tickers: market.tickers, grouped: market.grouped, planFrom: paidFrom, onRequest: paidClock.latency });
  const paidOptions = (from: string, to: string) => ({
    from, to, storage: paidStorage, store: paidClient, fetchImpl: paidFake.fetchImpl, apiKey: "dry-run-not-a-key",
    baseUrl: FAKE_MASSIVE_BASE_URL, minRequestIntervalMs: interval, clock: paidClock.clock, sleep: paidClock.sleep, now: paidClock.now, zstdVersionProbe: pinned,
  });
  const probeFrom = new Date(Date.parse(`${paidFrom}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
  const probe = await runBackfillJob(paidOptions(probeFrom, paidFrom));
  log(`paid-tier probe ${probeFrom}..${paidFrom} (before the plan window): ${summary(probe)}`);
  const started = Date.now();
  const paid = await runBackfillJob(paidOptions(paidFrom, paidTo));
  log(`paid-tier ${paidFrom}..${paidTo}: ${summary(paid)} simulatedHours=${(paid.elapsedMs / 3_600_000).toFixed(2)} wallSeconds=${((Date.now() - started) / 1000).toFixed(0)}`);
  const report = {
    noNetwork: `fetch goes only to ${FAKE_MASSIVE_BASE_URL} (in-process fake); store is in memory`,
    intervalMs: interval,
    latencyMs,
    slice: { from: sliceFrom, to: sliceTo, interrupted, resumed, roundTrip: { compared, mismatched, sourceRowsNotStored: missing, sourceRowsNotStoredBy: missingBy }, bytesPerSession: { packsAndDust: sliceBytes / Math.max(1, sliceSessions), jsonl: jsonlBytes / Math.max(1, sliceSessions) } },
    paid: { from: paidFrom, to: paidTo, probe, run: paid, simulatedHours: paid.elapsedMs / 3_600_000, calls: { ...paidFake.calls, grouped: paidFake.calls.grouped.length } },
  };
  writeFileSync(join(out, "dry-run.json"), `${JSON.stringify(report, null, 2)}\n`);
  const ok =
    interrupted.status === "STOPPED_RESUMABLE" && resumed.status === "COMPLETE" && mismatched === 0 &&
    probe.stopReason === "PLAN_WINDOW" && paid.status === "COMPLETE" && resumed.barRows === resumed.distinctBarKeys && paid.barRows === paid.distinctBarKeys;
  log(ok ? "DRY RUN PASS" : "DRY RUN FAIL");
  if (!ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await dryRunMain(process.argv.slice(2));
