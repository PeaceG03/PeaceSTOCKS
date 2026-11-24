import assert from "node:assert/strict";
import test from "node:test";
import { FakeMarket, RecordingClient } from "./paper-fakes.test-helper";
import { paperLedgerKey, PaperLedgerStore, PAPER_KILL_KEY, type PaperDay, type PaperFills, type PaperIntents } from "./paper-ledger";
import { loadPaperRules, type LoadedPaperRules } from "./paper-rules";
import {
  buyFillPrice,
  checkFreezeProof,
  computeFills,
  dailyLossBreached,
  entryNotional,
  nextOpenSession,
  PaperBars,
  paperGate,
  runPaperTrading,
  sellFillPrice,
} from "./paper-trading";

const ON = { PAPER_TRADING_ENABLED: "true" };
const near = (actual: number, expected: number, what = "") => assert.ok(Math.abs(actual - expected) < 1e-6, `${what} ${actual} != ${expected}`);
const at = (date: string) => new Date(`${date}T11:15:00.000Z`); // 06:15 ET in December, before the open

function world(): FakeMarket {
  const m = new FakeMarket();
  m.security("spy", { symbol: "SPY", assetType: "ETF", eligibility: "LEVEL_3" });
  for (const id of ["a", "b", "c"]) m.security(id);
  for (const [id, px] of [["spy", 500], ["a", 100], ["b", 50], ["c", 20]] as const) m.bar(id, "2026-12-07", px, px);
  m.freeze("2026-12-07", "2026-12-08", ["a", "b"]);
  return m;
}
function day2(m: FakeMarket, aClose = 104) {
  m.bar("spy", "2026-12-08", 500, 505);
  m.bar("a", "2026-12-08", 100, aClose);
  m.bar("b", "2026-12-08", 50, 50);
  m.bar("c", "2026-12-08", 20, 20);
  m.freeze("2026-12-08", "2026-12-09", ["b", "c"]);
}
function day3(m: FakeMarket) {
  m.bar("spy", "2026-12-09", 510, 510);
  m.bar("a", "2026-12-09", 110, 110);
  m.bar("b", "2026-12-09", 49, 49);
  m.bar("c", "2026-12-09", 20, 20);
  m.freeze("2026-12-09", "2026-12-10", ["c"]);
}

async function run(client: RecordingClient, market: FakeMarket, now: Date, env: Record<string, string> = ON, killFileExists = false, loaded: LoadedPaperRules = loadPaperRules()) {
  return runPaperTrading({ ledger: new PaperLedgerStore(client), market, loaded, now, env, killFileExists });
}
async function read<T>(client: RecordingClient, key: string): Promise<T> {
  return (await new PaperLedgerStore(client).read<T>(key))!;
}

test("gate: default off; only exactly 'true' turns it on; nothing is read or written when off", async () => {
  assert.deepEqual(paperGate({}, false), { state: "DISABLED" });
  for (const value of ["TRUE", "1", "yes", " true", ""]) assert.equal(paperGate({ PAPER_TRADING_ENABLED: value }, false).state, "DISABLED");
  assert.deepEqual(paperGate(ON, false), { state: "ON" });
  const client = new RecordingClient();
  const market = world();
  const result = await run(client, market, at("2026-12-08"), {});
  assert.equal(result.gate, "DISABLED");
  assert.deepEqual(client.calls, []);
  assert.deepEqual(market.calls, []);
});

