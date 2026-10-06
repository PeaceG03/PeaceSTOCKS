import assert from "node:assert/strict";
import test from "node:test";
import type { PredictionSet, PredictionStatus, ScannerBelief } from "./contracts";
import { SCANNER_VERSION } from "./contracts";
import { dailyReplyDustFileKey } from "./daily-reply-dust";
import { sha256Hex } from "./intraday-reply-dust";
import { MemoryObjectClient } from "./object-store";
import { makePredictionStatus } from "./prediction-status";
import { encodeReplyDust, nodeReplyDustBackend } from "./reply-dust";
import {
  buildPicksBaseV1,
  buildPicksTop50V1,
  pickV1BeliefsKey,
  pickV1PredictionsKey,
} from "./tenmin-daily-picks";
import {
  TENMIN_DAY_NOT_SEALED,
  TENMIN_DAY_NO_FORWARD_SCAN,
  TENMIN_DAY_OBJECT_CORRUPT,
  TENMIN_DAY_OUTSIDE_WINDOW,
  TENMIN_DAY_SHA_MISMATCH,
  classifyTop50Absence,
  immutableReplyDustStore,
  picksBacklog,
  putImmutableVerified,
  readTenMinDayPicks,
  readTenMinDaySecurityReply,
  sessionWithinMassiveWindow,
  tenMinDayManifestKey,
  tenMinDayObjectKey,
  tenMinDayPicksKey,
  tenMinDayTop50ManifestKey,
  writeTenMinDayPicks,
  writeTenMinDayTop50AddOn,
} from "./tenmin-day-picks";

const D = "2026-10-05";
const D2 = "2026-10-06";
const OBS = "2026-10-06T05:40:00.000Z";

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
    attemptedAt: OBS,
    supersedesPredictionIds: [],
    ...fields,
  });
}

function sampleBase(sessionDate = D) {
  const groupedKey = dailyReplyDustFileKey(sessionDate);
  return buildPicksBaseV1({
    sessionDate,
    index: [{ securityId: "sec_spy", symbol: "SPY" }],
    holdings: [{ securityId: "sec_hold", symbol: "HOLD" }],
    groupedReply: {
      key: groupedKey,
      sha256: "a".repeat(64),
      sessionDate,
      results: [
        { T: "SPY" },
        { T: "HOLD" },
        { T: "AAA" },
        { T: "BBB" },
        { T: "CCC" },
        { T: "DDD" },
        { T: "EEE" },
        { T: "FFF" },
        { T: "GGG" },
        { T: "HHH" },
        { T: "III" },
        { T: "JJJ" },
        { T: "KKK" },
        { T: "LLL" },
        { T: "MMM" },
        { T: "NNN" },
        { T: "OOO" },
        { T: "PPP" },
        { T: "QQQ" },
        { T: "RRR" },
      ],
    },
    tickerToSecurityId: {
      SPY: "sec_spy",
      HOLD: "sec_hold",
      AAA: "sec_aaa",
      BBB: "sec_bbb",
      CCC: "sec_ccc",
      DDD: "sec_ddd",
      EEE: "sec_eee",
      FFF: "sec_fff",
      GGG: "sec_ggg",
      HHH: "sec_hhh",
      III: "sec_iii",
      JJJ: "sec_jjj",
      KKK: "sec_kkk",
      LLL: "sec_lll",
      MMM: "sec_mmm",
      NNN: "sec_nnn",
      OOO: "sec_ooo",
      PPP: "sec_ppp",
      QQQ: "sec_qqq",
      RRR: "sec_rrr",
    },
    tickerTypes: Object.fromEntries(
      [
        "SPY",
        "HOLD",
        "AAA",
        "BBB",
        "CCC",
        "DDD",
        "EEE",
        "FFF",
        "GGG",
        "HHH",
        "III",
        "JJJ",
        "KKK",
        "LLL",
        "MMM",
        "NNN",
        "OOO",
        "PPP",
        "QQQ",
        "RRR",
      ].map((t) => [t, t === "SPY" || t === "QQQ" ? "ETF" : "CS"]),
    ),
  });
}

