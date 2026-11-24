// $0-then-correct (Peace, via Auditor, 2026-11-24): after N straight sessions with no price a held
// name is valued at $0 and kept as a STUCK holding; a later real price, buyout cash or bankruptcy
// payout appends a correction for the actual amount. Fills and earlier entries are never rewritten.
import assert from "node:assert/strict";
import test from "node:test";
import { FakeMarket, RecordingClient } from "./paper-fakes.test-helper";
import { paperLedgerKey, PaperLedgerStore, PAPER_CORRECTIONS_PREFIX, type PaperDay, type PaperExits, type PaperFills, type PaperIntents, type PaperStuckResolution } from "./paper-ledger";
import { loadPaperRules, type LoadedPaperRules } from "./paper-rules";
import { computeFills, PaperBars, runPaperTrading, sellFillPrice } from "./paper-trading";

const ON = { PAPER_TRADING_ENABLED: "true" };
const near = (actual: number, expected: number, what = "") => assert.ok(Math.abs(actual - expected) < 1e-6, `${what} ${actual} != ${expected}`);
const at = (date: string) => new Date(`${date}T11:15:00.000Z`); // 06:15 ET, before the open
const SESSIONS = ["2026-12-08", "2026-12-09", "2026-12-10", "2026-12-11", "2026-12-14", "2026-12-15", "2026-12-16", "2026-12-17", "2026-12-18", "2026-12-21", "2026-12-22"];

test("rules v3 state the $0-then-correct rule and N = 5 (one config value)", () => {
  const { rules } = loadPaperRules();
  assert.equal(rules.rulesVersion, "paper-rules-v3");
  assert.equal(rules.stuckPositionRule, "MARK_ZERO_THEN_CORRECT");
  assert.equal(rules.markZeroAfterMissedExits, 5);
});

// ---- pure: computeFills
const loaded = loadPaperRules();
const position = (missedExits?: number, extra: object = {}) => ({ securityId: "a", qty: 100, entryOpen: 100, entryFillPrice: 100.1, entrySessionDate: "2026-12-01", ...(missedExits === undefined ? {} : { missedExits }), ...extra });
const order = (id: string, side: "BUY" | "SELL") => ({ rulesVersion: "v", rulesSha256: "x", clientOrderId: `${side}-${id}`, sessionDate: "2026-12-09", securityId: id, side, purpose: side === "BUY" ? ("ENTRY" as const) : ("EXIT" as const) });
const intents = (orders: ReturnType<typeof order>[]): PaperIntents => ({ schemaVersion: "paper-intents-v1", rulesVersion: "v", rulesSha256: "x", sessionDate: "2026-12-09", freezeSessionDate: "2026-12-08", recordedAt: "", sessionOpen: "", orders });
const bars = new PaperBars([
  { securityId: "a", sessionDate: "2026-12-02", open: 100, close: 90, revision: 1 },
  ...["x", "y", "z"].map((id) => ({ securityId: id, sessionDate: "2026-12-09", open: 10, close: 10, revision: 1 })),
] as never);