test("kill switch: variable, file or bucket object stops every order and write", async () => {
  assert.deepEqual(paperGate({ ...ON, PAPER_TRADING_KILL: "true" }, false), { state: "KILLED", source: "VARIABLE" });
  assert.deepEqual(paperGate({ ...ON, PAPER_TRADING_KILL: "anything" }, false), { state: "KILLED", source: "VARIABLE" });
  assert.deepEqual(paperGate({ ...ON, PAPER_TRADING_KILL: "false" }, false), { state: "ON" });
  assert.deepEqual(paperGate({ ...ON, PAPER_TRADING_KILL: "" }, true), { state: "KILLED", source: "FILE" });
  for (const [env, file] of [[{ ...ON, PAPER_TRADING_KILL: "true" }, false], [ON, true]] as const) {
    const client = new RecordingClient();
    const market = world();
    const result = await run(client, market, at("2026-12-08"), env, file);
    assert.equal(result.gate, "KILLED");
    assert.deepEqual(client.calls, []);
    assert.deepEqual(market.calls, []);
  }
  const client = new RecordingClient();
  client.objects.set(PAPER_KILL_KEY, new Uint8Array());
  const market = world();
  const result = await run(client, market, at("2026-12-08"));
  assert.deepEqual([result.gate, result.killedBy], ["KILLED", "BUCKET"]);
  assert.deepEqual(client.puts, []);
  assert.deepEqual(market.calls, []);
});

test("freeze proof: only a clean FROZEN/PREDICTIONS_FROZEN freeze before the open passes", () => {
  const D = "2026-12-07";
  const T = "2026-12-08";
  const proof = (patch: Parameters<FakeMarket["freeze"]>[3] = {}, setPatch: Parameters<FakeMarket["freeze"]>[4] = {}, extra?: (m: FakeMarket) => void) => {
    const m = new FakeMarket();
    m.freeze(D, T, ["a", "b", "a"], patch, setPatch);
    extra?.(m);
    return checkFreezeProof(m.statuses, m.sets, D, T, "TOP_15_OVERALL");
  };
  const ok = proof();
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok && ok.securityIds, ["a", "b"]);
  assert.deepEqual(checkFreezeProof([], [], D, T, "TOP_15_OVERALL"), { ok: false, reason: "NO_FREEZE_STATUS" });
  const reason = (p: ReturnType<typeof proof>) => (p.ok ? "OK" : p.reason);
  assert.equal(reason(proof({ status: "UNAVAILABLE", reason: "SOURCE_COLLECTION_FAILED" })), "UNAVAILABLE");
  assert.equal(reason(proof({ status: "UNAVAILABLE", reason: "FREEZE_AFTER_OPEN" })), "UNAVAILABLE");
  assert.equal(reason(proof({ status: "UNAVAILABLE", reason: "EVIDENCE_ONLY" })), "EVIDENCE_ONLY");
  // An EVIDENCE_ONLY record next to a FROZEN one still refuses.
  assert.equal(reason(proof({}, {}, (m) => m.statuses.push({ ...m.statuses[0]!, predictionStatusId: "e", status: "UNAVAILABLE", reason: "EVIDENCE_ONLY" }))), "EVIDENCE_ONLY");
  assert.equal(reason(proof({ reason: "NO_QUALIFYING_CANDIDATES" })), "NOT_PREDICTIONS_FROZEN");
  for (const missing of ["predictedAt", "nextSessionOpen", "nextSessionDate"] as const) {
    const m = new FakeMarket();
    m.freeze(D, T, ["a"]);
    delete (m.statuses[0] as unknown as Record<string, unknown>)[missing];
    assert.equal(reason(checkFreezeProof(m.statuses, m.sets, D, T, "TOP_15_OVERALL")), "FREEZE_PROOF_MISSING", missing);
  }
  assert.equal(reason(proof({ predictedAt: "garbage" })), "FREEZE_PROOF_MISSING");
  assert.equal(reason(proof({ nextSessionDate: "2026-12-09" })), "FREEZE_SESSION_MISMATCH");
  assert.equal(reason(proof({ nextSessionOpen: "2026-12-08T15:30:00.000Z" })), "FREEZE_SESSION_MISMATCH");
  assert.equal(reason(proof({ predictedAt: "2026-12-08T14:30:00.000Z" })), "FROZEN_AFTER_OPEN"); // exactly the open
  assert.equal(reason(proof({ predictedAt: "2026-12-08T14:29:59.999Z" })), "OK");
  assert.equal(reason(proof({}, { setType: "TOP_50_OVERALL" })), "LIST_MISSING");
  assert.equal(reason(proof({}, {}, (m) => m.sets.push({ ...m.sets[0]!, predictionId: "other" }))), "LIST_MISSING");
  assert.equal(reason(proof({}, { securityIds: [] })), "LIST_EMPTY");
  assert.equal(reason(proof({}, { unavailableReason: "INSUFFICIENT_HISTORY" })), "LIST_EMPTY");
  assert.equal(reason(proof({}, { frozenAt: "2026-12-08T14:30:00.000Z" })), "FROZEN_AFTER_OPEN");
  // A status for another session is ignored.
  assert.equal(reason(proof({ sessionDate: "2026-12-04" })), "NO_FREEZE_STATUS");
});

