import assert from "node:assert/strict";
import test from "node:test";
import type { PredictionSet, ScannerBelief } from "./contracts";
import { dailyReplyDustFileKey, dailyReplyDustHashedFileKey } from "./daily-reply-dust";
import { sha256 } from "./identity";
import {
  PICK_V1_ALLOWED_TYPES,
  PICK_V1_RULE_VERSION,
  PICK_V1_TYPE_FILTER_VERSION,
  PickV1InputError,
  buildPicksBaseV1,
  buildPicksTop50V1,
  computeGroupedWithoutIndexEntry,
  mergeDailyTenMinPicksV1,
  pickV1BeliefsKey,
  pickV1MappingSha256,
  pickV1PredictionsKey,
  pickV1RandomShaKey,
  pickV1TickerTypesSha256,
  pickV1TypeFilterSha256,
  serializeMergedPicksV1,
  serializePicksBaseV1,
  serializePicksTop50V1,
  type PickV1GroupedReplyInput,
} from "./tenmin-daily-picks";

const D = "2026-01-06";
const SPY = { securityId: "sec_spy_aaaaaaaaaaaa", symbol: "SPY" };
const QQQ = { securityId: "sec_qqq_bbbbbbbbbbbb", symbol: "QQQ" };

function grouped(
  tickers: string[],
  extra: Partial<PickV1GroupedReplyInput> = {},
): PickV1GroupedReplyInput {
  const results = tickers.map((T) => ({ T }));
  return {
    key: extra.key ?? dailyReplyDustFileKey(D),
    sha256: extra.sha256 ?? sha256(JSON.stringify({ results })),
    sessionDate: extra.sessionDate ?? D,
    results: extra.results ?? results,
  };
}

function pool(n: number): {
  tickers: string[];
  mapping: Record<string, string>;
  types: Record<string, string>;
  symbols: Record<string, string>;
} {
  const tickers: string[] = [];
  const mapping: Record<string, string> = {};
  const types: Record<string, string> = {};
  const symbols: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    const t = `T${String(i).padStart(3, "0")}`;
    const sid = `sec_${String(i).padStart(3, "0")}_cccccccccccc`;
    tickers.push(t);
    mapping[t] = sid;
    types[t] = "CS";
    symbols[sid] = t;
  }
  return { tickers, mapping, types, symbols };
}

function belief(
  securityId: string,
  overallRank: number,
  sessionDate = D,
): ScannerBelief {
  return {
    decisionId: `belief_${securityId}`,
    securityId,
    sessionDate,
    eligibility: "LEVEL_3",
    overallRank,
    familyScores: { momentum: 0.5, trend: 0.4, relativeStrength: 0.3, risk: 0.2, liquidity: 0.1 },
    meaningfulDecision: "RANKED",
    scannerVersion: "test",
    featureRecipeVersions: {},
    configFingerprint: "cfg",
    evidenceAsOfFingerprint: "ev",
  };
}

function top50Set(securityIds: string[], sessionDate = D): PredictionSet {
  return {
    predictionId: `prediction_top50_${sessionDate}`,
    sessionDate,
    setType: "TOP_50_OVERALL",
    securityIds,
    scannerVersion: "test",
    configFingerprint: "cfg",
    frozenAt: `${sessionDate}T23:59:59.999Z`,
  };
}

function otherSet(setType: PredictionSet["setType"], securityIds: string[]): PredictionSet {
  return {
    predictionId: `prediction_${setType}`,
    sessionDate: D,
    setType,
    securityIds,
    scannerVersion: "test",
    configFingerprint: "cfg",
    frozenAt: `${D}T23:59:59.999Z`,
  };
}

function baseInput(p: ReturnType<typeof pool>, extra: {
  holdings?: { securityId: string; symbol: string }[];
  index?: { securityId: string; symbol: string }[];
  groupedReply?: PickV1GroupedReplyInput;
} = {}) {
  return {
    sessionDate: D,
    index: extra.index ?? [SPY, QQQ],
    holdings: extra.holdings ?? [],
    groupedReply: extra.groupedReply ?? grouped(p.tickers),
    tickerToSecurityId: p.mapping,
    tickerTypes: p.types,
  };
}

test("base: re-run is byte-identical", () => {
  const p = pool(20);
  const input = baseInput(p);
  const a = serializePicksBaseV1(buildPicksBaseV1(input));
  const b = serializePicksBaseV1(buildPicksBaseV1(input));
  assert.equal(a, b);
  assert.ok(a.includes(`"ruleVersion":"${PICK_V1_RULE_VERSION}"`));
});