function sampleTop50(sessionDate = D, extraIds: string[] = ["sec_top"]) {
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

function reply(symbol: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      ticker: symbol,
      results: [{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 100, vw: 1.2, n: 3 }],
      status: "OK",
      request_id: `req-${symbol}`,
    }),
  );
}

function securityInputsFromBase(
  base: ReturnType<typeof sampleBase>,
  opts: { emptyId?: string; gapId?: string } = {},
) {
  return base.picks.map((p) => {
    if (p.securityId === opts.emptyId)
      return { securityId: p.securityId, symbol: p.symbol, status: "EMPTY" as const };
    if (p.securityId === opts.gapId)
      return {
        securityId: p.securityId,
        symbol: p.symbol,
        status: "GAP" as const,
        gapReason: "PROVIDER_GAP",
      };
    return {
      securityId: p.securityId,
      symbol: p.symbol,
      status: "STORED" as const,
      replyBody: reply(p.symbol),
    };
  });
}

test("classifyTop50Absence: missing → not_yet_frozen; EVIDENCE_ONLY/FREEZE_AFTER_OPEN → no_forward_scan", () => {
  assert.equal(classifyTop50Absence([]).reason, "not_yet_frozen");
  const evidence = classifyTop50Absence([
    status("scan_e", D, { status: "UNAVAILABLE", reason: "EVIDENCE_ONLY" }),
  ]);
  assert.equal(evidence.reason, "no_forward_scan");
  assert.equal(evidence.resolvedReason, "EVIDENCE_ONLY");
  const freeze = classifyTop50Absence([
    status("scan_f", D, { status: "UNAVAILABLE", reason: "FREEZE_AFTER_OPEN" }),
  ]);
  assert.equal(freeze.reason, "no_forward_scan");
  const notReady = classifyTop50Absence([
    status("scan_n", D, { status: "UNAVAILABLE", reason: "SOURCE_COLLECTION_FAILED" }),
  ]);
  assert.equal(notReady.reason, "not_yet_frozen");
});

test("sessionWithinMassiveWindow: both sides of the 2-year boundary", () => {
  const asOf = new Date("2026-10-06T12:00:00.000Z");
  assert.equal(sessionWithinMassiveWindow("2026-10-05", asOf), true);
  assert.equal(sessionWithinMassiveWindow("2024-10-06", asOf), true);
  assert.equal(sessionWithinMassiveWindow("2024-10-05", asOf), false);
  assert.equal(sessionWithinMassiveWindow("2026-10-07", asOf), false);
});

test("full write/read roundtrip with top50 present; EMPTY and GAP roundtrip; dedup merge visible", async () => {
  const store = immutableReplyDustStore(new MemoryObjectClient());
  const base = sampleBase(D);
  const top50 = sampleTop50(D, ["sec_top"]);
  // sec_spy is in both base (index) and top50 → primary holding/index beats top50
  const randomId = base.picks.find((p) => p.reason === "random")?.securityId;
  const securities = [
    ...securityInputsFromBase(base, {
      emptyId: "sec_hold",
      ...(randomId ? { gapId: randomId } : {}),
    }),
    {
      securityId: "sec_top",
      symbol: "TOP",
      status: "STORED" as const,
      replyBody: reply("TOP"),
    },
  ];
  const manifest = await writeTenMinDayPicks(store, {
    sessionDate: D,
    picksBase: base,
    picksTop50: top50,
    securities,
    observedAt: OBS,
  });
  assert.equal(manifest.top50.state, "present");
  assert.ok(manifest.picksTop50Sha256);
  const spy = manifest.picks.find((p) => p.securityId === "sec_spy");
  assert.ok(spy);
  assert.equal(spy!.reason, "index"); // index > top50
  assert.ok(spy!.alsoReasons?.includes("top50"));
  const hold = manifest.securities.find((s) => s.securityId === "sec_hold");
  assert.equal(hold?.status, "EMPTY");
  const gap = manifest.securities.find((s) => s.status === "GAP");
  assert.ok(gap);
  assert.equal(gap!.gapReason, "PROVIDER_GAP");

  const read = await readTenMinDayPicks(store, D);
  assert.equal(read.status, "SEALED");
  if (read.status !== "SEALED") return;
  assert.equal(read.top50.state, "present");
  assert.deepEqual(
    read.picks.map((p) => p.securityId),
    manifest.picks.map((p) => p.securityId),
  );
  const topReply = await readTenMinDaySecurityReply(store, D, "sec_top");
  assert.equal(new TextDecoder().decode(topReply), new TextDecoder().decode(reply("TOP")));
});