test("next open: before 09:30 ET it is today; at or after it, the next trading session", () => {
  assert.equal(nextOpenSession(new Date("2026-12-08T14:29:59.999Z")), "2026-12-08");
  assert.equal(nextOpenSession(new Date("2026-12-08T14:30:00.000Z")), "2026-12-09");
  assert.equal(nextOpenSession(new Date("2026-12-11T20:00:00.000Z")), "2026-12-14"); // Friday -> Monday
  assert.equal(nextOpenSession(new Date("2026-12-25T12:00:00.000Z")), "2026-12-28"); // holiday
});

test("sizing and costs: equal weight capped at 10% of equity, whole shares, 10 bps each side", () => {
  assert.equal(entryNotional(100000, 15, 0.1), 100000 / 15);
  assert.equal(entryNotional(100000, 2, 0.1), 10000);
  assert.equal(entryNotional(100000, 10, 0.1), 10000);
  assert.equal(entryNotional(0, 2, 0.1), 0);
  near(buyFillPrice(100, 10), 100.1);
  near(sellFillPrice(100, 10), 99.9);
  assert.equal(dailyLossBreached(100000, 97000, 0.03), true);
  assert.equal(dailyLossBreached(100000, 97000.01, 0.03), false);
  assert.equal(dailyLossBreached(100000, 90000, 0.03), true);
  assert.equal(dailyLossBreached(0, 1, 0.03), true);
});