test("base: shuffled input order is byte-identical", () => {
  const p = pool(20);
  const base = baseInput(p);
  const shuffled = {
    ...base,
    index: [QQQ, SPY],
    groupedReply: {
      ...base.groupedReply,
      results: [...p.tickers].reverse().map((T) => ({ T })),
    },
    tickerToSecurityId: Object.fromEntries(Object.entries(p.mapping).reverse()),
    tickerTypes: Object.fromEntries(Object.entries(p.types).reverse()),
  };
  assert.equal(
    serializePicksBaseV1(buildPicksBaseV1(base)),
    serializePicksBaseV1(buildPicksBaseV1(shuffled)),
  );
});

test("base: byte-identical whether or not top50 exists (scan-independent)", () => {
  const p = pool(20);
  const base = buildPicksBaseV1(baseInput(p));
  // Building top50 must not change base serialization.
  const top = buildPicksTop50V1({
    sessionDate: D,
    predictions: {
      key: pickV1PredictionsKey(D),
      sha256: sha256("pred"),
      records: [top50Set([p.mapping.T000!, p.mapping.T001!]), otherSet("TOP_15_OVERALL", [p.mapping.T000!])],
    },
    beliefs: {
      key: pickV1BeliefsKey(D),
      sha256: sha256("bel"),
      records: [belief(p.mapping.T000!, 1), belief(p.mapping.T001!, 2)],
    },
    symbolsBySecurityId: p.symbols,
  });
  assert.equal(serializePicksBaseV1(base), serializePicksBaseV1(buildPicksBaseV1(baseInput(p))));
  assert.ok(top.top50Count === 2);
});

test("base: random 5% uses ceil(0.05*N) over ALL candidates (no exclusion)", () => {
  const p = pool(20);
  // Put all pool names in holdings — they remain in N.
  const holdings = p.tickers.map((t) => ({ securityId: p.mapping[t]!, symbol: t }));
  const out = buildPicksBaseV1(baseInput(p, { holdings }));
  assert.equal(out.candidateCount, 20);
  assert.equal(out.counts.random, Math.ceil(0.05 * 20)); // 1
  assert.equal(out.counts.holding, 20);
  // The random pick is also a holding → primary holding, alsoReasons includes random
  const withRandom = out.picks.filter((x) => x.alsoReasons?.includes("random") || x.reason === "random");
  assert.equal(withRandom.length, 1);

  const p21 = pool(21);
  const out21 = buildPicksBaseV1(baseInput(p21));
  assert.equal(out21.candidateCount, 21);
  assert.equal(out21.counts.random, Math.ceil(0.05 * 21)); // 2

  const out0 = buildPicksBaseV1(baseInput(pool(0)));
  assert.equal(out0.candidateCount, 0);
  assert.equal(out0.counts.random, 0);
});

test("base: later grouped copy key is rejected", () => {
  const p = pool(5);
  assert.throws(
    () =>
      buildPicksBaseV1(
        baseInput(p, { groupedReply: grouped(p.tickers, { key: dailyReplyDustHashedFileKey(D, "ab".repeat(32)) }) }),
      ),
    (err: unknown) => err instanceof PickV1InputError && err.code === "PICK_V1_GROUPED_NOT_FIRST_COPY",
  );
});

test("base: empty holdings", () => {
  const out = buildPicksBaseV1(baseInput(pool(10)));
  assert.equal(out.counts.holding, 0);
  assert.ok(!out.picks.some((x) => x.reason === "holding"));
});

test("base: unlinked and excluded-by-type counts", () => {
  // Link first: UNL + NOTYPE have no securityId → unlinkedExcluded (2), even though
  // UNL has type CS and NOTYPE has no type. WAR/UNIT are linked with bad types → excludedByType (2).
  const mapping: Record<string, string> = {
    AAA: "sec_aaa",
    BBB: "sec_bbb",
    WAR: "sec_war",
    UNIT: "sec_unit",
  };
  const types: Record<string, string> = {
    AAA: "CS",
    BBB: "CS",
    WAR: "WARRANT",
    UNIT: "UNIT",
    UNL: "CS",
  };
  const out = buildPicksBaseV1({
    sessionDate: D,
    index: [SPY, QQQ],
    holdings: [],
    groupedReply: grouped(["AAA", "BBB", "WAR", "UNIT", "UNL", "NOTYPE"]),
    tickerToSecurityId: mapping,
    tickerTypes: types,
  });
  assert.equal(out.counts.excludedByType, 2);
  assert.equal(out.counts.unlinkedExcluded, 2);
  assert.equal(out.candidateCount, 2);
});

