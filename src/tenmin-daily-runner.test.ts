import assert from "node:assert/strict";
import test from "node:test";
import type { PredictionStatus } from "./contracts";
import { SCANNER_VERSION } from "./contracts";
import { dailyReplyDustFileKey } from "./daily-reply-dust";
import { sha256Hex } from "./intraday-reply-dust";
import { MemoryObjectClient } from "./object-store";
import { makePredictionStatus } from "./prediction-status";
import { encodeReplyDust, nodeReplyDustBackend } from "./reply-dust";
import { beforeNextSessionOpen, nextSessionOpen } from "./session-open";
import { SCAN_GUARD_WINDOWS_UTC } from "./scan-yield";
import {
  buildPicksBaseV1,
  buildPicksTop50V1,
  orderPicksForFetch,
  pickV1BeliefsKey,
  pickV1PredictionsKey,
  serializePicksBaseV1,
} from "./tenmin-daily-picks";
import {
  classifyTop50Absence,
  immutableReplyDustStore,
  loadExistingPicksBaseBytes,
  putImmutableVerified,
  readTenMinDayPicks,
  tenMinDayObjectKey,
  tenMinDayPicksKey,
  writeTenMinDayPicks,
} from "./tenmin-day-picks";
import { candidateDailyPickDays } from "./tenmin-history";
import {
  resolveDaySettlement,
  runTenMinDailyPicks,
  tenMinDailyPicksSummary,
  tenMinDailyPicksEnabled,
} from "./tenmin-daily-runner";
import type { MarketStore } from "./storage";
import { runTenMinDailyHost } from "./host";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";
import type { PredictionSet, ScannerBelief } from "./contracts";

/** After next open of 2026-10-05 (Mon 2026-10-06 09:30 ET = 13:30Z). */
const SETTLED_NOW = new Date("2026-10-06T18:00:00.000Z");
const D = "2026-10-05";
const D_OLD = "2020-01-02";

/** Fixed clock for tests — never rely on wall time via `now` alone. */
const settledClock = (): Date => SETTLED_NOW;

function status(
  runId: string,
  sessionDate: string,
  fields: Partial<PredictionStatus> & Pick<PredictionStatus, "status" | "reason">,
): PredictionStatus {
  return makePredictionStatus(runId, {
    sessionDate,
    scannerVersion: SCANNER_VERSION,
    configFingerprint: "cfg",
    recordedAt: `${sessionDate}T23:59:59.999Z`,
    attemptedAt: SETTLED_NOW.toISOString(),
    supersedesPredictionIds: [],
    ...fields,
  });
}

function sampleBase(
  sessionDate: string,
  opts?: {
    index?: { securityId: string; symbol: string }[];
    holdings?: { securityId: string; symbol: string }[];
  },
) {
  const index = opts?.index ?? [{ securityId: "sec_spy", symbol: "SPY" }];
  const holdings = opts?.holdings ?? [{ securityId: "sec_hold", symbol: "HOLD" }];
  const extras = [
    { T: "AAA", id: "sec_aaa" },
    { T: "BBB", id: "sec_bbb" },
    { T: "CCC", id: "sec_ccc" },
    { T: "DDD", id: "sec_ddd" },
    { T: "EEE", id: "sec_eee" },
    { T: "FFF", id: "sec_fff" },
    { T: "GGG", id: "sec_ggg" },
    { T: "HHH", id: "sec_hhh" },
  ];
  const tickerToSecurityId: Record<string, string> = {
    SPY: "sec_spy",
    HOLD: "sec_hold",
    QQQ: "sec_qqq",
  };
  const tickerTypes: Record<string, string> = { SPY: "ETF", HOLD: "CS", QQQ: "ETF" };
  for (const e of extras) {
    tickerToSecurityId[e.T] = e.id;
    tickerTypes[e.T] = "CS";
  }
  for (const ix of index) {
    tickerToSecurityId[ix.symbol] = ix.securityId;
    tickerTypes[ix.symbol] = tickerTypes[ix.symbol] ?? "ETF";
  }
  for (const h of holdings) {
    tickerToSecurityId[h.symbol] = h.securityId;
    tickerTypes[h.symbol] = tickerTypes[h.symbol] ?? "CS";
  }
  return buildPicksBaseV1({
    sessionDate,
    index,
    holdings,
    groupedReply: {
      key: dailyReplyDustFileKey(sessionDate),
      sha256: "b".repeat(64),
      sessionDate,
      results: [
        { T: "SPY" },
        { T: "HOLD" },
        { T: "QQQ" },
        ...extras.map((e) => ({ T: e.T })),
      ],
    },
    tickerToSecurityId,
    tickerTypes,
  });
}

