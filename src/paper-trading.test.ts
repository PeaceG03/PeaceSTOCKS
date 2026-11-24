import assert from "node:assert/strict";
import test from "node:test";
import { FakeMarket, RecordingClient } from "./paper-fakes.test-helper";
import { paperCorrectionKey, paperLedgerKey, PaperLedgerStore, PAPER_KILL_KEY, type PaperCorrection, type PaperDay, type PaperExits, type PaperFills, type PaperIntents } from "./paper-ledger";
import { loadPaperRules, type LoadedPaperRules } from "./paper-rules";
import {
  buyFillPrice,
  checkFreezeProof,
  computeFills,
  correctionsFor,
  dailyLossBreached,
  entryNotional,
  nextOpenSession,
  PaperBars,
  paperGate,
  runPaperTrading,
  sellFillPrice,
  windowReturn,
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
/** Every order for S's open: the exits object, then the entry intents ("SELL a", "BUY b"). */
async function ordersFor(client: RecordingClient, S: string): Promise<string[]> {
  const store = new PaperLedgerStore(client);
  const exits = await store.read<PaperExits>(paperLedgerKey("exits", S));
  const entries = await store.read<PaperIntents>(paperLedgerKey("intents", S));
  return [...(exits?.orders ?? []), ...(entries?.orders ?? [])].map((o) => `${o.side} ${o.securityId}`);
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
    ["BUY", "a", "paper-rules-v5_2026-12-08_a_BUY"],
    ["BUY", "b", "paper-rules-v5_2026-12-08_b_BUY"],
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
  assert.deepEqual(await ordersFor(client, "2026-12-09"), ["SELL a", "SELL b", "BUY b", "BUY c"]);
  const i2 = await read<PaperIntents>(client, paperLedgerKey("intents", "2026-12-09"));
  const e2 = await read<PaperExits>(client, paperLedgerKey("exits", "2026-12-09"));
  assert.deepEqual(r2.intents, { sessionDate: "2026-12-09", outcome: "WRITTEN", entries: 2, exits: 2 });

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
  for (const row of [i1, i2, e2, f1, f2, d, ...i1.orders, ...e2.orders, ...f1.fills, ...f2.fills]) assert.deepEqual([row.rulesVersion, row.rulesSha256], ["paper-rules-v5", rulesSha256]);
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
    schemaVersion: "paper-intents-v1", rulesVersion: "paper-rules-v5", rulesSha256: "x", sessionDate: S, freezeSessionDate: "2026-12-07",
    recordedAt: "", sessionOpen: "", orders: [{ rulesVersion: "paper-rules-v5", rulesSha256: "x", clientOrderId: `${S}${side}`, sessionDate: S, securityId: "a", side, purpose: side === "BUY" ? "ENTRY" : "EXIT" }],
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
  assert.deepEqual(await ordersFor(client, "2026-12-09"), ["SELL a", "SELL b"]);

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
    assert.deepEqual(await ordersFor(client, "2026-12-09"), ["SELL a", "SELL b"]);
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
  for (const s of ["2026-12-08", "2026-12-09", "2026-12-10"])
    for (const kind of ["intents", "exits"] as const) ids.push(...((await read<PaperIntents | undefined>(clean, paperLedgerKey(kind, s)))?.orders ?? []).map((o) => o.clientOrderId));
  assert.ok(ids.length >= 6);
  assert.equal(new Set(ids).size, ids.length);
});

test("fills wait for stored bars; entries are refused while fills are pending, held names still get exits", async () => {
  const client = new RecordingClient();
  const m = world();
  await run(client, m, at("2026-12-08"));
  m.freeze("2026-12-08", "2026-12-09", ["c"]); // frozen, but 12-08 bars not stored
  const r = await run(client, m, at("2026-12-09"));
  assert.deepEqual([r.filled, r.pendingFills, r.intents!.entriesRefused], [[], 1, "FILLS_PENDING"]);
  assert.deepEqual(await ordersFor(client, "2026-12-09"), ["SELL a", "SELL b"]);
});