test("absent then add-only manifest-top50 later; refused outside 2-year window; day manifest never rewritten", async () => {
  const raw = new MemoryObjectClient();
  const store = immutableReplyDustStore(raw);
  const base = sampleBase(D);
  const first = await writeTenMinDayPicks(store, {
    sessionDate: D,
    picksBase: base,
    predictionStatuses: [], // not yet frozen
    securities: securityInputsFromBase(base),
    observedAt: OBS,
  });
  assert.equal(first.top50.state, "absent");
  if (first.top50.state !== "absent") return;
  assert.equal(first.top50.reason, "not_yet_frozen");
  const dayManifestBytes = await raw.get(tenMinDayManifestKey(D));
  assert.ok(dayManifestBytes);

  await assert.rejects(
    () =>
      writeTenMinDayTop50AddOn(store, {
        sessionDate: D,
        picksBase: base,
        picksTop50: sampleTop50(D),
        securities: [
          { securityId: "sec_top", symbol: "TOP", status: "STORED", replyBody: reply("TOP") },
        ],
        observedAt: OBS,
        withinWindow: false,
      }),
    (e: Error) => e.message.startsWith(TENMIN_DAY_OUTSIDE_WINDOW),
  );

  const addOn = await writeTenMinDayTop50AddOn(store, {
    sessionDate: D,
    picksBase: base,
    picksTop50: sampleTop50(D),
    securities: [
      { securityId: "sec_top", symbol: "TOP", status: "STORED", replyBody: reply("TOP") },
    ],
    observedAt: "2026-10-06T06:00:00.000Z",
    withinWindow: true,
  });
  assert.equal(addOn.top50.state, "present");
  assert.ok(addOn.securities.some((s) => s.securityId === "sec_top"));
  // Day manifest.json bytes unchanged.
  assert.deepEqual(await raw.get(tenMinDayManifestKey(D)), dayManifestBytes);

  const read = await readTenMinDayPicks(store, D);
  assert.equal(read.status, "SEALED");
  if (read.status !== "SEALED") return;
  assert.equal(read.top50.state, "present"); // add-only wins
  assert.ok(read.top50Manifest);
  assert.ok(read.picks.some((p) => p.securityId === "sec_top"));
  assert.ok(read.securities.some((s) => s.securityId === "sec_top"));
});

test("resume after crash between picks.json and manifest: identical reuse; truncated/wrong leftovers CORRUPT", async () => {
  const raw = new MemoryObjectClient();
  const store = immutableReplyDustStore(raw);
  const base = sampleBase(D);
  // Write a valid picks.json via a first partial attempt using putImmutableVerified with real bytes
  const { serializePicksBaseV1 } = await import("./tenmin-daily-picks");
  const goodPicks = new TextEncoder().encode(`${serializePicksBaseV1(base)}\n`);
  await putImmutableVerified(raw, tenMinDayPicksKey(D), goodPicks);

  // Resume full write — should reuse picks.json and finish.
  const manifest = await writeTenMinDayPicks(store, {
    sessionDate: D,
    picksBase: base,
    picksTop50: sampleTop50(D),
    securities: [
      ...securityInputsFromBase(base),
      { securityId: "sec_top", symbol: "TOP", status: "STORED", replyBody: reply("TOP") },
    ],
    observedAt: OBS,
  });
  assert.equal(manifest.top50.state, "present");

  // Truncated .rdust leftover on a fresh day.
  const D3 = "2026-10-07";
  const base3 = sampleBase(D3);
  const victim = base3.picks[0]!;
  const key = tenMinDayObjectKey(D3, victim.securityId, victim.symbol);
  const full = encodeReplyDust(reply(victim.symbol), nodeReplyDustBackend);
  await raw.put(key, full.slice(0, Math.max(1, full.length - 5))); // truncated
  await assert.rejects(
    () =>
      writeTenMinDayPicks(store, {
        sessionDate: D3,
        picksBase: base3,
        securities: securityInputsFromBase(base3),
        predictionStatuses: [],
        observedAt: OBS,
      }),
    (e: Error) => e.message.startsWith(`${TENMIN_DAY_OBJECT_CORRUPT}:${key}`),
  );

  // Wrong-size picks.json leftover.
  const D4 = "2026-10-08";
  const base4 = sampleBase(D4);
  const wrong = new TextEncoder().encode('{"not":"the-picks"}\n');
  await raw.put(tenMinDayPicksKey(D4), wrong);
  await assert.rejects(
    () =>
      writeTenMinDayPicks(store, {
        sessionDate: D4,
        picksBase: base4,
        securities: securityInputsFromBase(base4),
        predictionStatuses: [],
        observedAt: OBS,
      }),
    (e: Error) => e.message.startsWith(`${TENMIN_DAY_OBJECT_CORRUPT}:${tenMinDayPicksKey(D4)}`),
  );
});