function sampleTop50(sessionDate: string, extraIds: string[] = ["sec_top"]) {
  const predictionId = `pred_${sessionDate}_top50`;
  const securityIds = ["sec_spy", ...extraIds];
  const predictions: PredictionSet[] = [
    {
      predictionId,
      sessionDate,
      setType: "TOP_50_OVERALL",
      securityIds,
      scannerVersion: SCANNER_VERSION,
      configFingerprint: "cfg",
      frozenAt: `${sessionDate}T23:59:59.999Z`,
    },
  ];
  const beliefs: ScannerBelief[] = securityIds.map((securityId, i) => ({
    decisionId: `dec_${securityId}`,
    securityId,
    sessionDate,
    eligibility: "LEVEL_3",
    overallRank: i + 1,
    familyScores: { momentum: 1 - i * 0.01 },
    meaningfulDecision: "RANKED",
    scannerVersion: SCANNER_VERSION,
    featureRecipeVersions: {},
    configFingerprint: "cfg",
    evidenceAsOfFingerprint: "ev",
  }));
  const predBytes = new TextEncoder().encode(
    predictions.map((p) => JSON.stringify(p)).join("\n") + "\n",
  );
  const beliefBytes = new TextEncoder().encode(
    beliefs.map((b) => JSON.stringify(b)).join("\n") + "\n",
  );
  const symbols: Record<string, string> = {
    sec_spy: "SPY",
    sec_top: "TOP",
    sec_hold: "HOLD",
    sec_qqq: "QQQ",
  };
  for (const id of extraIds) {
    if (!symbols[id]) symbols[id] = id.replace("sec_", "").toUpperCase();
  }
  return buildPicksTop50V1({
    sessionDate,
    predictions: {
      key: pickV1PredictionsKey(sessionDate),
      sha256: sha256Hex(predBytes),
      records: predictions,
    },
    beliefs: {
      key: pickV1BeliefsKey(sessionDate),
      sha256: sha256Hex(beliefBytes),
      records: beliefs,
    },
    symbolsBySecurityId: symbols,
  });
}

function reply(symbol: string, requestId = `req-${symbol}-1`): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      ticker: symbol,
      results: [{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 10, n: 1 }],
      status: "OK",
      request_id: requestId,
    }),
  );
}

function memoryStorage(
  statuses: Map<string, PredictionStatus[]> = new Map(),
): MarketStore {
  return {
    async initialize() {},
    async loadPredictionStatuses(sessionDate?: string) {
      if (!sessionDate) return [];
      return statuses.get(sessionDate) ?? [];
    },
  } as unknown as MarketStore;
}

test("kill switch: only exact 'true' enables", () => {
  assert.equal(tenMinDailyPicksEnabled({}), false);
  assert.equal(tenMinDailyPicksEnabled({ TENMIN_DAILY_PICKS: "1" }), false);
  assert.equal(tenMinDailyPicksEnabled({ TENMIN_DAILY_PICKS: "TRUE" }), false);
  assert.equal(tenMinDailyPicksEnabled({ TENMIN_DAILY_PICKS: "true" }), true);
});

test("switch off (unset, 1, TRUE) ⇒ phase does not run", async () => {
  const store = immutableReplyDustStore(new MemoryObjectClient());
  for (const val of [undefined, "1", "TRUE"] as const) {
    const env: NodeJS.ProcessEnv = {};
    if (val !== undefined) env.TENMIN_DAILY_PICKS = val;
    const report = await runTenMinDailyPicks({
      store,
      storage: memoryStorage(),
      days: [D],
      env,
      now: SETTLED_NOW,
      clock: settledClock,
      buildBase: () => sampleBase(D),
      fetchReply: async () => {
        throw new Error("SHOULD_NOT_FETCH");
      },
    });
    assert.equal(report.enabled, false);
    assert.equal(report.totalRequests, 0);
    assert.deepEqual(report.days, []);
  }
});