test("marks $0 at the 5th straight miss, not at the 4th; kept as a STUCK holding, nothing sold", () => {
  const fills = (missed: number | undefined, rules: LoadedPaperRules = loaded) => computeFills({ intents: intents([order("a", "SELL")]), prior: { cash: 1000, positions: [position(missed)] }, bars, splits: new Map(), loaded: rules });
  const fourth = fills(3);
  assert.equal(fourth.fills[0]!.status, "NO_PRICE");
  assert.equal(fourth.positionsAfter[0]!.missedExits, 4);
  assert.equal(fourth.positionsAfter[0]!.stuckSince, undefined);
  near(fourth.equityAtOpen, 1000 + 100 * 90, "4 misses: still marked at the last close");
  const fifth = fills(4);
  assert.equal(fifth.fills[0]!.status, "MARKED_ZERO");
  assert.deepEqual(fifth.fills[0]!.flags, ["STUCK_AT_ZERO"]);
  assert.deepEqual([fifth.fills[0]!.qty, fifth.fills[0]!.fillPrice, fifth.fills[0]!.notionalUsd, fifth.fills[0]!.slippageUsd, fifth.fills[0]!.commissionUsd], [100, 0, 0, 0, 0]);
  assert.deepEqual(fifth.positionsAfter, [position(5, { stuckSince: "2026-12-09" })], "kept, not closed");
  near(fifth.cashAfter, 1000, "no cash for a $0 mark");
  near(fifth.equityAtOpen, 1000, "valued at $0");
  // N comes from the rules, not a constant.
  const n2: LoadedPaperRules = { ...loaded, rules: { ...loaded.rules, markZeroAfterMissedExits: 2 } };
  assert.equal(fills(1, n2).fills[0]!.status, "MARKED_ZERO");
  assert.equal(fills(0, n2).fills[0]!.status, "NO_PRICE");
  // A SELL for a name already stuck changes nothing (still $0, still held).
  const again = computeFills({ intents: intents([order("a", "SELL")]), prior: { cash: 1000, positions: [position(5, { stuckSince: "2026-12-08" })] }, bars, splits: new Map(), loaded });
  assert.equal(again.fills[0]!.status, "STUCK");
  assert.deepEqual(again.positionsAfter, [position(5, { stuckSince: "2026-12-08" })]);
  near(again.equityAtOpen, 1000);
});

test("a stuck name is not counted against the 10% cap: sizing uses equity with it at $0, and it is never bought again", () => {
  const stuck = { securityId: "s", qty: 1000, entryOpen: 10, entryFillPrice: 10.01, entrySessionDate: "2026-12-01", missedExits: 5, stuckSince: "2026-12-07" };
  const lastClose = new PaperBars([{ securityId: "s", sessionDate: "2026-12-02", open: 10, close: 10, revision: 1 }, ...["x", "y"].map((id) => ({ securityId: id, sessionDate: "2026-12-09", open: 10, close: 10, revision: 1 }))] as never);
  const f = computeFills({ intents: intents([order("x", "BUY"), order("y", "BUY"), order("s", "BUY")]), prior: { cash: 90_000, positions: [stuck] }, bars: lastClose, splits: new Map(), loaded });
  near(f.equityAtOpen, 90_000, "stuck at $0, not at its $10,000 last close");
  const x = f.fills.find((fill) => fill.securityId === "x")!;
  assert.ok(x.notionalUsd <= 9_000 + 1e-9 && x.notionalUsd > 8_980, `10% of 90,000, got ${x.notionalUsd}`);
  assert.equal(f.fills.find((fill) => fill.securityId === "s")!.status, "ALREADY_HELD");
  assert.equal(f.positionsAfter.find((p) => p.securityId === "s")!.qty, 1000);
});

// ---- end to end (no slippage, so the $0 mark-down is exact)
const e2e: LoadedPaperRules = { ...loaded, rules: { ...loaded.rules, slippageBpsPerSide: 0 } };
function world(): FakeMarket {
  const m = new FakeMarket();
  m.security("spy", { symbol: "SPY", assetType: "ETF", eligibility: "LEVEL_3" });
  for (const id of ["a", "b", "c"]) m.security(id);
  for (const [id, px] of [["spy", 500], ["a", 100], ["b", 50], ["c", 20]] as const) m.bar(id, "2026-12-07", px, px);
  m.freeze("2026-12-07", "2026-12-08", ["a"]);
  return m;
}
/** Bars for session S (a only when `aOpen` is given) and a freeze picking b; then the next morning's run. */
async function step(client: RecordingClient, m: FakeMarket, S: string, aOpen?: number, bClose = 50) {
  for (const [id, px] of [["spy", 500], ["c", 20]] as const) m.bar(id, S, px, px);
  m.bar("b", S, 50, bClose);
  if (aOpen !== undefined) m.bar("a", S, aOpen, aOpen);
  const next = SESSIONS[SESSIONS.indexOf(S) + 1]!;
  m.freeze(S, next, ["b"]);
  return runPaperTrading({ ledger: new PaperLedgerStore(client), market: m, loaded: e2e, now: at(next), env: ON, killFileExists: false });
}
const read = async <T>(client: RecordingClient, key: string) => (await new PaperLedgerStore(client).read<T>(key))!;
const fillOf = async (client: RecordingClient, S: string, id = "a") => (await read<PaperFills>(client, paperLedgerKey("fills", S))).fills.find((f) => f.securityId === id && f.side === "SELL");
const corrections = (client: RecordingClient) => [...client.objects.keys()].filter((k) => k.startsWith(PAPER_CORRECTIONS_PREFIX)).sort();