test("exits fill at the actual open: a real crash is booked, splits adjust, conflicts use the raw open", () => {
  const loaded = loadPaperRules();
  const position = { securityId: "a", qty: 100, entryOpen: 100, entryFillPrice: 100.1, entrySessionDate: "2026-12-08" };
  const order = (side: "BUY" | "SELL") => ({ rulesVersion: "v", rulesSha256: "x", clientOrderId: side, sessionDate: "2026-12-09", securityId: "a", side, purpose: side === "BUY" ? "ENTRY" as const : "EXIT" as const });
  const intents: PaperIntents = { schemaVersion: "paper-intents-v1", rulesVersion: "v", rulesSha256: "x", sessionDate: "2026-12-09", freezeSessionDate: "2026-12-08", recordedAt: "", sessionOpen: "", orders: [order("SELL"), order("BUY")] };
  const fills = (open: number, splits = new Map()) =>
    computeFills({ intents, prior: { cash: 0, positions: [position] }, bars: new PaperBars([{ securityId: "a", sessionDate: "2026-12-09", open, close: open, revision: 1 }] as never), splits, loaded });
  const split = fills(51, new Map([["a", [{ effectiveDate: "2026-12-09", factor: 0.5 }]]])); // 2-for-1
  assert.deepEqual([split.fills[0]!.status, split.fills[0]!.splitFactorApplied, split.fills[0]!.rawPrice], ["FILLED", 0.5, 51]);
  near(split.fills[0]!.fillPrice!, 102 * 0.999, "split-adjusted exit");
  // Halves with no split record: a real move, booked at the actual open (no 'fill flat').
  const crash = fills(51);
  assert.deepEqual([crash.fills[0]!.status, crash.fills[0]!.flags, crash.fills[0]!.splitFactorApplied], ["FILLED", [], 1]);
  near(crash.fills[0]!.fillPrice!, 51 * 0.999, "crash at the actual open");
  near(crash.fills[0]!.notionalUsd, 100 * 51 * 0.999);
  const conflict = fills(51, new Map([["a", [{ effectiveDate: "2026-12-09", factor: Number.NaN }]]]));
  assert.deepEqual([conflict.fills[0]!.status, conflict.fills[0]!.flags, conflict.fills[0]!.splitFactorApplied], ["FILLED", ["SPLIT_UNRECONCILED"], 1]);
  near(conflict.fills[0]!.fillPrice!, 51 * 0.999, "unreconciled: actual open");
  for (const open of [170, 180, 250, 30]) near(fills(open).fills[0]!.fillPrice!, open * 0.999, `move to ${open}`);
});

test("exits with no open: held, counted and marked at the last close until the N-th miss (src/paper-stuck.test.ts covers N)", () => {
  const loaded = loadPaperRules();
  const position = (missedExits?: number) => ({ securityId: "a", qty: 100, entryOpen: 100, entryFillPrice: 100.1, entrySessionDate: "2026-12-01", ...(missedExits === undefined ? {} : { missedExits }) });
  const order = (side: "BUY" | "SELL") => ({ rulesVersion: "v", rulesSha256: "x", clientOrderId: side, sessionDate: "2026-12-09", securityId: "a", side, purpose: side === "BUY" ? "ENTRY" as const : "EXIT" as const });
  const intents: PaperIntents = { schemaVersion: "paper-intents-v1", rulesVersion: "v", rulesSha256: "x", sessionDate: "2026-12-09", freezeSessionDate: "2026-12-08", recordedAt: "", sessionOpen: "", orders: [order("SELL"), order("BUY")] };
  const bars = new PaperBars([{ securityId: "a", sessionDate: "2026-12-02", open: 100, close: 90, revision: 1 }, { securityId: "z", sessionDate: "2026-12-09", open: 1, close: 1, revision: 1 }] as never);
  const first = computeFills({ intents, prior: { cash: 0, positions: [position()] }, bars, splits: new Map(), loaded });
  assert.deepEqual(first.fills.map((f) => f.status), ["NO_PRICE", "ALREADY_HELD"]);
  assert.deepEqual(first.positionsAfter, [position(1)]);
  near(first.equityAtOpen, 100 * 90, "marked at last close");
  // At the N-th miss: $0, kept as a STUCK holding, still ALREADY_HELD for a new pick.
  const fifth = computeFills({ intents, prior: { cash: 0, positions: [position(4)] }, bars, splits: new Map(), loaded });
  assert.deepEqual(fifth.fills.map((f) => f.status), ["MARKED_ZERO", "ALREADY_HELD"]);
  near(fifth.equityAtOpen, 0);
});