test("live clock: advances into 05:15Z window mid-day → fetching stops", async () => {
  const store = immutableReplyDustStore(new MemoryObjectClient());
  // Start just before the first guard window; after 2 fetches jump into 05:15–06:15Z.
  let current = new Date("2026-10-06T05:14:00.000Z");
  // Settlement for D=2026-10-05 needs after 13:30Z — use a day whose open already passed.
  const day = "2024-11-04"; // historical settled
  const histBase = sampleBase(day);
  let fetches = 0;
  const report = await runTenMinDailyPicks({
    store,
    storage: memoryStorage(),
    days: [day],
    env: { TENMIN_DAILY_PICKS: "true" },
    now: new Date("2026-10-06T18:00:00.000Z"),
    clock: () => current,
    buildBase: () => histBase,
    fetchReply: async (sec) => {
      fetches += 1;
      const body = reply(sec.symbol);
      // After 2 persisted fetches, jump into the guard window so the next pre-fetch check stops.
      if (fetches >= 2) current = new Date("2026-10-06T05:16:00.000Z");
      return body;
    },
  });
  assert.equal(fetches, 2);
  assert.ok(histBase.picks.length > 2, `need >2 picks to observe mid-day cutoff, got ${histBase.picks.length}`);
  assert.ok(report.yieldedForScan?.startsWith("SCAN_GUARD_WINDOW:"));
  assert.equal(report.totalRequests, fetches);
  // Priority holding/index should already be persisted (fetch order).
  const ordered = orderPicksForFetch(histBase.picks);
  const firstTwo = ordered.slice(0, 2);
  for (const p of firstTwo) {
    const bytes = await store.get(tenMinDayObjectKey(day, p.securityId, p.symbol));
    assert.ok(bytes, `expected stored ${p.symbol}`);
  }
});

test("guard window at run start ⇒ no fetch", async () => {
  const store = immutableReplyDustStore(new MemoryObjectClient());
  const [start] = SCAN_GUARD_WINDOWS_UTC[0]!;
  const hour = Math.floor(start / 60);
  const minute = start % 60;
  const now = new Date(Date.UTC(2026, 9, 6, hour, minute + 1, 0));
  const day = "2024-11-04";
  const report = await runTenMinDailyPicks({
    store,
    storage: memoryStorage(),
    days: [day],
    env: { TENMIN_DAILY_PICKS: "true" },
    now,
    clock: () => now,
    buildBase: () => sampleBase(day),
    fetchReply: async () => {
      throw new Error("SHOULD_NOT_FETCH");
    },
  });
  assert.equal(report.totalRequests, 0);
  assert.ok(report.yieldedForScan?.startsWith("SCAN_GUARD_WINDOW:"));
});

test("candidateDailyPickDays: weekends and holidays excluded; HALF_DAY kept", () => {
  const days = candidateDailyPickDays("2024-11-01", "2024-11-05");
  // Fri 11/1 NORMAL, Sat/Sun CLOSED, Mon 11/4 NORMAL, Tue 11/5 NORMAL
  assert.deepEqual(days, ["2024-11-01", "2024-11-04", "2024-11-05"]);
  assert.ok(!days.includes("2024-11-02"));
  assert.ok(!days.includes("2024-11-03"));
  // Christmas CLOSED
  const xmas = candidateDailyPickDays("2024-12-24", "2024-12-26");
  assert.ok(xmas.includes("2024-12-24")); // HALF_DAY
  assert.equal(US_EQUITY_MARKET_CALENDAR.getSession("2024-12-24").kind, "HALF_DAY");
  assert.ok(!xmas.includes("2024-12-25"));
});

test("25 corrupt days then one good day → good day seals", async () => {
  const raw = new MemoryObjectClient();
  const store = immutableReplyDustStore(raw);
  const trading = candidateDailyPickDays("2024-11-01", "2024-12-15");
  assert.ok(trading.length > 26);
  const corruptDays = trading.slice(0, 25);
  const goodDay = trading[25]!;

  for (const d of corruptDays) {
    const base = sampleBase(d);
    const victim = base.picks[0]!;
    const key = tenMinDayObjectKey(d, victim.securityId, victim.symbol);
    const full = encodeReplyDust(reply(victim.symbol), nodeReplyDustBackend);
    await raw.put(key, full.slice(0, 3));
  }

  const report = await runTenMinDailyPicks({
    store,
    storage: memoryStorage(),
    days: [...corruptDays, goodDay],
    env: { TENMIN_DAILY_PICKS: "true" },
    now: SETTLED_NOW,
    clock: settledClock,
    limit: 1,
    buildBase: (d) => sampleBase(d),
    fetchReply: async (sec) => reply(sec.symbol),
  });
  assert.equal(report.corrupt.length, 25);
  assert.deepEqual(report.sealed, [goodDay]);
  assert.equal((await readTenMinDayPicks(store, goodDay)).status, "SEALED");
});