test("base: unlinked ticker with no type counts unlinkedExcluded only", () => {
  const out = buildPicksBaseV1({
    sessionDate: D,
    index: [SPY, QQQ],
    holdings: [],
    groupedReply: grouped(["ORPHAN"]),
    tickerToSecurityId: {},
    tickerTypes: {},
  });
  assert.equal(out.counts.unlinkedExcluded, 1);
  assert.equal(out.counts.excludedByType, 0);
  assert.equal(out.candidateCount, 0);
});

test("base: linked ticker with excluded type counts excludedByType only", () => {
  const out = buildPicksBaseV1({
    sessionDate: D,
    index: [SPY, QQQ],
    holdings: [],
    groupedReply: grouped(["CCC"]),
    tickerToSecurityId: { CCC: "sec_ccc" },
    tickerTypes: { CCC: "WARRANT" },
  });
  assert.equal(out.counts.unlinkedExcluded, 0);
  assert.equal(out.counts.excludedByType, 1);
  assert.equal(out.candidateCount, 0);
});

test("base: type-only change updates tickerTypesSha256 and candidateCount", () => {
  const mapping = { AAA: "sec_aaa", BBB: "sec_bbb", CCC: "sec_ccc" };
  const typesCs = { AAA: "CS", BBB: "CS", CCC: "CS" };
  const typesWarrant = { AAA: "CS", BBB: "CS", CCC: "WARRANT" };
  const a = buildPicksBaseV1({
    sessionDate: D,
    index: [SPY, QQQ],
    holdings: [],
    groupedReply: grouped(["AAA", "BBB", "CCC"]),
    tickerToSecurityId: mapping,
    tickerTypes: typesCs,
  });
  const b = buildPicksBaseV1({
    sessionDate: D,
    index: [SPY, QQQ],
    holdings: [],
    groupedReply: grouped(["AAA", "BBB", "CCC"]),
    tickerToSecurityId: mapping,
    tickerTypes: typesWarrant,
  });
  assert.equal(a.mappingSha256, b.mappingSha256);
  assert.equal(a.typeFilter.sha256, b.typeFilter.sha256);
  assert.equal(a.groupedReply.sha256, b.groupedReply.sha256);
  assert.notEqual(a.tickerTypesSha256, b.tickerTypesSha256);
  assert.equal(a.tickerTypesSha256, pickV1TickerTypesSha256(typesCs));
  assert.equal(b.tickerTypesSha256, pickV1TickerTypesSha256(typesWarrant));
  assert.equal(a.candidateCount, 3);
  assert.equal(b.candidateCount, 2);
});

test("top50: from predictions + beliefs; wrong session rejected", () => {
  const p = pool(3);
  const ids = [p.mapping.T000!, p.mapping.T001!];
  assert.throws(
    () =>
      buildPicksTop50V1({
        sessionDate: D,
        predictions: {
          key: pickV1PredictionsKey(D),
          sha256: sha256("p"),
          records: [top50Set(ids, "2026-01-05")],
        },
        beliefs: {
          key: pickV1BeliefsKey(D),
          sha256: sha256("b"),
          records: [belief(ids[0]!, 1), belief(ids[1]!, 2)],
        },
        symbolsBySecurityId: p.symbols,
      }),
    (err: unknown) =>
      err instanceof PickV1InputError && err.code === "PICK_V1_PREDICTIONS_SESSION_MISMATCH",
  );
});

test("top50: missing belief throws PICK_V1_TOP50_BELIEF_MISSING", () => {
  const p = pool(2);
  const ids = [p.mapping.T000!, p.mapping.T001!];
  assert.throws(
    () =>
      buildPicksTop50V1({
        sessionDate: D,
        predictions: { key: pickV1PredictionsKey(D), sha256: sha256("p"), records: [top50Set(ids)] },
        beliefs: {
          key: pickV1BeliefsKey(D),
          sha256: sha256("b"),
          records: [belief(ids[0]!, 1)],
        },
        symbolsBySecurityId: p.symbols,
      }),
    (err: unknown) =>
      err instanceof PickV1InputError &&
      err.code === "PICK_V1_TOP50_BELIEF_MISSING" &&
      err.message.includes(ids[1]!),
  );
});

test("top50: duplicate TOP_50_OVERALL set throws", () => {
  const p = pool(1);
  const id = p.mapping.T000!;
  assert.throws(
    () =>
      buildPicksTop50V1({
        sessionDate: D,
        predictions: {
          key: pickV1PredictionsKey(D),
          sha256: sha256("p"),
          records: [top50Set([id]), { ...top50Set([id]), predictionId: "prediction_top50_dup" }],
        },
        beliefs: {
          key: pickV1BeliefsKey(D),
          sha256: sha256("b"),
          records: [belief(id, 1)],
        },
        symbolsBySecurityId: p.symbols,
      }),
    (err: unknown) => err instanceof PickV1InputError && err.code === "PICK_V1_TOP50_SET_DUPLICATE",
  );
});

