/**
 * Read-only R2 coverage check (aggregates only; never tickers, securityIds, or prices).
 *
 * Reads ONLY via ReadOnlyR2Client (GET/HEAD only, PEACESTOCKS_R2_READ_* keys only — never write keys).
 * Computes:
 * - Live security-master record count, INACTIVE count, symbol-collision bound, lastUniverseSeenAt bounds.
 * - Live ticker-reference-index asOf (verifying it is a live/today date, not a historical chunk --to date).
 * - Per-month and pre/post-held-out (>= 2026-08-27) daily-bars counts and distinct INACTIVE ids with >= 1 bar.
 * - Optional Reply Dust replay (pointInTimeUniverse -> readDailyReplyDustBars -> filterReopenBars) to measure
 *   expected INACTIVE coverage by exact securityId|sessionDate|revision pairs (overall and held-out
 *   >= 2026-08-27 separately). Id-level any-bar counts are secondary. Exits non-zero when any expected
 *   pair is missing or any anomaly fires (including IDEMPOTENCY_WOULD_ADD_ROWS, INDEX_ASOF_NOT_LIVE).
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { filterReopenBars } from "./backfill";
import {
  MARKET_SCHEMA_VERSION,
  type CanonicalDailyBar,
  type SecurityMasterRecord,
} from "./contracts";
import { readDailyReplyDustBars } from "./daily-reply-dust";
import { tradingSessionsInRange } from "./daily-bars-coverage";
import { pointInTimeUniverse } from "./pit-universe";
import { ReadOnlyR2Client } from "./r2-read-client";
import { nodeReplyDustBackend, type ReplyDustBackend } from "./reply-dust";
import { READ_ONLY_ERROR } from "./r2-read-client";
import { readReason } from "./site-read-error";
import { listTickerReferenceIndexHistory } from "./ticker-reference-index";

export const HELD_OUT_START_DATE = "2026-08-27";
export const DEFAULT_REOPEN_FROM = "2024-10-11";
export const DEFAULT_REOPEN_TO = "2026-11-23";
export const DEFAULT_LIVE_ASOF_FLOOR = "2026-11-24";
const DEFAULT_PROVIDER = "massive-stocks";
const DAILY_BARS_PREFIX = "permanent/daily-bars/";
const DAILY_REPLY_DUST_PREFIX = "permanent/daily-reply-dust/";
const SECURITY_MASTER_KEY = "permanent/security-master.json";
const REOPEN_STATE_KEY = "backfill-reopen-state.json";

export interface CoverageReader {
  get(key: string): Promise<Uint8Array | undefined>;
  list(prefix: string): Promise<string[]>;
}

export interface CoverageMonthSummary {
  month: string;
  sessions: number;
  totalRows: number;
  activeRows: number;
  inactiveRows: number;
  unknownRows: number;
  inactivePreHeldOutRows: number;
  inactiveHeldOutRows: number;
  distinctInactiveIds: number;
}

export interface ReplyDustMonthSummary {
  month: string;
  dustSessions: number;
  expectedInactiveRows: number;
  expectedInactiveRowsPresent: number;
  expectedInactiveRowsMissing: number;
  idempotencyWouldAddInactiveRows: number;
}

export interface CoverageCheckReport {
  schemaVersion: "coverage-check-v1";
  generatedAt: string;
  reopenWindow: { from: string; to: string };
  heldOutStart: string;
  liveAsOfFloor: string;
  securityMaster: {
    totalRecords: number;
    byStatus: Record<string, number>;
    byAssetType: Record<string, number>;
    inactiveTotal: number;
    inactiveWithListingDate: number;
    inactiveWithDelistedAt: number;
    inactiveWithInactiveAt: number;
    inactiveSharingActiveSymbol: number;
    lastUniverseSeenAtMin: string | null;
    lastUniverseSeenAtMax: string | null;
    lastUniverseSeenAtOnOrAfterLiveFloorCount: number;
  };
  tickerReferenceIndex: {
    present: boolean;
    asOf: string | null;
    baseAsOf: string | null;
    deltasCount: number;
    historyLength: number;
    records: { active: number; inactive: number } | null;
    pages: { active: number; inactive: number } | null;
    asOfIsLiveDate: boolean;
  };
  reopenState: {
    present: boolean;
    completedSessionsCount: number;
    minCompletedDate: string | null;
    maxCompletedDate: string | null;
    updatedAt: string | null;
  };
  dailyBars: {
    monthFilesCount: number;
    totalSessions: number;
    minSessionDate: string | null;
    maxSessionDate: string | null;
    totalRows: number;
    duplicateKeysCount: number;
    rowsByStatus: Record<string, number>;
    preHeldOutRowsByStatus: Record<string, number>;
    heldOutRowsByStatus: Record<string, number>;
    activeIdsWithAnyBar: number;
    inactiveIdsWithAnyBar: number;
    inactiveIdsWithZeroBars: number;
    inactiveIdsBeforeHeldOut: number;
    inactiveIdsInHeldOut: number;
    inactiveIdsOnlyBeforeHeldOut: number;
    inactiveIdsOnlyInHeldOut: number;
    inactiveIdsInBothWindows: number;
    inactiveIdsInReopenWindow: number;
    months: CoverageMonthSummary[];
  };
  replyDustReopen?: {
    dustManifestsTotal: number;
    dustSessionsInReopenWindow: number;
    missingDustSessionsInReopenWindow: number;
    expectedInactiveIdsCount: number;
    expectedInactiveIdsPresentInBars: number;
    expectedInactiveIdsMissingFromBars: number;
    expectedInactiveIdsCoverageFraction: number | null;
    expectedInactiveRowsTotal: number;
    expectedInactiveRowsPresentInBars: number;
    expectedInactiveRowsMissingFromBars: number;
    expectedInactiveRowsHeldOut: number;
    expectedInactivePairsTotal: number;
    expectedInactivePairsPresentInBars: number;
    expectedInactivePairsMissingFromBars: number;
    expectedInactivePairsCoverageFraction: number | null;
    expectedInactivePairsHeldOutTotal: number;
    expectedInactivePairsHeldOutPresentInBars: number;
    expectedInactivePairsHeldOutMissingFromBars: number;
    expectedInactivePairsHeldOutCoverageFraction: number | null;
    idempotencyWouldAddInactiveRows: number;
    idempotencyWouldAddNonInactiveRows: number;
    idempotencySkippedCollisionRows: number;
    idempotencySkippedNonInactiveRows: number;
    months: ReplyDustMonthSummary[];
  };
  anomalies: string[];
}

export interface CoverageCheckOptions {
  provider?: string;
  reopenFrom?: string;
  reopenTo?: string;
  heldOutStart?: string;
  liveAsOfFloor?: string;
  skipReplyDust?: boolean;
  replyDustBackend?: ReplyDustBackend;
  replyDustConcurrency?: number;
  now?: Date;
}

const utf8Decoder = new TextDecoder();

function detachString(value: string): string {
  return Buffer.from(value, "utf8").toString("utf8");
}

function scanJsonlLines(raw: Uint8Array, onLine: (lineBytes: Uint8Array) => void): void {
  let pos = 0;
  while (pos < raw.byteLength) {
    const nl = raw.indexOf(0x0a, pos);
    const end = nl === -1 ? raw.byteLength : nl;
    if (end > pos) onLine(raw.subarray(pos, end));
    pos = nl === -1 ? raw.byteLength : nl + 1;
  }
}

function increment(map: Record<string, number>, key: string, delta = 1): void {
  map[key] = (map[key] ?? 0) + delta;
}

function sortedCounts(map: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(map).sort()) out[key] = map[key]!;
  return out;
}

const BAR_TEMPLATE: Omit<CanonicalDailyBar, "securityId" | "sessionDate" | "revision"> = {
  open: 0,
  high: 0,
  low: 0,
  close: 0,
  volume: 0,
  observedAt: "",
  ingestedAt: "",
  dataQuality: "GOOD",
  corporateActionIds: [],
  flags: [],
  schemaVersion: MARKET_SCHEMA_VERSION,
  provenance: { provider: "coverage-check", dataset: "stocks-grouped-daily", retrievalId: "read-only", ingestionVersion: "v0", normalizerVersion: "v0" },
};

function makeMinimalBar(securityId: string, sessionDate: string, revision: number): CanonicalDailyBar {
  return { ...BAR_TEMPLATE, securityId, sessionDate, revision };
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runCoverageCheck(
  client: CoverageReader,
  options: CoverageCheckOptions = {},
): Promise<CoverageCheckReport> {
  const provider = options.provider ?? DEFAULT_PROVIDER;
  const reopenFrom = options.reopenFrom ?? DEFAULT_REOPEN_FROM;
  const reopenTo = options.reopenTo ?? DEFAULT_REOPEN_TO;
  const heldOutStart = options.heldOutStart ?? HELD_OUT_START_DATE;
  const liveAsOfFloor = options.liveAsOfFloor ?? DEFAULT_LIVE_ASOF_FLOOR;
  const skipReplyDust = options.skipReplyDust === true;
  const replyDustBackend = options.replyDustBackend ?? nodeReplyDustBackend;
  const replyDustConcurrency = options.replyDustConcurrency ?? 8;
  const now = options.now ?? new Date();

  const anomalies: string[] = [];

  // 1. Security master (aggregates only)
  const masterBytes = await client.get(SECURITY_MASTER_KEY);
  if (!masterBytes || masterBytes.byteLength === 0) throw new Error("COVERAGE_SECURITY_MASTER_MISSING");
  const securities = JSON.parse(utf8Decoder.decode(masterBytes)) as SecurityMasterRecord[];
  const secById = new Map<string, SecurityMasterRecord>();
  const statusById = new Map<string, string>();
  const byStatus: Record<string, number> = {};
  const byAssetType: Record<string, number> = {};
  const activeSymbols = new Set<string>();
  let inactiveTotal = 0;
  let inactiveWithListingDate = 0;
  let inactiveWithDelistedAt = 0;
  let inactiveWithInactiveAt = 0;
  let lastUniverseSeenAtMin: string | null = null;
  let lastUniverseSeenAtMax: string | null = null;
  let lastUniverseSeenAtOnOrAfterLiveFloorCount = 0;

  for (const s of securities) {
    secById.set(s.securityId, s);
    statusById.set(s.securityId, s.status);
    increment(byStatus, s.status);
    increment(byAssetType, s.assetType);
    if (s.status === "ACTIVE") activeSymbols.add(s.currentSymbol);
    if (s.lastUniverseSeenAt) {
      const seenDate = s.lastUniverseSeenAt.slice(0, 10);
      if (lastUniverseSeenAtMin === null || seenDate < lastUniverseSeenAtMin) lastUniverseSeenAtMin = seenDate;
      if (lastUniverseSeenAtMax === null || seenDate > lastUniverseSeenAtMax) lastUniverseSeenAtMax = seenDate;
      if (seenDate >= liveAsOfFloor) lastUniverseSeenAtOnOrAfterLiveFloorCount += 1;
    }
  }
  let inactiveSharingActiveSymbol = 0;
  for (const s of securities) {
    if (s.status === "INACTIVE") {
      inactiveTotal += 1;
      if (s.listingDate) inactiveWithListingDate += 1;
      if (s.delistedAt) inactiveWithDelistedAt += 1;
      if (s.inactiveAt) inactiveWithInactiveAt += 1;
      if (activeSymbols.has(s.currentSymbol)) inactiveSharingActiveSymbol += 1;
    }
  }

  // 2. Ticker reference index manifest & history chain (metadata only; no .zst decompression)
  const indexHistory = await listTickerReferenceIndexHistory(client);
  const liveIndex = indexHistory[0]?.manifest;
  const indexAsOf = liveIndex?.asOf ?? null;
  const asOfIsLiveDate = indexAsOf !== null && indexAsOf >= liveAsOfFloor;
  if (!liveIndex) anomalies.push("TICKER_REFERENCE_INDEX_MISSING");
  else if (!asOfIsLiveDate) anomalies.push(`INDEX_ASOF_NOT_LIVE:${indexAsOf}`);

  if (lastUniverseSeenAtMax === null || lastUniverseSeenAtMax < liveAsOfFloor) {
    anomalies.push(`SECURITY_MASTER_LAST_SEEN_NOT_LIVE:${lastUniverseSeenAtMax ?? "NONE"}`);
  }

  // 3. Backfill reopen checkpoint state (metadata only)
  const reopenRaw = await client.get(REOPEN_STATE_KEY);
  let reopenStateReport: CoverageCheckReport["reopenState"] = {
    present: false,
    completedSessionsCount: 0,
    minCompletedDate: null,
    maxCompletedDate: null,
    updatedAt: null,
  };
  if (reopenRaw && reopenRaw.byteLength > 0) {
    const parsed = JSON.parse(utf8Decoder.decode(reopenRaw)) as {
      completedSessions?: string[];
      updatedAt?: string;
    };
    const completed = [...(parsed.completedSessions ?? [])].sort();
    reopenStateReport = {
      present: true,
      completedSessionsCount: completed.length,
      minCompletedDate: completed[0] ?? null,
      maxCompletedDate: completed.at(-1) ?? null,
      updatedAt: parsed.updatedAt ?? null,
    };
  }

  // 4. Discover daily-bars month files and (optionally) Reply Dust manifests
  const barKeys = (await client.list(DAILY_BARS_PREFIX))
    .filter((k) => /^permanent\/daily-bars\/\d{4}-\d{2}\.jsonl$/u.test(k))
    .sort();

  const dustDatesByMonth = new Map<string, string[]>();
  let dustManifestsTotal = 0;
  let dustSessionsInReopenWindow = 0;
  let missingDustSessionsInReopenWindow = 0;
  if (!skipReplyDust) {
    const dustKeys = await client.list(DAILY_REPLY_DUST_PREFIX);
    const dustDateSet = new Set<string>();
    for (const k of dustKeys) {
      const match = /^permanent\/daily-reply-dust\/(\d{4}-\d{2}-\d{2})\/manifest\.json$/u.exec(k);
      if (match) dustDateSet.add(match[1]!);
    }
    dustManifestsTotal = dustDateSet.size;
    const expectedWindowSessions = tradingSessionsInRange(reopenFrom, reopenTo);
    for (const sessionDate of expectedWindowSessions) {
      if (dustDateSet.has(sessionDate)) {
        dustSessionsInReopenWindow += 1;
        const month = sessionDate.slice(0, 7);
        let list = dustDatesByMonth.get(month);
        if (!list) dustDatesByMonth.set(month, (list = []));
        list.push(sessionDate);
      } else {
        missingDustSessionsInReopenWindow += 1;
      }
    }
  }

  // 5. Stream daily-bars one month at a time (plus Reply Dust check for that month while bars are resident)
  const readOnlyDustStore = {
    get: (key: string) => client.get(key),
    put: async () => {
      throw new Error(READ_ONLY_ERROR);
    },
    head: async () => undefined,
    list: async () => [],
  };

  let totalRows = 0;
  let duplicateKeysCount = 0;
  const rowsByStatus: Record<string, number> = {};
  const preHeldOutRowsByStatus: Record<string, number> = {};
  const heldOutRowsByStatus: Record<string, number> = {};
  const allSessions = new Set<string>();
  let minSessionDate: string | null = null;
  let maxSessionDate: string | null = null;

  const activeIdsWithAnyBar = new Set<string>();
  const inactiveIdsWithAnyBar = new Set<string>();
  const inactiveIdsBeforeHeldOut = new Set<string>();
  const inactiveIdsInHeldOut = new Set<string>();
  const inactiveIdsInReopenWindow = new Set<string>();
  const months: CoverageMonthSummary[] = [];

  const expectedInactiveIds = new Set<string>();
  let expectedInactiveRowsTotal = 0;
  let expectedInactiveRowsPresentInBars = 0;
  let expectedInactiveRowsMissingFromBars = 0;
  let expectedInactiveRowsHeldOut = 0;
  let expectedInactivePairsHeldOutPresentInBars = 0;
  let expectedInactivePairsHeldOutMissingFromBars = 0;
  let idempotencyWouldAddInactiveRows = 0;
  let idempotencyWouldAddNonInactiveRows = 0;
  let idempotencySkippedCollisionRows = 0;
  let idempotencySkippedNonInactiveRows = 0;
  const replyDustMonths: ReplyDustMonthSummary[] = [];

  for (const key of barKeys) {
    const monthMatch = /^permanent\/daily-bars\/(\d{4}-\d{2})\.jsonl$/u.exec(key);
    const month = monthMatch![1]!;
    const raw = await client.get(key);
    if (!raw) continue;

    const monthSessions = new Set<string>();
    const monthInactiveIds = new Set<string>();
    const monthKeySet = new Set<string>();
    const monthBarsBySession = new Map<string, CanonicalDailyBar[]>();
    let monthTotalRows = 0;
    let monthActiveRows = 0;
    let monthInactiveRows = 0;
    let monthUnknownRows = 0;
    let monthInactivePreHeldOutRows = 0;
    let monthInactiveHeldOutRows = 0;
    const needSessionBars = !skipReplyDust && (dustDatesByMonth.get(month)?.length ?? 0) > 0;

    scanJsonlLines(raw, (lineBytes) => {
      const parsed = JSON.parse(utf8Decoder.decode(lineBytes)) as {
        securityId: string;
        sessionDate: string;
        revision: number;
      };
      const sid = detachString(parsed.securityId);
      const sessionDate = detachString(parsed.sessionDate);
      const revision = parsed.revision;

      totalRows += 1;
      monthTotalRows += 1;
      monthSessions.add(sessionDate);
      allSessions.add(sessionDate);
      if (minSessionDate === null || sessionDate < minSessionDate) minSessionDate = sessionDate;
      if (maxSessionDate === null || sessionDate > maxSessionDate) maxSessionDate = sessionDate;

      const barKey = `${sid}|${sessionDate}|${revision}`;
      if (monthKeySet.has(barKey)) duplicateKeysCount += 1;
      else monthKeySet.add(barKey);

      const status = statusById.get(sid) ?? "UNKNOWN";
      increment(rowsByStatus, status);
      if (sessionDate < heldOutStart) increment(preHeldOutRowsByStatus, status);
      else increment(heldOutRowsByStatus, status);

      if (status === "ACTIVE") {
        monthActiveRows += 1;
        activeIdsWithAnyBar.add(sid);
      } else if (status === "INACTIVE") {
        monthInactiveRows += 1;
        monthInactiveIds.add(sid);
        inactiveIdsWithAnyBar.add(sid);
        if (sessionDate < heldOutStart) {
          monthInactivePreHeldOutRows += 1;
          inactiveIdsBeforeHeldOut.add(sid);
        } else {
          monthInactiveHeldOutRows += 1;
          inactiveIdsInHeldOut.add(sid);
        }
        if (sessionDate >= reopenFrom && sessionDate <= reopenTo) {
          inactiveIdsInReopenWindow.add(sid);
        }
      } else {
        monthUnknownRows += 1;
      }

      if (needSessionBars) {
        let list = monthBarsBySession.get(sessionDate);
        if (!list) monthBarsBySession.set(sessionDate, (list = []));
        list.push(makeMinimalBar(sid, sessionDate, revision));
      }
    });

    months.push({
      month,
      sessions: monthSessions.size,
      totalRows: monthTotalRows,
      activeRows: monthActiveRows,
      inactiveRows: monthInactiveRows,
      unknownRows: monthUnknownRows,
      inactivePreHeldOutRows: monthInactivePreHeldOutRows,
      inactiveHeldOutRows: monthInactiveHeldOutRows,
      distinctInactiveIds: monthInactiveIds.size,
    });

    const dustDates = dustDatesByMonth.get(month);
    if (!skipReplyDust && dustDates && dustDates.length > 0) {
      let mExpectedRows = 0;
      let mExpectedPresent = 0;
      let mExpectedMissing = 0;
      let mIdempAddInactive = 0;

      const sessionOutcomes = await mapConcurrent(dustDates, replyDustConcurrency, async (sessionDate) => {
        const pit = pointInTimeUniverse(securities, sessionDate, provider);
        const dustBars = await readDailyReplyDustBars(
          readOnlyDustStore,
          sessionDate,
          pit.bySymbol,
          replyDustBackend,
        );
        const sessionExisting = monthBarsBySession.get(sessionDate) ?? [];
        const activeOnlyExisting = sessionExisting.filter((b) => statusById.get(b.securityId) === "ACTIVE");
        const liveKeySet = new Set(sessionExisting.map((b) => `${b.securityId}|${b.sessionDate}|${b.revision}`));
        const expected = filterReopenBars(dustBars, activeOnlyExisting, securities, sessionDate);
        const idempotent = filterReopenBars(dustBars, sessionExisting, securities, sessionDate);

        const expectedIds: string[] = [];
        let presentCount = 0;
        let missingCount = 0;
        let heldOutCount = 0;
        let heldOutPresentCount = 0;
        let heldOutMissingCount = 0;
        for (const b of expected.newBars) {
          expectedIds.push(b.securityId);
          const present = liveKeySet.has(`${b.securityId}|${b.sessionDate}|${b.revision}`);
          const heldOut = b.sessionDate >= heldOutStart;
          if (present) presentCount += 1;
          else missingCount += 1;
          if (heldOut) {
            heldOutCount += 1;
            if (present) heldOutPresentCount += 1;
            else heldOutMissingCount += 1;
          }
        }
        return {
          expectedIds,
          expectedRows: expected.newBars.length,
          presentCount,
          missingCount,
          heldOutCount,
          heldOutPresentCount,
          heldOutMissingCount,
          idempotentAdded: idempotent.addedByStatus,
          idempotentSkippedCollision: idempotent.skippedCollisionByStatus,
          idempotentSkippedNonInactive: idempotent.skippedNonInactiveByStatus,
        };
      });

      for (const out of sessionOutcomes) {
        for (const sid of out.expectedIds) expectedInactiveIds.add(sid);
        expectedInactiveRowsTotal += out.expectedRows;
        expectedInactiveRowsPresentInBars += out.presentCount;
        expectedInactiveRowsMissingFromBars += out.missingCount;
        expectedInactiveRowsHeldOut += out.heldOutCount;
        expectedInactivePairsHeldOutPresentInBars += out.heldOutPresentCount;
        expectedInactivePairsHeldOutMissingFromBars += out.heldOutMissingCount;
        mExpectedRows += out.expectedRows;
        mExpectedPresent += out.presentCount;
        mExpectedMissing += out.missingCount;

        for (const [st, cnt] of Object.entries(out.idempotentAdded)) {
          if (st === "INACTIVE") {
            idempotencyWouldAddInactiveRows += cnt;
            mIdempAddInactive += cnt;
          } else {
            idempotencyWouldAddNonInactiveRows += cnt;
          }
        }
        for (const cnt of Object.values(out.idempotentSkippedCollision)) idempotencySkippedCollisionRows += cnt;
        for (const cnt of Object.values(out.idempotentSkippedNonInactive)) idempotencySkippedNonInactiveRows += cnt;
      }

      replyDustMonths.push({
        month,
        dustSessions: dustDates.length,
        expectedInactiveRows: mExpectedRows,
        expectedInactiveRowsPresent: mExpectedPresent,
        expectedInactiveRowsMissing: mExpectedMissing,
        idempotencyWouldAddInactiveRows: mIdempAddInactive,
      });
    }
  }

  let inactiveIdsOnlyBeforeHeldOut = 0;
  let inactiveIdsOnlyInHeldOut = 0;
  let inactiveIdsInBothWindows = 0;
  for (const sid of inactiveIdsWithAnyBar) {
    const pre = inactiveIdsBeforeHeldOut.has(sid);
    const held = inactiveIdsInHeldOut.has(sid);
    if (pre && held) inactiveIdsInBothWindows += 1;
    else if (pre) inactiveIdsOnlyBeforeHeldOut += 1;
    else if (held) inactiveIdsOnlyInHeldOut += 1;
  }

  if (duplicateKeysCount > 0) anomalies.push(`DUPLICATE_BAR_KEYS:${duplicateKeysCount}`);
  if ((rowsByStatus.UNKNOWN ?? 0) > 0) anomalies.push(`UNKNOWN_SECURITY_IDS:${rowsByStatus.UNKNOWN}`);

  let replyDustReport: CoverageCheckReport["replyDustReopen"];
  if (!skipReplyDust) {
    let expectedPresentIds = 0;
    let expectedMissingIds = 0;
    for (const sid of expectedInactiveIds) {
      if (inactiveIdsWithAnyBar.has(sid)) expectedPresentIds += 1;
      else expectedMissingIds += 1;
    }
    const expectedInactivePairsTotal = expectedInactiveRowsTotal;
    const expectedInactivePairsPresentInBars = expectedInactiveRowsPresentInBars;
    const expectedInactivePairsMissingFromBars = expectedInactiveRowsMissingFromBars;
    const expectedInactivePairsHeldOutTotal = expectedInactiveRowsHeldOut;
    if (expectedInactivePairsMissingFromBars > 0) {
      anomalies.push(`EXPECTED_INACTIVE_PAIRS_MISSING:${expectedInactivePairsMissingFromBars}`);
    }
    if (expectedMissingIds > 0) anomalies.push(`EXPECTED_INACTIVE_IDS_MISSING:${expectedMissingIds}`);
    if (idempotencyWouldAddInactiveRows > 0 || idempotencyWouldAddNonInactiveRows > 0) {
      anomalies.push(`IDEMPOTENCY_WOULD_ADD_ROWS:${idempotencyWouldAddInactiveRows + idempotencyWouldAddNonInactiveRows}`);
    }
    replyDustReport = {
      dustManifestsTotal,
      dustSessionsInReopenWindow,
      missingDustSessionsInReopenWindow,
      expectedInactiveIdsCount: expectedInactiveIds.size,
      expectedInactiveIdsPresentInBars: expectedPresentIds,
      expectedInactiveIdsMissingFromBars: expectedMissingIds,
      expectedInactiveIdsCoverageFraction:
        expectedInactiveIds.size > 0 ? expectedPresentIds / expectedInactiveIds.size : null,
      expectedInactiveRowsTotal,
      expectedInactiveRowsPresentInBars,
      expectedInactiveRowsMissingFromBars,
      expectedInactiveRowsHeldOut,
      expectedInactivePairsTotal,
      expectedInactivePairsPresentInBars,
      expectedInactivePairsMissingFromBars,
      expectedInactivePairsCoverageFraction:
        expectedInactivePairsTotal > 0 ? expectedInactivePairsPresentInBars / expectedInactivePairsTotal : null,
      expectedInactivePairsHeldOutTotal,
      expectedInactivePairsHeldOutPresentInBars,
      expectedInactivePairsHeldOutMissingFromBars,
      expectedInactivePairsHeldOutCoverageFraction:
        expectedInactivePairsHeldOutTotal > 0
          ? expectedInactivePairsHeldOutPresentInBars / expectedInactivePairsHeldOutTotal
          : null,
      idempotencyWouldAddInactiveRows,
      idempotencyWouldAddNonInactiveRows,
      idempotencySkippedCollisionRows,
      idempotencySkippedNonInactiveRows,
      months: replyDustMonths,
    };
  }

  return {
    schemaVersion: "coverage-check-v1",
    generatedAt: now.toISOString(),
    reopenWindow: { from: reopenFrom, to: reopenTo },
    heldOutStart,
    liveAsOfFloor,
    securityMaster: {
      totalRecords: securities.length,
      byStatus: sortedCounts(byStatus),
      byAssetType: sortedCounts(byAssetType),
      inactiveTotal,
      inactiveWithListingDate,
      inactiveWithDelistedAt,
      inactiveWithInactiveAt,
      inactiveSharingActiveSymbol,
      lastUniverseSeenAtMin,
      lastUniverseSeenAtMax,
      lastUniverseSeenAtOnOrAfterLiveFloorCount,
    },
    tickerReferenceIndex: {
      present: Boolean(liveIndex),
      asOf: indexAsOf,
      baseAsOf: liveIndex?.base.asOf ?? null,
      deltasCount: liveIndex?.deltas.length ?? 0,
      historyLength: indexHistory.length,
      records: liveIndex?.records ?? null,
      pages: liveIndex?.pages ?? null,
      asOfIsLiveDate,
    },
    reopenState: reopenStateReport,
    dailyBars: {
      monthFilesCount: barKeys.length,
      totalSessions: allSessions.size,
      minSessionDate,
      maxSessionDate,
      totalRows,
      duplicateKeysCount,
      rowsByStatus: sortedCounts(rowsByStatus),
      preHeldOutRowsByStatus: sortedCounts(preHeldOutRowsByStatus),
      heldOutRowsByStatus: sortedCounts(heldOutRowsByStatus),
      activeIdsWithAnyBar: activeIdsWithAnyBar.size,
      inactiveIdsWithAnyBar: inactiveIdsWithAnyBar.size,
      inactiveIdsWithZeroBars: Math.max(0, inactiveTotal - inactiveIdsWithAnyBar.size),
      inactiveIdsBeforeHeldOut: inactiveIdsBeforeHeldOut.size,
      inactiveIdsInHeldOut: inactiveIdsInHeldOut.size,
      inactiveIdsOnlyBeforeHeldOut,
      inactiveIdsOnlyInHeldOut,
      inactiveIdsInBothWindows,
      inactiveIdsInReopenWindow: inactiveIdsInReopenWindow.size,
      months,
    },
    ...(replyDustReport ? { replyDustReopen: replyDustReport } : {}),
    anomalies,
  };
}

export function formatCoverageSummaryMarkdown(report: CoverageCheckReport): string {
  const lines: string[] = [
    "# PeaceSTOCKS Read-Only Coverage Check",
    "",
    `- **Generated at:** \`${report.generatedAt}\``,
    `- **Reopen window:** \`${report.reopenWindow.from}..${report.reopenWindow.to}\` | **Held-out start:** \`${report.heldOutStart}\``,
    `- **Anomalies:** ${report.anomalies.length === 0 ? "none" : report.anomalies.map((a) => `\`${a}\``).join(", ")}`,
    "",
    "## Live Security Master & Index",
    `- Security master records: **${report.securityMaster.totalRecords.toLocaleString("en-US")}** (\`ACTIVE\`: ${(report.securityMaster.byStatus.ACTIVE ?? 0).toLocaleString("en-US")}, \`INACTIVE\`: ${report.securityMaster.inactiveTotal.toLocaleString("en-US")})`,
    `- \`INACTIVE\` sharing an \`ACTIVE\` \`currentSymbol\` (uncollectable): **${report.securityMaster.inactiveSharingActiveSymbol.toLocaleString("en-US")}**`,
    `- \`lastUniverseSeenAt\`: \`${report.securityMaster.lastUniverseSeenAtMin ?? "none"}\` .. \`${report.securityMaster.lastUniverseSeenAtMax ?? "none"}\` (${report.securityMaster.lastUniverseSeenAtOnOrAfterLiveFloorCount.toLocaleString("en-US")} on/after \`${report.liveAsOfFloor}\`)`,
    `- \`ticker-reference-index.json\` \`asOf\`: \`${report.tickerReferenceIndex.asOf ?? "missing"}\` (base \`${report.tickerReferenceIndex.baseAsOf ?? "none"}\`, deltas ${report.tickerReferenceIndex.deltasCount}, live date: **${report.tickerReferenceIndex.asOfIsLiveDate}**)`,
    `- \`backfill-reopen-state.json\`: ${report.reopenState.present ? `${report.reopenState.completedSessionsCount} completed sessions (\`${report.reopenState.minCompletedDate ?? ""}..${report.reopenState.maxCompletedDate ?? ""}\`)` : "not present"}`,
    "",
    "## Live Daily Bars Coverage (`INACTIVE` IDs & Rows)",
    `- Month files: **${report.dailyBars.monthFilesCount}** | Sessions: **${report.dailyBars.totalSessions}** (\`${report.dailyBars.minSessionDate ?? "none"}..${report.dailyBars.maxSessionDate ?? "none"}\`) | Total rows: **${report.dailyBars.totalRows.toLocaleString("en-US")}**`,
    `- \`INACTIVE\` IDs with >= 1 bar (any date): **${report.dailyBars.inactiveIdsWithAnyBar.toLocaleString("en-US")} / ${report.securityMaster.inactiveTotal.toLocaleString("en-US")}** (${report.dailyBars.inactiveIdsWithZeroBars.toLocaleString("en-US")} with 0 bars)`,
    `  - Before \`${report.heldOutStart}\`: **${report.dailyBars.inactiveIdsBeforeHeldOut.toLocaleString("en-US")}** | In held-out \`>= ${report.heldOutStart}\`: **${report.dailyBars.inactiveIdsInHeldOut.toLocaleString("en-US")}** (only held-out: ${report.dailyBars.inactiveIdsOnlyInHeldOut.toLocaleString("en-US")})`,
    `  - In reopen window \`${report.reopenWindow.from}..${report.reopenWindow.to}\`: **${report.dailyBars.inactiveIdsInReopenWindow.toLocaleString("en-US")}**`,
    `- \`INACTIVE\` rows total: **${(report.dailyBars.rowsByStatus.INACTIVE ?? 0).toLocaleString("en-US")}** (pre-held-out: **${(report.dailyBars.preHeldOutRowsByStatus.INACTIVE ?? 0).toLocaleString("en-US")}**, held-out \`>= ${report.heldOutStart}\`: **${(report.dailyBars.heldOutRowsByStatus.INACTIVE ?? 0).toLocaleString("en-US")}**)`,
  ];

  if (report.replyDustReopen) {
    const r = report.replyDustReopen;
    const pairPct =
      r.expectedInactivePairsCoverageFraction === null
        ? "n/a"
        : `${(r.expectedInactivePairsCoverageFraction * 100).toFixed(2)}%`;
    const heldOutPairPct =
      r.expectedInactivePairsHeldOutCoverageFraction === null
        ? "n/a"
        : `${(r.expectedInactivePairsHeldOutCoverageFraction * 100).toFixed(2)}%`;
    lines.push(
      "",
      "## Reply Dust Reopen Expected-Set Verification (`pointInTimeUniverse` + `filterReopenBars`)",
      `- Dust sessions in reopen window: **${r.dustSessionsInReopenWindow}** (missing Dust: ${r.missingDustSessionsInReopenWindow}; total manifests in R2: ${r.dustManifestsTotal})`,
      `- Expected \`INACTIVE\` pairs (\`securityId|sessionDate|revision\`) present in live bars: **${r.expectedInactivePairsPresentInBars.toLocaleString("en-US")} / ${r.expectedInactivePairsTotal.toLocaleString("en-US")}** (${pairPct}; missing: **${r.expectedInactivePairsMissingFromBars.toLocaleString("en-US")}**)`,
      `- Held-out expected \`INACTIVE\` pairs (\`>= ${report.heldOutStart}\`): **${r.expectedInactivePairsHeldOutPresentInBars.toLocaleString("en-US")} / ${r.expectedInactivePairsHeldOutTotal.toLocaleString("en-US")}** (${heldOutPairPct}; missing: **${r.expectedInactivePairsHeldOutMissingFromBars.toLocaleString("en-US")}**)`,
      `- Expected \`INACTIVE\` IDs with any live bar (secondary): **${r.expectedInactiveIdsPresentInBars.toLocaleString("en-US")} / ${r.expectedInactiveIdsCount.toLocaleString("en-US")}** (missing: **${r.expectedInactiveIdsMissingFromBars.toLocaleString("en-US")}**)`,
      `- Reopen idempotency against live bars: would add **${r.idempotencyWouldAddInactiveRows}** \`INACTIVE\` rows, **${r.idempotencyWouldAddNonInactiveRows}** non-\`INACTIVE\` rows`,
    );
  }

  lines.push(
    "",
    "## Per-Month Daily Bars Breakdown (Aggregates Only)",
    "| Month | Sessions | Total Rows | ACTIVE Rows | INACTIVE Rows | Pre-HeldOut INACTIVE | HeldOut INACTIVE | Distinct INACTIVE IDs |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...report.dailyBars.months.map(
      (m) =>
        `| ${m.month} | ${m.sessions} | ${m.totalRows} | ${m.activeRows} | ${m.inactiveRows} | ${m.inactivePreHeldOutRows} | ${m.inactiveHeldOutRows} | ${m.distinctInactiveIds} |`,
    ),
    "",
  );
  return lines.join("\n");
}

export function parseCoverageCheckArgs(args: readonly string[]): {
  outJson?: string;
  skipReplyDust: boolean;
  reopenFrom: string;
  reopenTo: string;
  heldOutStart: string;
  liveAsOfFloor: string;
} {
  let outJson: string | undefined;
  let skipReplyDust = false;
  let reopenFrom = DEFAULT_REOPEN_FROM;
  let reopenTo = DEFAULT_REOPEN_TO;
  let heldOutStart = HELD_OUT_START_DATE;
  let liveAsOfFloor = DEFAULT_LIVE_ASOF_FLOOR;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i]!;
    if (flag === "--skip-reply-dust") {
      skipReplyDust = true;
      continue;
    }
    const next = args[i + 1];
    if (flag === "--out") {
      if (!next || next.startsWith("--")) throw new Error("COVERAGE_CHECK_BAD_ARG:--out");
      outJson = next;
      i += 1;
    } else if (flag === "--from") {
      if (!next || next.startsWith("--")) throw new Error("COVERAGE_CHECK_BAD_ARG:--from");
      reopenFrom = next;
      i += 1;
    } else if (flag === "--to") {
      if (!next || next.startsWith("--")) throw new Error("COVERAGE_CHECK_BAD_ARG:--to");
      reopenTo = next;
      i += 1;
    } else if (flag === "--held-out-start") {
      if (!next || next.startsWith("--")) throw new Error("COVERAGE_CHECK_BAD_ARG:--held-out-start");
      heldOutStart = next;
      i += 1;
    } else if (flag === "--live-asof-floor") {
      if (!next || next.startsWith("--")) throw new Error("COVERAGE_CHECK_BAD_ARG:--live-asof-floor");
      liveAsOfFloor = next;
      i += 1;
    } else {
      throw new Error(`COVERAGE_CHECK_UNKNOWN_ARG:${flag}`);
    }
  }
  return {
    ...(outJson ? { outJson } : {}),
    skipReplyDust,
    reopenFrom,
    reopenTo,
    heldOutStart,
    liveAsOfFloor,
  };
}

export function coverageCheckFailed(report: CoverageCheckReport): boolean {
  return report.anomalies.length > 0;
}

export async function coverageCheckMain(
  args: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  deps: { reader?: CoverageReader; replyDustBackend?: ReplyDustBackend; now?: () => Date } = {},
): Promise<CoverageCheckReport> {
  const parsed = parseCoverageCheckArgs(args);
  const reader =
    deps.reader ??
    new ReadOnlyR2Client({
      accountId: env.PEACESTOCKS_R2_ACCOUNT_ID,
      bucket: env.PEACESTOCKS_R2_BUCKET,
      accessKeyId: env.PEACESTOCKS_R2_READ_ACCESS_KEY_ID,
      secretAccessKey: env.PEACESTOCKS_R2_READ_SECRET_ACCESS_KEY,
    });
  const report = await runCoverageCheck(reader, {
    reopenFrom: parsed.reopenFrom,
    reopenTo: parsed.reopenTo,
    heldOutStart: parsed.heldOutStart,
    liveAsOfFloor: parsed.liveAsOfFloor,
    skipReplyDust: parsed.skipReplyDust,
    ...(deps.replyDustBackend ? { replyDustBackend: deps.replyDustBackend } : {}),
    ...(deps.now ? { now: deps.now() } : {}),
  });

  const outJson = parsed.outJson ?? env.COVERAGE_CHECK_OUT;
  if (outJson) {
    mkdirSync(dirname(outJson), { recursive: true });
    writeFileSync(outJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${formatCoverageSummaryMarkdown(report)}\n`, "utf8");
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  coverageCheckMain()
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report)}\n`);
      if (coverageCheckFailed(report)) {
        process.stderr.write(`COVERAGE_CHECK_ANOMALIES:${report.anomalies.join(",")}\n`);
        process.exitCode = 2;
      }
    })
    .catch((error: unknown) => {
      process.stderr.write(`COVERAGE_CHECK_FAILED:${readReason(error)}\n`);
      process.exitCode = 2;
    });
}