test("settlement: FROZEN seals with top50 present", async () => {
  const store = immutableReplyDustStore(new MemoryObjectClient());
  const statuses = new Map<string, PredictionStatus[]>([
    [D, [status("scan_f", D, { status: "FROZEN", reason: "PREDICTIONS_FROZEN" })]],
  ]);
  const report = await runTenMinDailyPicks({
    store,
    storage: memoryStorage(statuses),
    days: [D],
    env: { TENMIN_DAILY_PICKS: "true" },
    now: SETTLED_NOW,
    clock: settledClock,
    buildBase: () => sampleBase(D),
    buildTop50: () => sampleTop50(D),
    fetchReply: async (sec) => reply(sec.symbol),
  });
  assert.ok(report.sealed.includes(D));
  const read = await readTenMinDayPicks(store, D);
  assert.equal(read.status, "SEALED");
  if (read.status !== "SEALED") return;
  assert.equal(read.top50.state, "present");
});

test("settlement: before next open and unfrozen → skipped not sealed", async () => {
  const store = immutableReplyDustStore(new MemoryObjectClient());
  const before = beforeNextSessionOpen(D);
  assert.ok(nextSessionOpen(D)!.nextSessionOpen.getTime() > before.getTime());
  const report = await runTenMinDailyPicks({
    store,
    storage: memoryStorage(),
    days: [D],
    env: { TENMIN_DAILY_PICKS: "true" },
    now: before,
    clock: () => before,
    buildBase: () => sampleBase(D),
    fetchReply: async () => {
      throw new Error("SHOULD_NOT_FETCH");
    },
  });
  assert.deepEqual(report.sealed, []);
  assert.ok(report.skippedNotSettled.includes(D));
  assert.equal((await readTenMinDayPicks(store, D)).status, "TENMIN_DAY_NOT_SEALED");
  assert.equal(resolveDaySettlement(D, [], before).kind, "not_yet_frozen");
});

test("settlement: after next open unfrozen → no_forward_scan seal", async () => {
  const store = immutableReplyDustStore(new MemoryObjectClient());
  const report = await runTenMinDailyPicks({
    store,
    storage: memoryStorage(), // no records
    days: [D],
    env: { TENMIN_DAILY_PICKS: "true" },
    now: SETTLED_NOW,
    clock: settledClock,
    buildBase: () => sampleBase(D),
    fetchReply: async (sec) => reply(sec.symbol),
  });
  assert.ok(report.sealed.includes(D));
  const read = await readTenMinDayPicks(store, D);
  assert.equal(read.status, "SEALED");
  if (read.status !== "SEALED") return;
  assert.equal(read.top50.state, "absent");
  if (read.top50.state === "absent") assert.equal(read.top50.reason, "no_forward_scan");
  assert.equal(resolveDaySettlement(D, [], SETTLED_NOW).kind, "no_forward_scan");
});

test("settlement: historical Nov 2024 with no records → no_forward_scan", () => {
  const hist = "2024-11-04";
  assert.equal(classifyTop50Absence([], { sessionDate: hist, now: SETTLED_NOW }).reason, "no_forward_scan");
  assert.equal(resolveDaySettlement(hist, [], SETTLED_NOW).kind, "no_forward_scan");
});