test("sha mismatch on read throws; missing manifest is NOT_SEALED", async () => {
  const raw = new MemoryObjectClient();
  const store = immutableReplyDustStore(raw);
  const notSealed = await readTenMinDayPicks(store, D);
  assert.equal(notSealed.status, TENMIN_DAY_NOT_SEALED);

  // Partial: picks.json only → still NOT_SEALED
  const base = sampleBase(D);
  const { serializePicksBaseV1 } = await import("./tenmin-daily-picks");
  await raw.put(
    tenMinDayPicksKey(D),
    new TextEncoder().encode(`${serializePicksBaseV1(base)}\n`),
  );
  assert.equal((await readTenMinDayPicks(store, D)).status, TENMIN_DAY_NOT_SEALED);

  await writeTenMinDayPicks(store, {
    sessionDate: D,
    picksBase: base,
    picksTop50: sampleTop50(D),
    securities: [
      ...securityInputsFromBase(base),
      { securityId: "sec_top", symbol: "TOP", status: "STORED", replyBody: reply("TOP") },
    ],
    observedAt: OBS,
  });
  // Corrupt picks.json after seal (bypass immutable wrapper).
  await raw.put(tenMinDayPicksKey(D), new TextEncoder().encode("tampered\n"));
  await assert.rejects(
    () => readTenMinDayPicks(store, D),
    (e: Error) => e.message.startsWith(`${TENMIN_DAY_SHA_MISMATCH}:picks.json`),
  );
});