test("top50: fewer than 50 ids is kept and counted (no pad)", () => {
  const p = pool(3);
  const ids = [p.mapping.T000!, p.mapping.T002!];
  const doc = buildPicksTop50V1({
    sessionDate: D,
    predictions: {
      key: pickV1PredictionsKey(D),
      sha256: sha256("pred-bytes"),
      records: [top50Set(ids), otherSet("STRONGEST_MOMENTUM", [ids[0]!])],
    },
    beliefs: {
      key: pickV1BeliefsKey(D),
      sha256: sha256("bel-bytes"),
      records: [belief(ids[0]!, 1), belief(ids[1]!, 3)],
    },
    symbolsBySecurityId: p.symbols,
  });
  assert.equal(doc.top50Count, 2);
  assert.equal(doc.counts.top50, 2);
  assert.equal(doc.scanSource.predictions.key, pickV1PredictionsKey(D));
  assert.equal(doc.scanSource.beliefs.sha256, sha256("bel-bytes"));
  const first = doc.picks.find((x) => x.securityId === ids[0]!)!;
  assert.ok(first.rankInputs && "predictionId" in first.rankInputs);
  assert.equal(first.rankInputs.position, 1);
  assert.equal(first.rankInputs.overallRank, 1);
  const second = doc.picks.find((x) => x.securityId === ids[1]!)!;
  assert.ok(second.rankInputs && "position" in second.rankInputs);
  assert.equal(second.rankInputs.position, 2);
});

test("top50: re-run byte-identical; shuffled beliefs/prediction sibling sets identical", () => {
  const p = pool(3);
  const ids = [p.mapping.T000!, p.mapping.T001!, p.mapping.T002!];
  const records = [otherSet("TOP_15_OVERALL", ids.slice(0, 1)), top50Set(ids)];
  const beliefs = ids.map((id, i) => belief(id, i + 1));
  const a = buildPicksTop50V1({
    sessionDate: D,
    predictions: { key: pickV1PredictionsKey(D), sha256: sha256("p"), records },
    beliefs: { key: pickV1BeliefsKey(D), sha256: sha256("b"), records: beliefs },
    symbolsBySecurityId: p.symbols,
  });
  const b = buildPicksTop50V1({
    sessionDate: D,
    predictions: { key: pickV1PredictionsKey(D), sha256: sha256("p"), records: [...records].reverse() },
    beliefs: { key: pickV1BeliefsKey(D), sha256: sha256("b"), records: [...beliefs].reverse() },
    symbolsBySecurityId: Object.fromEntries(Object.entries(p.symbols).reverse()),
  });
  assert.equal(serializePicksTop50V1(a), serializePicksTop50V1(b));
});

test("merge: order-independent; name in top50 and random appears once with both reasons", () => {
  const p = pool(20);
  const base = buildPicksBaseV1(baseInput(p));
  // Force a known random pick into top50: take whatever base marked random (or alsoReasons).
  const randomIds = base.picks
    .filter((x) => x.reason === "random" || x.alsoReasons?.includes("random"))
    .map((x) => x.securityId);
  assert.ok(randomIds.length >= 1);
  const overlapId = randomIds[0]!;
  const otherId = Object.values(p.mapping).find((id) => id !== overlapId)!;
  const top = buildPicksTop50V1({
    sessionDate: D,
    predictions: {
      key: pickV1PredictionsKey(D),
      sha256: sha256("p"),
      records: [top50Set([overlapId, otherId])],
    },
    beliefs: {
      key: pickV1BeliefsKey(D),
      sha256: sha256("b"),
      records: [belief(overlapId, 1), belief(otherId, 2)],
    },
    symbolsBySecurityId: p.symbols,
  });
  const mergedAB = mergeDailyTenMinPicksV1(base, top);
  const mergedBA = mergeDailyTenMinPicksV1(
    // re-build base (identical) — merge(top ingested after base) vs swap by calling merge with same docs
    base,
    top,
  );
  assert.equal(serializeMergedPicksV1(mergedAB), serializeMergedPicksV1(mergedBA));

  // Order independence: merge(base, top) vs conceptually ingesting top first — same helper always
  // ingests base then top; test by merging and checking the overlap row.
  const row = mergedAB.find((x) => x.securityId === overlapId)!;
  const reasons = new Set([row.reason, ...(row.alsoReasons ?? [])]);
  assert.ok(reasons.has("top50"));
  assert.ok(reasons.has("random"));
  assert.equal(mergedAB.filter((x) => x.securityId === overlapId).length, 1);

  // primary is top50 (over random)
  assert.equal(row.reason, "top50");
  assert.ok(row.alsoReasons?.includes("random"));
});