test("benchmarks treat names like paper exits: big moves count, conflicts use the raw open, splits adjust", () => {
  const bars = new PaperBars([
    { securityId: "a", sessionDate: "2026-12-08", open: 100, close: 100, revision: 1 },
    { securityId: "a", sessionDate: "2026-12-09", open: 51, close: 51, revision: 1 },
  ] as never);
  near(windowReturn(bars, new Map(), "a", "2026-12-08", "2026-12-09")!, -0.49, "crash counted");
  near(windowReturn(bars, new Map([["a", [{ effectiveDate: "2026-12-09", factor: 0.5 }]]]), "a", "2026-12-08", "2026-12-09")!, 0.02, "split");
  near(windowReturn(bars, new Map([["a", [{ effectiveDate: "2026-12-09", factor: Number.NaN }]]]), "a", "2026-12-08", "2026-12-09")!, -0.49, "conflict: raw");
  assert.equal(windowReturn(bars, new Map(), "a", "2026-12-08", "2026-12-10"), undefined);
});

test("end to end: a held name that halves with no split record is a loss in paper and in the universe alike", async () => {
  const client = new RecordingClient();
  const m = world();
  await run(client, m, at("2026-12-08"));
  m.bar("spy", "2026-12-08", 500, 500);
  m.bar("a", "2026-12-08", 100, 100);
  m.bar("b", "2026-12-08", 50, 50);
  m.bar("c", "2026-12-08", 20, 20);
  m.freeze("2026-12-08", "2026-12-09", ["c"]);
  await run(client, m, at("2026-12-09"));
  m.bar("spy", "2026-12-09", 500, 500);
  m.bar("a", "2026-12-09", 50, 50); // -50%, no split record
  m.bar("b", "2026-12-09", 50, 50);
  m.bar("c", "2026-12-09", 20, 20);
  m.freeze("2026-12-09", "2026-12-10", ["c"]);
  await run(client, m, at("2026-12-10"));
  const f = await read<PaperFills>(client, paperLedgerKey("fills", "2026-12-09"));
  const sellA = f.fills.find((x) => x.side === "SELL" && x.securityId === "a")!;
  assert.equal(sellA.status, "FILLED");
  near(sellA.fillPrice!, 50 * 0.999);
  const d = await read<PaperDay>(client, paperLedgerKey("days", "2026-12-09"));
  near(d.universeReturn!, (0 - 0.5 + 0 + 0) / 4, "universe keeps the crash"); // spy, a, b, c
  assert.equal(d.universeSize, 4);
  assert.ok(d.paperReturn < -0.03, `paper books the crash: ${d.paperReturn}`);
});

test("daily loss limit: exactly the limit counts as hit (<=, not <)", () => {
  // 50 / 100 - 1 is exactly -0.5 in floating point, so this pins the boundary.
  assert.equal(dailyLossBreached(100, 50, 0.5), true);
  assert.equal(dailyLossBreached(100, 50.000001, 0.5), false);
});

test("entries never spend more cash than is left, even when held names inflate equity", () => {
  const loaded = loadPaperRules();
  const held = { securityId: "h", qty: 90, entryOpen: 100, entryFillPrice: 100.1, entrySessionDate: "2026-12-07" };
  const buy = (id: string) => ({ rulesVersion: "v", rulesSha256: "x", clientOrderId: id, sessionDate: "2026-12-09", securityId: id, side: "BUY" as const, purpose: "ENTRY" as const });
  const intents: PaperIntents = { schemaVersion: "paper-intents-v1", rulesVersion: "v", rulesSha256: "x", sessionDate: "2026-12-09", freezeSessionDate: "2026-12-08", recordedAt: "", sessionOpen: "", orders: [buy("x"), buy("y")] };
  const bars = new PaperBars([
    { securityId: "h", sessionDate: "2026-12-08", open: 100, close: 100, revision: 1 },
    { securityId: "x", sessionDate: "2026-12-09", open: 10, close: 10, revision: 1 },
    { securityId: "y", sessionDate: "2026-12-09", open: 10, close: 10, revision: 1 },
  ] as never);
  // Equity 1,000 cash + 9,000 held (no exit order) = 10,000; 10% cap = 1,000 each, but only 1,000 cash.
  const fills = computeFills({ intents, prior: { cash: 1000, positions: [held] }, bars, splits: new Map(), loaded });
  near(fills.equityAtOpen, 10000);
  assert.deepEqual(fills.fills.map((f) => [f.securityId, f.status, f.qty]), [["x", "FILLED", Math.floor(1000 / 10.01)], ["y", "ZERO_QTY", 0]]);
  assert.ok(fills.cashAfter >= 0);
});