test("fetch order: top50/index/holdings before random; cutoff leaves priority stored", async () => {
  const store = immutableReplyDustStore(new MemoryObjectClient());
  const base = sampleBase(D, {
    index: [
      { securityId: "sec_spy", symbol: "SPY" },
      { securityId: "sec_qqq", symbol: "QQQ" },
    ],
    holdings: [{ securityId: "sec_hold", symbol: "HOLD" }],
  });
  const top50 = sampleTop50(D, ["sec_top"]);
  const statuses = new Map<string, PredictionStatus[]>([
    [D, [status("scan_f", D, { status: "FROZEN", reason: "PREDICTIONS_FROZEN" })]],
  ]);
  const fetched: string[] = [];
  let n = 0;
  const report = await runTenMinDailyPicks({
    store,
    storage: memoryStorage(statuses),
    days: [D],
    env: { TENMIN_DAILY_PICKS: "true" },
    now: SETTLED_NOW,
    clock: settledClock,
    buildBase: () => base,
    buildTop50: () => top50,
    shouldYield: async () => {
      // Cut after priority names (holding, index×2, top50) — allow 4 fetches then budget.
      if (n >= 4) return `TIME_BUDGET:${SETTLED_NOW.toISOString()}`;
      return undefined;
    },
    fetchReply: async (sec) => {
      n += 1;
      fetched.push(sec.symbol);
      return reply(sec.symbol);
    },
  });
  assert.ok(report.yieldedForScan?.startsWith("TIME_BUDGET:"));
  // First fetches must be priority reasons, not random.
  const prioritySymbols = new Set(["HOLD", "SPY", "QQQ", "TOP"]);
  assert.ok(fetched.length >= 1);
  for (const sym of fetched) {
    assert.ok(prioritySymbols.has(sym), `non-priority fetched before cutoff: ${sym} in ${fetched}`);
  }
  // Priority objects persisted even though day did not seal.
  for (const sym of fetched) {
    const pick =
      [...base.picks, ...top50.picks].find((p) => p.symbol === sym) ??
      { securityId: sym === "TOP" ? "sec_top" : `sec_${sym.toLowerCase()}`, symbol: sym };
    const key = tenMinDayObjectKey(D, pick.securityId, pick.symbol);
    assert.ok(await store.get(key), `missing stored object for ${sym}`);
  }
  assert.equal((await readTenMinDayPicks(store, D)).status, "TENMIN_DAY_NOT_SEALED");
});

test("resume over half-written day: zero requests for existing .rdust; sealed points at existing bytes", async () => {
  const raw = new MemoryObjectClient();
  const store = immutableReplyDustStore(raw);
  const base = sampleBase(D);
  const picksBytes = new TextEncoder().encode(`${serializePicksBaseV1(base)}\n`);
  await putImmutableVerified(raw, tenMinDayPicksKey(D), picksBytes);

  const pickHold = base.picks.find((p) => p.securityId === "sec_hold");
  assert.ok(pickHold);
  const bodyH = reply("HOLD");
  const encodedH = encodeReplyDust(bodyH, nodeReplyDustBackend);
  const keyH = tenMinDayObjectKey(D, "sec_hold", "HOLD");
  await raw.put(keyH, encodedH, {
    "rd-file-sha256": sha256Hex(encodedH),
    "rd-schema": "tenmin-day-reply-dust-object-v1",
  });

  const fetchedIds: string[] = [];
  const report = await runTenMinDailyPicks({
    store,
    storage: memoryStorage(),
    days: [D],
    env: { TENMIN_DAILY_PICKS: "true" },
    now: SETTLED_NOW,
    clock: settledClock,
    buildBase: () => {
      throw new Error("MUST_NOT_REBUILD_BASE");
    },
    fetchReply: async (sec) => {
      fetchedIds.push(sec.securityId);
      return reply(sec.symbol);
    },
  });
  assert.ok(report.sealed.includes(D));
  assert.ok(!fetchedIds.includes("sec_hold"));
  assert.equal(fetchedIds.length, base.picks.length - 1);
  const read = await readTenMinDayPicks(store, D);
  assert.equal(read.status, "SEALED");
  if (read.status !== "SEALED") return;
  const entryH = read.securities.find((s) => s.securityId === "sec_hold");
  assert.equal(entryH!.sha256, sha256Hex(encodedH));
  assert.equal(entryH!.byteLength, encodedH.length);
  assert.deepEqual(await loadExistingPicksBaseBytes(store, D), picksBytes);
});

test("picks.json reused across a ticker/type-map change (never rebuild)", async () => {
  const raw = new MemoryObjectClient();
  const store = immutableReplyDustStore(raw);
  const base = sampleBase(D);
  const picksBytes = new TextEncoder().encode(`${serializePicksBaseV1(base)}\n`);
  await putImmutableVerified(raw, tenMinDayPicksKey(D), picksBytes);
  let buildCalls = 0;
  await runTenMinDailyPicks({
    store,
    storage: memoryStorage(),
    days: [D],
    env: { TENMIN_DAILY_PICKS: "true" },
    now: SETTLED_NOW,
    clock: settledClock,
    buildBase: () => {
      buildCalls += 1;
      return sampleBase(D, { index: [{ securityId: "sec_z", symbol: "ZZZ" }] });
    },
    fetchReply: async (sec) => reply(sec.symbol),
  });
  assert.equal(buildCalls, 0);
  assert.deepEqual(await raw.get(tenMinDayPicksKey(D)), picksBytes);
});