/** a is bought at the 12-08 open, then has no price: misses on 12-09, 10, 11, 14 and 15 (the 5th). */
async function stuckWorld() {
  const client = new RecordingClient();
  const m = world();
  await runPaperTrading({ ledger: new PaperLedgerStore(client), market: m, loaded: e2e, now: at("2026-12-08"), env: ON, killFileExists: false });
  await step(client, m, "2026-12-08", 100);
  for (const S of SESSIONS.slice(1, 6)) await step(client, m, S);
  return { client, m };
}

test("end to end: $0 at the 5th straight session with no price; the loss is booked once; no correction without data", async () => {
  const { client, m } = await stuckWorld();
  assert.equal((await fillOf(client, "2026-12-14"))!.status, "NO_PRICE");
  assert.equal((await fillOf(client, "2026-12-15"))!.status, "MARKED_ZERO");
  const f15 = await read<PaperFills>(client, paperLedgerKey("fills", "2026-12-15"));
  const stuck = f15.positionsAfter.find((p) => p.securityId === "a")!;
  assert.equal(stuck.stuckSince, "2026-12-15");
  const d14 = await read<PaperDay>(client, paperLedgerKey("days", "2026-12-14"));
  const d15 = await read<PaperDay>(client, paperLedgerKey("days", "2026-12-15"));
  near(d15.equityFrom - d15.equityTo, stuck.qty * 100, "the whole last-close value is lost in the 12-15 window, once");
  near(d14.paperReturn, 0, "flat before");
  // Keep going with no data for a: no correction, still STUCK, no more SELL orders for it.
  for (const S of SESSIONS.slice(6, 9)) await step(client, m, S);
  assert.deepEqual(corrections(client), []);
  const f18 = await read<PaperFills>(client, paperLedgerKey("fills", "2026-12-18"));
  assert.equal(f18.positionsAfter.find((p) => p.securityId === "a")!.stuckSince, "2026-12-15");
  const exits = await read<PaperExits>(client, paperLedgerKey("exits", "2026-12-21"));
  assert.ok(!exits.orders.some((o) => o.securityId === "a"), "no SELL orders for a stuck name");
  const d16 = await read<PaperDay>(client, paperLedgerKey("days", "2026-12-16"));
  const d17 = await read<PaperDay>(client, paperLedgerKey("days", "2026-12-17"));
  near(d16.paperReturn, 0, "stuck at $0 stays $0: no second loss");
  near(d17.paperReturn, 0);
});

test("daily 3% stop: the $0 mark is not counted again the next day (entries continue when the rest is flat)", async () => {
  const { client, m } = await stuckWorld();
  const r = await step(client, m, "2026-12-16");
  assert.equal(r.intents!.entriesRefused, undefined);
  assert.equal(r.intents!.entries, 1);
  const i16 = await read<PaperIntents>(client, paperLedgerKey("intents", "2026-12-16"));
  assert.equal(i16.entriesRefused, undefined, "the 12-15 mark-down happened at that open; the 12-15 close mark agrees");

  // A real 3% loss on a later day is still caught: the STUCK holding counts $0 in the close mark too,
  // so its old value cannot hide the loss.
  const second = await stuckWorld();
  await step(second.client, second.m, "2026-12-16");
  const f16 = await read<PaperFills>(second.client, paperLedgerKey("fills", "2026-12-16"));
  const bQty = f16.positionsAfter.find((p) => p.securityId === "b")!.qty;
  assert.ok(bQty * 20 / f16.equityAtOpen >= 0.03, "b -40% is a 3%+ loss of the book");
  const refused = await step(second.client, second.m, "2026-12-17", undefined, 30); // b closes at 30 on D
  assert.equal(refused.intents!.entriesRefused, "DAILY_LOSS_LIMIT");
});