test("corrections: a later split record appends a correction (n, n+1), never re-corrects, never touches the fill", () => {
  const loaded = loadPaperRules();
  const fill = (status: "FILLED" | "MARKED_ZERO" | "NO_PRICE", fillPrice = 51 * 0.999) => ({
    rulesVersion: "paper-rules-v5", rulesSha256: "x", clientOrderId: "o", securityId: "a", side: "SELL" as const, purpose: "EXIT" as const,
    status, qty: 100, rawPrice: 51, fillPrice, splitFactorApplied: 1, entrySessionDate: "2026-12-08", notionalUsd: 0, commissionUsd: 0, slippageUsd: 0, flags: [],
  });
  const fills = (f: ReturnType<typeof fill>) => ({ schemaVersion: "paper-fills-v1", rulesVersion: "paper-rules-v5", rulesSha256: "x", sessionDate: "2026-12-09", cashBefore: 0, cashAfterExits: 0, equityAtOpen: 0, cashAfter: 0, positionsAfter: [], fills: [f] }) as PaperFills;
  const half = new Map([["a", [{ effectiveDate: "2026-12-09", factor: 0.5 }]]]);
  const now = new Date("2026-12-11T11:15:00.000Z");
  assert.deepEqual(correctionsFor({ fills: fills(fill("FILLED")), latest: new Map(), splits: new Map(), loaded, now }), []);
  const [first] = correctionsFor({ fills: fills(fill("FILLED")), latest: new Map(), splits: half, loaded, now });
  assert.deepEqual([first!.n, first!.previousFactor, first!.correctedFactor], [1, 1, 0.5]);
  near(first!.correctedFillPrice, 102 * 0.999);
  near(first!.cashAdjustmentUsd, 100 * (102 - 51) * 0.999);
  // Already corrected to this factor: nothing more.
  assert.deepEqual(correctionsFor({ fills: fills(fill("FILLED")), latest: new Map([["a", first!]]), splits: half, loaded, now }), []);
  // A further record changes the factor again: correction 2, relative to correction 1.
  const quarter = new Map([["a", [{ effectiveDate: "2026-12-09", factor: 0.5 }, { effectiveDate: "2026-12-09", factor: 0.5 }]]]);
  const [second] = correctionsFor({ fills: fills(fill("FILLED")), latest: new Map([["a", first!]]), splits: quarter, loaded, now });
  assert.deepEqual([second!.n, second!.previousFactor, second!.correctedFactor], [2, 0.5, 0.25]);
  near(second!.cashAdjustmentUsd, 100 * (204 - 102) * 0.999);
  // Unfilled exits and $0 marks are not split-corrected (a STUCK holding is resolved separately).
  assert.deepEqual(correctionsFor({ fills: fills(fill("MARKED_ZERO", 0)), latest: new Map(), splits: half, loaded, now }), []);
  assert.deepEqual(correctionsFor({ fills: fills(fill("NO_PRICE")), latest: new Map(), splits: half, loaded, now }), []);
  // A split outside (entry, exit] does not count.
  assert.deepEqual(correctionsFor({ fills: fills(fill("FILLED")), latest: new Map(), splits: new Map([["a", [{ effectiveDate: "2026-12-08", factor: 0.5 }]]]), loaded, now }), []);
});