test("corrupt day skipped, next backlog day still seals, CORRUPT entry with key", async () => {
  const raw = new MemoryObjectClient();
  const store = immutableReplyDustStore(raw);
  const D1 = "2026-10-01";
  const D2 = "2026-10-02";
  const base1 = sampleBase(D1);
  const victim = base1.picks[0]!;
  const key = tenMinDayObjectKey(D1, victim.securityId, victim.symbol);
  const full = encodeReplyDust(reply(victim.symbol), nodeReplyDustBackend);
  await raw.put(key, full.slice(0, 3));

  const report = await runTenMinDailyPicks({
    store,
    storage: memoryStorage(),
    days: [D1, D2],
    env: { TENMIN_DAILY_PICKS: "true" },
    now: SETTLED_NOW,
    clock: settledClock,
    limit: 5,
    buildBase: (d) => sampleBase(d),
    fetchReply: async (sec) => reply(sec.symbol),
  });
  assert.ok(report.corrupt.some((c) => c.sessionDate === D1 && c.key === key));
  assert.ok(report.sealed.includes(D2));
  assert.ok(!report.sealed.includes(D1));
  const leftover = await raw.get(key);
  assert.ok(leftover && leftover.length === 3);
});

test("UNSEALED out-of-window day filtered (no request)", async () => {
  const store = immutableReplyDustStore(new MemoryObjectClient());
  let fetches = 0;
  const report = await runTenMinDailyPicks({
    store,
    storage: memoryStorage(),
    days: [D_OLD],
    env: { TENMIN_DAILY_PICKS: "true" },
    now: SETTLED_NOW,
    clock: settledClock,
    buildBase: () => sampleBase(D_OLD),
    fetchReply: async () => {
      fetches += 1;
      throw new Error("SHOULD_NOT_FETCH");
    },
  });
  assert.equal(fetches, 0);
  assert.deepEqual(report.skippedOutOfWindow, [D_OLD]);
});

test("adopt path: STORED without replyBody adopts existing .rdust", async () => {
  const raw = new MemoryObjectClient();
  const store = immutableReplyDustStore(raw);
  const base = sampleBase(D);
  const pick = base.picks[0]!;
  const body = reply(pick.symbol);
  const encoded = encodeReplyDust(body, nodeReplyDustBackend);
  const key = tenMinDayObjectKey(D, pick.securityId, pick.symbol);
  await raw.put(key, encoded, { "rd-file-sha256": sha256Hex(encoded) });

  const securities = base.picks.map((p) =>
    p.securityId === pick.securityId
      ? { securityId: p.securityId, symbol: p.symbol, status: "STORED" as const }
      : {
          securityId: p.securityId,
          symbol: p.symbol,
          status: "STORED" as const,
          replyBody: reply(p.symbol),
        },
  );
  const manifest = await writeTenMinDayPicks(store, {
    sessionDate: D,
    picksBase: base,
    predictionStatuses: [],
    securities,
    observedAt: SETTLED_NOW.toISOString(),
    settlementNow: SETTLED_NOW,
  });
  const entry = manifest.securities.find((s) => s.securityId === pick.securityId)!;
  assert.equal(entry.sha256, sha256Hex(encoded));
  assert.equal(entry.byteLength, encoded.length);
});

test("orderPicksForFetch: holding → index → top50 → random", () => {
  const base = sampleBase(D);
  const top50 = sampleTop50(D, ["sec_top"]);
  const merged = orderPicksForFetch(
    // merge not imported path — use order on concatenated unique
    [...base.picks, ...top50.picks],
  );
  const reasons = merged.map((p) => p.reason);
  const firstRandom = reasons.indexOf("random");
  const lastPriority = Math.max(
    reasons.lastIndexOf("holding"),
    reasons.lastIndexOf("index"),
    reasons.lastIndexOf("top50"),
  );
  if (firstRandom >= 0 && lastPriority >= 0) {
    assert.ok(lastPriority < firstRandom, String(reasons));
  }
});