test("end to end: intents before the open, fills from stored opens, day row vs SPY and universe", async () => {
  const client = new RecordingClient();
  const m = world();
  const r1 = await run(client, m, at("2026-12-08"));
  assert.deepEqual(r1.intents, { sessionDate: "2026-12-08", outcome: "WRITTEN", entries: 2, exits: 0 });
  const i1 = await read<PaperIntents>(client, paperLedgerKey("intents", "2026-12-08"));
  assert.deepEqual(i1.orders.map((o) => [o.side, o.securityId, o.clientOrderId]), [
    ["BUY", "a", "paper-rules-v1_2026-12-08_a_BUY"],
    ["BUY", "b", "paper-rules-v1_2026-12-08_b_BUY"],
  ]);
  assert.equal(i1.recordedAt, "2026-12-08T11:15:00.000Z");
  assert.ok(Date.parse(i1.recordedAt) < Date.parse(i1.sessionOpen));

  day2(m);
  const r2 = await run(client, m, at("2026-12-09"));
  assert.deepEqual(r2.filled, ["2026-12-08"]);
  const f1 = await read<PaperFills>(client, paperLedgerKey("fills", "2026-12-08"));
  assert.deepEqual(f1.fills.map((f) => [f.securityId, f.status, f.qty]), [["a", "FILLED", 99], ["b", "FILLED", 199]]);
  near(f1.fills[0]!.fillPrice!, 100.1);
  near(f1.cashAfter, 100000 - 99 * 100.1 - 199 * 50.05, "cash");
  for (const fill of f1.fills) assert.ok(fill.notionalUsd <= 0.1 * f1.equityAtOpen, "position cap");
  const i2 = await read<PaperIntents>(client, paperLedgerKey("intents", "2026-12-09"));
  assert.deepEqual(i2.orders.map((o) => `${o.side} ${o.securityId}`), ["SELL a", "SELL b", "BUY b", "BUY c"]);

  day3(m);
  const r3 = await run(client, m, at("2026-12-10"));
  assert.deepEqual([r3.filled, r3.days], [["2026-12-09"], ["2026-12-09"]]);
  const f2 = await read<PaperFills>(client, paperLedgerKey("fills", "2026-12-09"));
  const exitCash = f1.cashAfter + 99 * 110 * 0.999 + 199 * 49 * 0.999;
  near(f2.cashAfterExits, exitCash, "exit cash");
  near(f2.equityAtOpen, exitCash);
  assert.deepEqual(f2.fills.filter((f) => f.side === "BUY").map((f) => [f.securityId, f.qty]), [["b", Math.floor(exitCash * 0.1 / 49.049)], ["c", Math.floor(exitCash * 0.1 / 20.02)]]);
  const d = await read<PaperDay>(client, paperLedgerKey("days", "2026-12-09"));
  near(d.paperReturn, exitCash / 100000 - 1, "paper");
  near(d.spyReturn!, 0.02, "spy");
  near(d.universeReturn!, (0.1 - 0.02 + 0 + 0.02) / 4, "universe");
  assert.equal(d.universeSize, 4);
  near(d.cumulativePaperReturn, d.paperReturn);
  near(d.costsUsd, 99 * 100 * 0.001 + 199 * 50 * 0.001 + 99 * 110 * 0.001 + 199 * 49 * 0.001, "costs");
  assert.equal(d.positions, 2);

  // Every ledger row carries the rules version and file hash.
  const { rulesSha256 } = loadPaperRules();
  for (const row of [i1, i2, f1, f2, d, ...i1.orders, ...f1.fills, ...f2.fills]) assert.deepEqual([row.rulesVersion, row.rulesSha256], ["paper-rules-v1", rulesSha256]);
  // Append-only: no key was ever put twice.
  assert.equal(new Set(client.puts).size, client.puts.length);
});

test("costs: P&L is net of slippage both sides and commission", () => {
  const loaded = loadPaperRules();
  const withCommission: LoadedPaperRules = { ...loaded, rules: { ...loaded.rules, commissionPerOrderUsd: 1 } };
  const bars = new PaperBars([
    { securityId: "a", sessionDate: "2026-12-08", open: 100, close: 100, revision: 1 },
    { securityId: "a", sessionDate: "2026-12-09", open: 100, close: 100, revision: 1 },
  ] as never);
  const intent = (S: string, side: "BUY" | "SELL"): PaperIntents => ({
    schemaVersion: "paper-intents-v1", rulesVersion: "paper-rules-v1", rulesSha256: "x", sessionDate: S, freezeSessionDate: "2026-12-07",
    recordedAt: "", sessionOpen: "", orders: [{ rulesVersion: "paper-rules-v1", rulesSha256: "x", clientOrderId: `${S}${side}`, sessionDate: S, securityId: "a", side, purpose: side === "BUY" ? "ENTRY" : "EXIT" }],
  });
  for (const [rules, commission] of [[loaded, 0], [withCommission, 1]] as const) {
    const entry = computeFills({ intents: intent("2026-12-08", "BUY"), prior: { cash: 100000, positions: [] }, bars, splits: new Map(), loaded: rules });
    const exit = computeFills({ intents: intent("2026-12-09", "SELL"), prior: { cash: entry.cashAfter, positions: entry.positionsAfter }, bars, splits: new Map(), loaded: rules });
    const qty = entry.fills[0]!.qty;
    assert.equal(qty, Math.floor((10000 - commission) / 100.1));
    near(exit.cashAfter - 100000, qty * (99.9 - 100.1) - 2 * commission, `net with commission ${commission}`);
    near(entry.fills[0]!.slippageUsd + exit.fills[0]!.slippageUsd, qty * 0.2, "slippage");
    assert.ok(exit.cashAfter < 100000);
  }
});