test("picksBacklog: ordering + cap; no_forward_scan never returns; not_yet_frozen returns after FROZEN", async () => {
  const store = immutableReplyDustStore(new MemoryObjectClient());
  const asOf = new Date("2026-10-10T12:00:00.000Z");
  const within = (d: string) => sessionWithinMassiveWindow(d, asOf);

  // Day A: EVIDENCE_ONLY → no_forward_scan
  const dayA = "2026-10-01";
  const baseA = sampleBase(dayA);
  await writeTenMinDayPicks(store, {
    sessionDate: dayA,
    picksBase: baseA,
    predictionStatuses: [
      status("scan_a", dayA, { status: "UNAVAILABLE", reason: "EVIDENCE_ONLY" }),
    ],
    securities: securityInputsFromBase(baseA),
    observedAt: OBS,
  });

  // Day B: not_yet_frozen (pre-freeze)
  const dayB = "2026-10-02";
  const baseB = sampleBase(dayB);
  await writeTenMinDayPicks(store, {
    sessionDate: dayB,
    picksBase: baseB,
    predictionStatuses: [],
    securities: securityInputsFromBase(baseB),
    observedAt: OBS,
  });

  // Day C: unsealed (nothing written)
  const dayC = "2026-10-03";

  // Day D: FREEZE_AFTER_OPEN → no_forward_scan
  const dayD = "2026-10-04";
  const baseD = sampleBase(dayD);
  await writeTenMinDayPicks(store, {
    sessionDate: dayD,
    picksBase: baseD,
    predictionStatuses: [
      status("scan_d", dayD, { status: "UNAVAILABLE", reason: "FREEZE_AFTER_OPEN" }),
    ],
    securities: securityInputsFromBase(baseD),
    observedAt: OBS,
  });

  const frozen = new Set<string>();
  const backlog1 = await picksBacklog(store, {
    days: [dayC, dayB, dayA, dayD],
    limit: 10,
    withinWindow: within,
    hasFrozenPredictions: (d) => frozen.has(d),
  });
  // Only unsealed C (B still not_yet_frozen without FROZEN; A/D never)
  assert.deepEqual(backlog1, [{ sessionDate: dayC, reason: "UNSEALED" }]);

  // Cap
  const backlogCap = await picksBacklog(store, {
    days: [dayC, "2026-10-08", "2026-10-09"],
    limit: 2,
    withinWindow: within,
    hasFrozenPredictions: () => false,
  });
  assert.equal(backlogCap.length, 2);
  assert.deepEqual(
    backlogCap.map((e) => e.sessionDate),
    ["2026-10-03", "2026-10-08"],
  );

  // After B freezes, it enters backlog as ABSENT_TOP50
  frozen.add(dayB);
  const backlog2 = await picksBacklog(store, {
    days: [dayA, dayB, dayC, dayD],
    limit: 10,
    withinWindow: within,
    hasFrozenPredictions: (d) => frozen.has(d),
  });
  assert.deepEqual(backlog2, [
    { sessionDate: dayB, reason: "ABSENT_TOP50" },
    { sessionDate: dayC, reason: "UNSEALED" },
  ]);

  // Complete add-on for B → leaves backlog
  await writeTenMinDayTop50AddOn(store, {
    sessionDate: dayB,
    picksBase: baseB,
    picksTop50: sampleTop50(dayB),
    securities: [
      { securityId: "sec_top", symbol: "TOP", status: "STORED", replyBody: reply("TOP") },
    ],
    observedAt: OBS,
    withinWindow: true,
  });
  const backlog3 = await picksBacklog(store, {
    days: [dayA, dayB, dayC, dayD],
    limit: 10,
    withinWindow: within,
    hasFrozenPredictions: (d) => frozen.has(d),
  });
  assert.deepEqual(backlog3, [{ sessionDate: dayC, reason: "UNSEALED" }]);

  // A (EVIDENCE_ONLY) and D (FREEZE_AFTER_OPEN) still never return even if "frozen" flagged
  frozen.add(dayA);
  frozen.add(dayD);
  const backlog4 = await picksBacklog(store, {
    days: [dayA, dayD],
    limit: 10,
    withinWindow: within,
    hasFrozenPredictions: (d) => frozen.has(d),
  });
  assert.deepEqual(backlog4, []);

  // no_forward_scan add-on refused
  await assert.rejects(
    () =>
      writeTenMinDayTop50AddOn(store, {
        sessionDate: dayA,
        picksBase: baseA,
        picksTop50: sampleTop50(dayA),
        securities: [
          { securityId: "sec_top", symbol: "TOP", status: "STORED", replyBody: reply("TOP") },
        ],
        observedAt: OBS,
        withinWindow: true,
      }),
    (e: Error) => e.message.startsWith(TENMIN_DAY_NO_FORWARD_SCAN),
  );
});

test("different picks.json bytes on resume throw CORRUPT (immutable)", async () => {
  const raw = new MemoryObjectClient();
  const store = immutableReplyDustStore(raw);
  const base = sampleBase(D);
  const { serializePicksBaseV1 } = await import("./tenmin-daily-picks");
  await raw.put(
    tenMinDayPicksKey(D),
    new TextEncoder().encode(`${serializePicksBaseV1(base)}\n`),
  );
  await writeTenMinDayPicks(store, {
    sessionDate: D,
    picksBase: base,
    predictionStatuses: [],
    securities: securityInputsFromBase(base),
    observedAt: OBS,
  });
  // Attempting to put different picks bytes is rejected by the immutable store wrapper.
  await assert.rejects(
    () => store.put(tenMinDayPicksKey(D), new TextEncoder().encode('{"x":1}\n')),
    (e: Error) => e.message.includes(TENMIN_DAY_OBJECT_CORRUPT),
  );
});