test("a later real price appends a correction for the actual amount; the fill is never rewritten; applied once", async () => {
  const { client, m } = await stuckWorld();
  const before = Buffer.from(client.objects.get(paperLedgerKey("fills", "2026-12-15"))!).toString("base64");
  const qty = (await read<PaperFills>(client, paperLedgerKey("fills", "2026-12-15"))).positionsAfter.find((p) => p.securityId === "a")!.qty;
  await step(client, m, "2026-12-16");
  await step(client, m, "2026-12-17", 40); // a trades again at 40
  const keys = corrections(client);
  assert.deepEqual(keys, ["paper/v1/corrections/2026-12-15/a_1.json"]);
  const c = await read<PaperStuckResolution>(client, keys[0]!);
  assert.equal(c.schemaVersion, "paper-stuck-resolution-v1");
  assert.deepEqual([c.source, c.sourceSessionDate, c.qty], ["PRICE", "2026-12-17", qty]);
  near(c.perShareUsd, sellFillPrice(40, e2e.rules.slippageBpsPerSide));
  near(c.cashAdjustmentUsd, qty * sellFillPrice(40, e2e.rules.slippageBpsPerSide));
  assert.equal(Buffer.from(client.objects.get(paperLedgerKey("fills", "2026-12-15"))!).toString("base64"), before, "fill byte-identical");
  const f17 = await read<PaperFills>(client, paperLedgerKey("fills", "2026-12-17"));
  near(f17.correctionsUsd!, c.cashAdjustmentUsd);
  assert.ok(!f17.positionsAfter.some((p) => p.securityId === "a"), "resolved: no longer held");
  assert.equal(f17.fills.find((f) => f.securityId === "a")!.status, "STUCK_RESOLVED");
  await step(client, m, "2026-12-18", 41);
  assert.deepEqual(corrections(client), keys, "never corrected twice");
  const f18 = await read<PaperFills>(client, paperLedgerKey("fills", "2026-12-18"));
  near(f18.correctionsUsd ?? 0, 0, "cash picked it up once");
});

test("buyout cash or a bankruptcy payout in the data also appends a correction (cash per share, no slippage)", async () => {
  for (const [type, cash] of [["MERGER", 42], ["CLOSURE", 0.35]] as const) {
    const { client, m } = await stuckWorld();
    m.settle("a", "2026-12-16", type, cash);
    await step(client, m, "2026-12-16");
    const keys = corrections(client);
    assert.deepEqual(keys, ["paper/v1/corrections/2026-12-15/a_1.json"], type);
    const c = await read<PaperStuckResolution>(client, keys[0]!);
    assert.deepEqual([c.source, c.actionType, c.perShareUsd], ["CASH_SETTLEMENT", type, cash]);
    near(c.cashAdjustmentUsd, c.qty * cash);
  }
});

test("the universe benchmark uses the same rule: a name with no price for 5 straight sessions counts once at -100%", async () => {
  const { client } = await stuckWorld();
  const day = (S: string) => read<PaperDay>(client, paperLedgerKey("days", S));
  const d14 = await day("2026-12-14");
  const d15 = await day("2026-12-15");
  assert.equal(d14.universeSize, 3, "4th miss: left out, as before");
  assert.equal(d15.universeSize, 4, "5th miss: counted");
  near(d15.universeReturn!, -1 / 4, "a at -100%, spy/b/c flat");
});