test("daily loss limit: a 3% open-to-close loss blocks the next entries; exits still happen", async () => {
  const client = new RecordingClient();
  const m = world();
  await run(client, m, at("2026-12-08"));
  day2(m, 60); // a closes at 60: book marks about -4% from the open
  const r = await run(client, m, at("2026-12-09"));
  assert.deepEqual(r.intents, { sessionDate: "2026-12-09", outcome: "WRITTEN", entries: 0, exits: 2, entriesRefused: "DAILY_LOSS_LIMIT" });
  const i2 = await read<PaperIntents>(client, paperLedgerKey("intents", "2026-12-09"));
  assert.deepEqual(i2.orders.map((o) => `${o.side} ${o.securityId}`), ["SELL a", "SELL b"]);

  const client2 = new RecordingClient();
  const m2 = world();
  await run(client2, m2, at("2026-12-08"));
  day2(m2, 75); // about -2.6%: entries allowed
  assert.equal((await run(client2, m2, at("2026-12-09"))).intents!.entries, 2);
});

test("EVIDENCE_ONLY / UNAVAILABLE sessions: no entries, exits still written; no status yet: nothing written", async () => {
  for (const patch of [{ status: "UNAVAILABLE", reason: "EVIDENCE_ONLY" }, { status: "UNAVAILABLE", reason: "SOURCE_COLLECTION_FAILED" }] as const) {
    const client = new RecordingClient();
    const m = world();
    await run(client, m, at("2026-12-08"));
    day2(m);
    m.statuses = m.statuses.filter((s) => s.sessionDate !== "2026-12-08");
    m.freeze("2026-12-08", "2026-12-09", ["b", "c"], patch);
    const r = await run(client, m, at("2026-12-09"));
    assert.equal(r.intents!.entries, 0);
    assert.equal(r.intents!.entriesRefused, patch.reason === "EVIDENCE_ONLY" ? "EVIDENCE_ONLY" : "UNAVAILABLE");
    const i2 = await read<PaperIntents>(client, paperLedgerKey("intents", "2026-12-09"));
    assert.deepEqual(i2.orders.map((o) => o.side), ["SELL", "SELL"]);
  }
  const client = new RecordingClient();
  const m = world();
  m.statuses = [];
  const r = await run(client, m, at("2026-12-08"));
  assert.equal(r.intents!.outcome, "DEFERRED_NO_FREEZE_STATUS");
  assert.deepEqual(client.puts, []);
});

test("idempotent retry: a second run writes nothing; a crash mid-run resumes to the same ledger", async () => {
  const steps = async (client: RecordingClient, crashOn?: string) => {
    const m = world();
    await run(client, m, at("2026-12-08"));
    day2(m);
    await run(client, m, at("2026-12-09"));
    day3(m);
    if (crashOn) {
      client.failPutOn = (key) => key === crashOn;
      await assert.rejects(run(client, m, at("2026-12-10")), /INJECTED_CRASH/u);
      client.failPutOn = undefined;
    }
    await run(client, m, at("2026-12-10"));
    const before = client.puts.length;
    const again = await run(client, m, at("2026-12-10"));
    assert.equal(client.puts.length, before, "retry wrote nothing");
    assert.deepEqual(again.filled, []);
    return client;
  };
  const clean = await steps(new RecordingClient());
  for (const crashOn of [paperLedgerKey("fills", "2026-12-09"), paperLedgerKey("days", "2026-12-09"), paperLedgerKey("intents", "2026-12-10")]) {
    const crashed = await steps(new RecordingClient(), crashOn);
    assert.deepEqual([...crashed.objects.keys()].sort(), [...clean.objects.keys()].sort(), crashOn);
    for (const [key, body] of clean.objects) {
      const text = new TextDecoder().decode(crashed.objects.get(key)!);
      // recordedAt is the run clock: identical here because both runs use the same clock.
      assert.equal(text, new TextDecoder().decode(body), `${crashOn} -> ${key}`);
    }
    assert.equal(new Set(crashed.puts).size, crashed.puts.length, "no key put twice");
  }
  // Client order ids are unique across the whole ledger.
  const ids: string[] = [];
  for (const s of ["2026-12-08", "2026-12-09", "2026-12-10"]) ids.push(...(await read<PaperIntents>(clean, paperLedgerKey("intents", s))).orders.map((o) => o.clientOrderId));
  assert.equal(new Set(ids).size, ids.length);
});