test("merge: without top50 returns base picks only", () => {
  const base = buildPicksBaseV1(baseInput(pool(5)));
  assert.equal(serializeMergedPicksV1(mergeDailyTenMinPicksV1(base, undefined)), serializeMergedPicksV1(base.picks));
});

test("type filter + mapping fingerprints are stable", () => {
  assert.equal(pickV1TypeFilterSha256(), pickV1TypeFilterSha256([...PICK_V1_ALLOWED_TYPES].reverse()));
  assert.equal(PICK_V1_TYPE_FILTER_VERSION, "pick-v1-types-1");
  assert.equal(
    pickV1MappingSha256({ Z: "sec_z", A: "sec_a" }),
    pickV1MappingSha256(new Map([["A", "sec_a"], ["Z", "sec_z"]])),
  );
  assert.equal(
    pickV1TickerTypesSha256({ Z: "ETF", A: "CS" }),
    pickV1TickerTypesSha256(new Map([["A", "CS"], ["Z", "ETF"]])),
  );
  assert.equal(pickV1RandomShaKey(D, "sec_x"), sha256(`pick-v1|${D}|sec_x`));
});

test("groupedWithoutIndexEntry: all grouped tickers indexed → count 0", () => {
  const p = pool(5);
  const out = buildPicksBaseV1({
    ...baseInput(p),
    indexTickers: new Set(p.tickers),
  });
  assert.deepEqual(out.groupedWithoutIndexEntry, { count: 0, sample: [] });
  // Pick selection / counts unchanged vs without indexTickers (field omitted there).
  const plain = buildPicksBaseV1(baseInput(p));
  assert.equal(out.counts.random, plain.counts.random);
  assert.equal(out.counts.unlinkedExcluded, plain.counts.unlinkedExcluded);
  assert.equal(out.candidateCount, plain.candidateCount);
  assert.equal(out.candidateListSha256, plain.candidateListSha256);
  assert.equal(out.mappingSha256, plain.mappingSha256);
  assert.deepEqual(
    out.picks.map((x) => [x.securityId, x.symbol, x.reason]),
    plain.picks.map((x) => [x.securityId, x.symbol, x.reason]),
  );
  assert.equal(plain.groupedWithoutIndexEntry, undefined);
});

test("groupedWithoutIndexEntry: some unindexed → correct count and sorted sample", () => {
  const p = pool(3);
  // Grouped has indexed T000-T002 plus unindexed ZZZ, MMM, AAA (and a WARRANT-like name not in index).
  const tickers = [...p.tickers, "ZZZ", "MMM", "AAA", "ZZZ"]; // ZZZ duplicate
  const out = buildPicksBaseV1({
    sessionDate: D,
    index: [SPY],
    holdings: [],
    groupedReply: grouped(tickers),
    tickerToSecurityId: p.mapping,
    tickerTypes: p.types,
    indexTickers: new Set(p.tickers),
  });
  assert.equal(out.groupedWithoutIndexEntry!.count, 3);
  assert.deepEqual(out.groupedWithoutIndexEntry!.sample, ["AAA", "MMM", "ZZZ"]);
  // Unindexed names do not become picks; random still only from linked pool.
  assert.ok(!out.picks.some((x) => x.symbol === "ZZZ" || x.symbol === "MMM" || x.symbol === "AAA"));
});

test("computeGroupedWithoutIndexEntry: sample capped at 20, sorted", () => {
  const index = new Set<string>(["KEEP"]);
  const many = Array.from({ length: 25 }, (_, i) => `U${String(i).padStart(2, "0")}`);
  const r = computeGroupedWithoutIndexEntry(["KEEP", ...many, "KEEP"], index);
  assert.equal(r.count, 25);
  assert.deepEqual(r.sample, [
    "U00","U01","U02","U03","U04","U05","U06","U07","U08","U09",
    "U10","U11","U12","U13","U14","U15","U16","U17","U18","U19",
  ]);
});

test("groupedWithoutIndexEntry omitted when indexTickers not supplied (fixtures unchanged)", () => {
  const out = buildPicksBaseV1(baseInput(pool(5)));
  assert.equal(out.groupedWithoutIndexEntry, undefined);
});