test("corrections end to end: the late split is appended, the fill stays byte-identical, cash picks it up once", async () => {
  const client = new RecordingClient();
  const m = world();
  await run(client, m, at("2026-12-08"));
  day2(m);
  await run(client, m, at("2026-12-09"));
  m.bar("spy", "2026-12-09", 500, 500);
  m.bar("a", "2026-12-09", 55, 55); // a 2-for-1 split whose record is not stored yet
  m.bar("b", "2026-12-09", 50, 50);
  m.bar("c", "2026-12-09", 20, 20);
  m.freeze("2026-12-09", "2026-12-10", ["c"]);
  await run(client, m, at("2026-12-10"));
  const fillsKey = paperLedgerKey("fills", "2026-12-09");
  const before = new TextDecoder().decode(client.objects.get(fillsKey)!);
  const f9 = JSON.parse(before) as PaperFills;
  const sellA = f9.fills.find((f) => f.side === "SELL" && f.securityId === "a")!;
  near(sellA.fillPrice!, 55 * 0.999, "booked at the actual open first");

  m.split("a", "2026-12-09", 1, 2); // the record arrives late
  for (const [id, px] of [["spy", 500], ["a", 55], ["b", 50], ["c", 20]] as const) m.bar(id, "2026-12-10", px, px);
  m.freeze("2026-12-10", "2026-12-11", ["c"]);
  const r = await run(client, m, at("2026-12-11"));
  const key = paperCorrectionKey("2026-12-09", "a", 1);
  assert.deepEqual(r.corrections, [key]);
  assert.equal(new TextDecoder().decode(client.objects.get(fillsKey)!), before, "fill never rewritten");
  const c = await read<PaperCorrection>(client, key);
  near(c.cashAdjustmentUsd, sellA.qty * 55 * 0.999, "the split doubles the exit price");
  const f10 = await read<PaperFills>(client, paperLedgerKey("fills", "2026-12-10"));
  near(f10.cashBefore, f9.cashAfter + c.cashAdjustmentUsd, "applied at the next open");
  assert.deepEqual([f10.correctionsUsd, f10.correctionsApplied], [c.cashAdjustmentUsd, [key]]);
  near((await read<PaperDay>(client, paperLedgerKey("days", "2026-12-10"))).correctionsUsd!, c.cashAdjustmentUsd);

  // A retry writes nothing; the next open does not apply it again.
  const puts = client.puts.length;
  await run(client, m, at("2026-12-11"));
  assert.equal(client.puts.length, puts);
  for (const [id, px] of [["spy", 500], ["a", 55], ["b", 50], ["c", 20]] as const) m.bar(id, "2026-12-11", px, px);
  m.freeze("2026-12-11", "2026-12-14", ["c"]);
  await run(client, m, at("2026-12-14"));
  const f11 = await read<PaperFills>(client, paperLedgerKey("fills", "2026-12-11"));
  near(f11.cashBefore, f10.cashAfter, "not applied twice");
  assert.deepEqual([f11.correctionsUsd, f11.correctionsApplied], [0, [key]]);
  assert.equal([...client.objects.keys()].filter((k) => k.includes("/corrections/")).length, 1);
});

test("late scan: held names still get exit orders before the open and are sold at the following open", async () => {
  const client = new RecordingClient();
  const m = world();
  await run(client, m, at("2026-12-08")); // buys a, b at 12-08's open
  for (const [id, px] of [["spy", 500], ["a", 100], ["b", 50], ["c", 20]] as const) m.bar(id, "2026-12-08", px, px);
  // The 12-08 scan is late: no freeze status for 12-08 at any pre-open run of 12-09.
  const r = await run(client, m, at("2026-12-09"));
  assert.deepEqual(r.intents, { sessionDate: "2026-12-09", outcome: "DEFERRED_NO_FREEZE_STATUS", entries: 0, exits: 2 });
  assert.deepEqual(await ordersFor(client, "2026-12-09"), ["SELL a", "SELL b"]);
  const e = await read<PaperExits>(client, paperLedgerKey("exits", "2026-12-09"));
  assert.ok(Date.parse(e.recordedAt) < Date.parse(e.sessionOpen));
  // Later pre-open runs do not write the exits again.
  const puts = client.puts.length;
  await run(client, m, new Date("2026-12-09T12:15:00.000Z"));
  assert.equal(client.puts.length, puts);
  // The freeze lands after the open: too late for 12-09 entries; nothing for 12-09 is written. (That run
  // already prepares 12-10: 12-09's fills are not known yet, so a and b get 12-10 exits too, to be safe.)
  m.freeze("2026-12-08", "2026-12-09", ["c"], { predictedAt: "2026-12-09T15:00:00.000Z" });
  const late = await run(client, m, new Date("2026-12-09T15:05:00.000Z"));
  assert.equal(late.intents!.sessionDate, "2026-12-10");
  assert.deepEqual(client.puts.slice(puts), [paperLedgerKey("exits", "2026-12-10")]);
  // Next day: the held names were sold at 12-09's open, at the actual open.
  for (const [id, px] of [["spy", 500], ["a", 90], ["b", 55], ["c", 20]] as const) m.bar(id, "2026-12-09", px, px);
  m.freeze("2026-12-09", "2026-12-10", ["c"]);
  const r2 = await run(client, m, at("2026-12-10"));
  assert.deepEqual(r2.filled, ["2026-12-09"]);
  const f = await read<PaperFills>(client, paperLedgerKey("fills", "2026-12-09"));
  assert.deepEqual(f.fills.map((x) => `${x.side} ${x.securityId} ${x.status}`), ["SELL a FILLED", "SELL b FILLED"]);
  near(f.fills[0]!.fillPrice!, 90 * 0.999);
  assert.deepEqual(f.positionsAfter, []);
  assert.equal(client.objects.has(paperLedgerKey("intents", "2026-12-09")), false);
  // 12-10: a and b were already sold, so their safety exits will find nothing held; c is bought.
  assert.deepEqual(await ordersFor(client, "2026-12-10"), ["SELL a", "SELL b", "BUY c"]);
  // The day row for the window that opened at 12-09 says why nothing was entered then.
  for (const [id, px] of [["spy", 500], ["a", 90], ["b", 55], ["c", 20]] as const) m.bar(id, "2026-12-10", px, px);
  m.freeze("2026-12-10", "2026-12-11", ["c"]);
  await run(client, m, at("2026-12-11"));
  assert.equal((await read<PaperDay>(client, paperLedgerKey("days", "2026-12-10"))).entriesRefused, "NO_FREEZE_STATUS");
  const f10 = await read<PaperFills>(client, paperLedgerKey("fills", "2026-12-10"));
  assert.deepEqual(f10.fills.map((x) => `${x.side} ${x.securityId} ${x.status}`), ["SELL a NOT_HELD", "SELL b NOT_HELD", "BUY c FILLED"]);
});