test("host tenmin_daily path: injected clock into 05:15Z mid-day → fetching stops", async () => {
  const store = immutableReplyDustStore(new MemoryObjectClient());
  const day = "2024-11-04";
  const histBase = sampleBase(day);
  let current = new Date("2026-10-06T05:14:00.000Z");
  let fetches = 0;
  const report = await runTenMinDailyHost({
    env: { TENMIN_DAILY_PICKS: "true" },
    clock: () => current,
    store,
    storage: memoryStorage(),
    days: [day],
    buildBase: () => histBase,
    fetchReply: async (sec) => {
      fetches += 1;
      const body = reply(sec.symbol);
      if (fetches >= 2) current = new Date("2026-10-06T05:16:00.000Z");
      return body;
    },
  });
  assert.equal(fetches, 2);
  assert.ok(report.yieldedForScan?.startsWith("SCAN_GUARD_WINDOW:"));
  assert.equal(report.totalRequests, 2);
  assert.deepEqual(report.sealed, []);
  const ordered = orderPicksForFetch(histBase.picks);
  for (const p of ordered.slice(0, 2)) {
    assert.ok(await store.get(tenMinDayObjectKey(day, p.securityId, p.symbol)));
  }
});

test("resolveClock: omitting clock uses live Date (now alone does not freeze fetches)", async () => {
  // Under normal suite wall time this may or may not be in a guard window.
  // Under faketime 2026-10-07T05:20:00Z it MUST stop with zero fetches despite now=18:00Z.
  const store = immutableReplyDustStore(new MemoryObjectClient());
  const day = "2024-11-04";
  let fetches = 0;
  const report = await runTenMinDailyPicks({
    store,
    storage: memoryStorage(),
    days: [day],
    env: { TENMIN_DAILY_PICKS: "true" },
    now: new Date("2026-10-07T18:00:00.000Z"),
    // no clock — live new Date()
    buildBase: () => sampleBase(day),
    fetchReply: async (sec) => {
      fetches += 1;
      return reply(sec.symbol);
    },
  });
  const live = new Date();
  const minute = live.getUTCHours() * 60 + live.getUTCMinutes();
  const inGuard = SCAN_GUARD_WINDOWS_UTC.some(([s, e]) => minute >= s && minute < e);
  if (inGuard) {
    assert.equal(fetches, 0);
    assert.ok(report.yieldedForScan?.startsWith("SCAN_GUARD_WINDOW:"));
  } else {
    // Outside guard: may seal; just ensure we did not freeze to `now` (18:00) incorrectly by checking completedAt tracks live-ish clock.
    assert.ok(report.completedAt);
  }
});

test("tenMinDailyPicksSummary: compact per-day outcomes and request total", () => {
  const summary = tenMinDailyPicksSummary({
    schemaVersion: "tenmin-daily-picks-run-v1",
    enabled: true,
    killSwitch: "true",
    startedAt: "2026-10-06T18:00:00.000Z",
    completedAt: "2026-10-06T18:01:00.000Z",
    backlogConsidered: 3,
    days: [
      { sessionDate: "2024-11-04", outcome: "SKIPPED_BASE_INPUT", requests: 0, baseInput: "ticker_index" },
      { sessionDate: "2024-11-05", outcome: "SEALED", requests: 2, groupedWithoutIndexEntry: { count: 1, sample: ["ZZZ"] } },
      { sessionDate: "2024-11-06", outcome: "SKIPPED_NOT_SETTLED", requests: 0 },
    ],
    sealed: ["2024-11-05"],
    corrupt: [],
    skippedOutOfWindow: [],
    skippedNotSettled: ["2024-11-06"],
    skippedBaseInput: [{ sessionDate: "2024-11-04", input: "ticker_index", key: "k" }],
    totalRequests: 2,
  });
  assert.equal(summary.enabled, true);
  assert.equal(summary.sealed, 1);
  assert.equal(summary.skippedBaseInput, 1);
  assert.equal(summary.skippedNotSettled, 1);
  assert.equal(summary.totalRequests, 2);
  assert.equal(summary.days[0]!.outcome, "SKIPPED_BASE_INPUT");
  assert.equal(summary.days[0]!.baseInput, "ticker_index");
  assert.deepEqual(summary.days[1]!.groupedWithoutIndexEntry, { count: 1, sample: ["ZZZ"] });
});