test("fills wait for stored bars; entries are refused while fills are pending, held names still get exits", async () => {
  const client = new RecordingClient();
  const m = world();
  await run(client, m, at("2026-12-08"));
  m.freeze("2026-12-08", "2026-12-09", ["c"]); // frozen, but 12-08 bars not stored
  const r = await run(client, m, at("2026-12-09"));
  assert.deepEqual([r.filled, r.pendingFills, r.intents!.entriesRefused], [[], 1, "FILLS_PENDING"]);
  const i2 = await read<PaperIntents>(client, paperLedgerKey("intents", "2026-12-09"));
  assert.deepEqual(i2.orders.map((o) => `${o.side} ${o.securityId}`), ["SELL a", "SELL b"]);
});

test("exits: missing price keeps the name held (no rebuy); splits adjust; unexplained gaps fill flat", async () => {
  const loaded = loadPaperRules();
  const position = { securityId: "a", qty: 100, entryOpen: 100, entryFillPrice: 100.1, entrySessionDate: "2026-12-08" };
  const order = (side: "BUY" | "SELL") => ({ rulesVersion: "v", rulesSha256: "x", clientOrderId: side, sessionDate: "2026-12-09", securityId: "a", side, purpose: side === "BUY" ? "ENTRY" as const : "EXIT" as const });
  const intents: PaperIntents = { schemaVersion: "paper-intents-v1", rulesVersion: "v", rulesSha256: "x", sessionDate: "2026-12-09", freezeSessionDate: "2026-12-08", recordedAt: "", sessionOpen: "", orders: [order("SELL"), order("BUY")] };
  const fills = (open: number | undefined, splits = new Map()) =>
    computeFills({ intents, prior: { cash: 0, positions: [position] }, bars: new PaperBars(open === undefined ? [{ securityId: "a", sessionDate: "2026-12-08", open: 100, close: 90, revision: 1 }, { securityId: "z", sessionDate: "2026-12-09", open: 1, close: 1, revision: 1 }] as never : [{ securityId: "a", sessionDate: "2026-12-09", open, close: open, revision: 1 }] as never), splits, loaded });
  const missing = fills(undefined);
  assert.deepEqual(missing.fills.map((f) => f.status), ["NO_PRICE", "ALREADY_HELD"]);
  assert.deepEqual(missing.positionsAfter, [position]);
  near(missing.equityAtOpen, 100 * 90, "marked at last close");
  const split = fills(51, new Map([["a", [{ effectiveDate: "2026-12-09", factor: 0.5 }]]])); // 2-for-1
  assert.equal(split.fills[0]!.status, "FILLED");
  near(split.fills[0]!.fillPrice!, 102 * 0.999, "split-adjusted exit");
  const gap = fills(51); // halves with no split record
  assert.deepEqual([gap.fills[0]!.status, gap.fills[0]!.flags], ["FILLED_FLAT", ["PRICE_GAP_UNEXPLAINED"]]);
  near(gap.fills[0]!.fillPrice!, 100 * 0.999);
  const conflict = fills(51, new Map([["a", [{ effectiveDate: "2026-12-09", factor: Number.NaN }]]]));
  assert.deepEqual(conflict.fills[0]!.flags, ["SPLIT_UNRECONCILED"]);
  const up = fills(170); // +70%, under 1.8x: a real move
  assert.equal(up.fills[0]!.status, "FILLED");
  assert.equal(fills(180).fills[0]!.status, "FILLED_FLAT"); // exactly 1.8x
});