test("late scan that lands before the open: exits first, entries added by a later pre-open run", async () => {
  const client = new RecordingClient();
  const m = world();
  await run(client, m, at("2026-12-08"));
  for (const [id, px] of [["spy", 500], ["a", 100], ["b", 50], ["c", 20]] as const) m.bar(id, "2026-12-08", px, px);
  await run(client, m, at("2026-12-09")); // 11:15 UTC: no status yet, exits only
  m.freeze("2026-12-08", "2026-12-09", ["b", "c"]); // frozen at 06:00 UTC proof, stored before the 12:15 run
  const r = await run(client, m, new Date("2026-12-09T12:15:00.000Z"));
  assert.deepEqual(r.intents, { sessionDate: "2026-12-09", outcome: "WRITTEN", entries: 2, exits: 0 });
  assert.deepEqual(await ordersFor(client, "2026-12-09"), ["SELL a", "SELL b", "BUY b", "BUY c"]);
  for (const [id, px] of [["spy", 500], ["a", 100], ["b", 50], ["c", 20]] as const) m.bar(id, "2026-12-09", px, px);
  m.freeze("2026-12-09", "2026-12-10", ["c"]);
  await run(client, m, at("2026-12-10"));
  const f = await read<PaperFills>(client, paperLedgerKey("fills", "2026-12-09"));
  assert.deepEqual(f.fills.map((x) => `${x.side} ${x.securityId} ${x.status}`), ["SELL a FILLED", "SELL b FILLED", "BUY b FILLED", "BUY c FILLED"]);
});

const bars = (m: FakeMarket, date: string, prices: Record<string, number | [number, number]>) => {
  for (const [id, px] of Object.entries(prices)) m.bar(id, date, ...(Array.isArray(px) ? px : ([px, px] as [number, number])));
};

test("rules come from the loaded config: non-default capital, cap, slippage and loss limit all change the ledger", async () => {
  const base = loadPaperRules();
  const loaded: LoadedPaperRules = {
    rulesSha256: "f".repeat(64),
    rules: { ...base.rules, rulesVersion: "paper-rules-v9", startingCapitalUsd: 50000, maxPositionFractionOfEquity: 0.05, slippageBpsPerSide: 50, dailyLossLimitFraction: 0.5, commissionPerOrderUsd: 2 },
  };
  const client = new RecordingClient();
  const m = world();
  await run(client, m, at("2026-12-08"), ON, false, loaded);
  day2(m, 20); // a -80% by the close: about -4% on the book (5% cap), over 3% but under this config's 50%
  const r = await run(client, m, at("2026-12-09"), ON, false, loaded);
  assert.equal(r.intents!.entries, 2);
  const f = await read<PaperFills>(client, paperLedgerKey("fills", "2026-12-08"));
  assert.equal(f.cashBefore, 50000);
  near(f.fills[0]!.fillPrice!, 100 * 1.005, "50 bps");
  // 5% of 50,000 = 2,500 per name, less the $2 commission, at 100.5 -> 24 shares.
  assert.deepEqual(f.fills.map((x) => [x.securityId, x.qty, x.commissionUsd]), [["a", Math.floor(2498 / 100.5), 2], ["b", Math.floor(2498 / 50.25), 2]]);
  assert.equal(f.rulesVersion, "paper-rules-v9");
  assert.equal(f.rulesSha256, "f".repeat(64));
  const i = await read<PaperIntents>(client, paperLedgerKey("intents", "2026-12-09"));
  assert.ok(i.orders.every((o) => o.clientOrderId.startsWith("paper-rules-v9_")));
});

test("daily loss limit is measured from that day's open equity, not from the starting capital", async () => {
  // Up a lot, then down 3%+ in a day: still above the starting capital, but the stop must fire.
  const up = new RecordingClient();
  const m = world();
  await run(up, m, at("2026-12-08"));
  bars(m, "2026-12-08", { spy: 500, a: 100, b: 50, c: 20 });
  m.freeze("2026-12-08", "2026-12-09", ["b", "c"]);
  await run(up, m, at("2026-12-09"));
  bars(m, "2026-12-09", { spy: 500, a: 1000, b: [50, 30], c: [20, 12] }); // a x10 at the open; b, c -40% by the close
  m.freeze("2026-12-09", "2026-12-10", ["c"]);
  const r = await run(up, m, at("2026-12-10"));
  const f9 = await read<PaperFills>(up, paperLedgerKey("fills", "2026-12-09"));
  assert.ok(f9.equityAtOpen > 150000, `equity at the open ${f9.equityAtOpen}`);
  let mark = f9.cashAfter;
  for (const p of f9.positionsAfter) mark += p.qty * (p.securityId === "b" ? 30 : 12);
  assert.ok(mark > 100000 && mark / f9.equityAtOpen - 1 <= -0.03, `mark ${mark}`);
  assert.equal(r.intents!.entriesRefused, "DAILY_LOSS_LIMIT");

  // Down a lot on an earlier day, then flat: below the starting capital, but no loss today.
  const down = new RecordingClient();
  const m2 = world();
  await run(down, m2, at("2026-12-08"));
  bars(m2, "2026-12-08", { spy: 500, a: 100, b: 50, c: 20 });
  m2.freeze("2026-12-08", "2026-12-09", ["b", "c"]);
  await run(down, m2, at("2026-12-09"));
  bars(m2, "2026-12-09", { spy: 500, a: 1, b: 50, c: 20 }); // a -99% at the open; flat after
  m2.freeze("2026-12-09", "2026-12-10", ["c"]);
  const r2 = await run(down, m2, at("2026-12-10"));
  const g9 = await read<PaperFills>(down, paperLedgerKey("fills", "2026-12-09"));
  assert.ok(g9.equityAtOpen < 97000, `equity at the open ${g9.equityAtOpen}`);
  assert.equal(r2.intents!.entriesRefused, undefined);
  assert.equal(r2.intents!.entries, 1);
});

test("universe benchmark: only ACTIVE LEVEL_2/LEVEL_3 names count", async () => {
  const client = new RecordingClient();
  const m = world();
  m.security("gone", { status: "INACTIVE" });
  m.security("small", { eligibility: "LEVEL_1" });
  for (const id of ["gone", "small"]) {
    m.bar(id, "2026-12-08", 10, 10);
    m.bar(id, "2026-12-09", 30, 30); // +200%: would move the average a lot
  }
  await run(client, m, at("2026-12-08"));
  day2(m);
  await run(client, m, at("2026-12-09"));
  day3(m);
  await run(client, m, at("2026-12-10"));
  const d = await read<PaperDay>(client, paperLedgerKey("days", "2026-12-09"));
  assert.equal(d.universeSize, 4);
  near(d.universeReturn!, (0.1 - 0.02 + 0 + 0.02) / 4, "universe without INACTIVE / LEVEL_1");
});
