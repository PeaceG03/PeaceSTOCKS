// Coverage holes (Auditor FAIL on #127 at 5234a50d): a session our data barely covers is not a missed
// exit, for paper or the universe; and the universe's $0 marks are corrected by the same later open or
// cash record, through the same function, as paper's.
import assert from "node:assert/strict";
import test from "node:test";
import { FakeMarket, RecordingClient } from "./paper-fakes.test-helper";
import { paperLedgerKey, PaperLedgerStore, type PaperDay, type PaperFills, type PaperIntents, type PaperStuckResolution } from "./paper-ledger";
import { loadPaperRules, type LoadedPaperRules } from "./paper-rules";
import { computeDay, computeFills, COVERAGE_TRAILING_SESSIONS, missedSessions, PaperBars, paperBarsLookbackDays, runPaperTrading, universeStuckAt } from "./paper-trading";
import type { CorporateAction, SecurityMasterRecord } from "./contracts";

const ON = { PAPER_TRADING_ENABLED: "true" };
const near = (actual: number, expected: number, what = "") => assert.ok(Math.abs(actual - expected) < 1e-9, `${what} ${actual} != ${expected}`);
const at = (date: string) => new Date(`${date}T11:15:00.000Z`);
const loaded = loadPaperRules();
const e2e: LoadedPaperRules = { ...loaded, rules: { ...loaded.rules, slippageBpsPerSide: 0 } };
const SESSIONS = ["2026-12-08", "2026-12-09", "2026-12-10", "2026-12-11", "2026-12-14", "2026-12-15", "2026-12-16", "2026-12-17", "2026-12-18", "2026-12-21", "2026-12-22"];
const FILLER = Array.from({ length: 8 }, (_, i) => `f${i}`);

test("the hole threshold is one rules value: fewer than 50% of the median name count of the 20 stored sessions before", () => {
  assert.equal(loaded.rules.coverageHoleFraction, 0.5);
  assert.equal(COVERAGE_TRAILING_SESSIONS, 20);
  const days = Array.from({ length: 25 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`);
  const counts: Record<string, number> = { "2026-11-22": 5, "2026-11-23": 4, "2026-11-24": 10 };
  const bars = new PaperBars(days.flatMap((d) => Array.from({ length: counts[d] ?? 10 }, (_, k) => ({ securityId: `n${k}`, sessionDate: d, open: 1, close: 1, revision: 1 }))) as never);
  assert.equal(bars.covered("2026-11-22", 0.5), true, "5 of 10: exactly 50% is covered");
  assert.equal(bars.covered("2026-11-23", 0.5), false, "4 of 10: a hole");
  assert.equal(bars.covered("2026-11-23", 0.4), true, "the fraction comes from the rules");
  assert.equal(bars.covered("2026-11-26", 0.5), false, "no bars at all: a hole");
  assert.equal(bars.covered("2026-11-01", 0.5), true, "nothing before it: covered when it has bars");
  // Only the 20 sessions before count: 20 low days in a row become the new normal.
  const low = new PaperBars(days.flatMap((d, i) => Array.from({ length: i < 3 ? 100 : 10 }, (_, k) => ({ securityId: `n${k}`, sessionDate: d, open: 1, close: 1, revision: 1 }))) as never);
  assert.equal(low.covered("2026-11-04", 0.5), false);
  assert.equal(low.covered("2026-11-24", 0.5), true);
  // A drop after 15 normal days: the 20-session median still sees the normal days.
  const drop = new PaperBars(days.flatMap((d, i) => Array.from({ length: i < 15 ? 100 : 10 }, (_, k) => ({ securityId: `n${k}`, sessionDate: d, open: 1, close: 1, revision: 1 }))) as never);
  assert.equal(drop.covered("2026-11-24", 0.5), false, "12 of the 20 sessions before were normal");
  // The median, not the top of the range: one big day among 19 small ones does not raise the bar.
  const spiky = new PaperBars(days.flatMap((d, i) => Array.from({ length: i === 24 ? 6 : i === 10 ? 100 : 10 }, (_, k) => ({ securityId: `n${k}`, sessionDate: d, open: 1, close: 1, revision: 1 }))) as never);
  assert.equal(spiky.covered("2026-11-25", 0.5), true, "6 of a median 10");
  // A session with no bars is a hole even when only one session is loaded.
  const single = new PaperBars([{ securityId: "n", sessionDate: "2026-11-02", open: 1, close: 1, revision: 1 }] as never);
  assert.equal(single.covered("2026-11-03", 0.5), false);
  assert.ok(paperBarsLookbackDays(loaded.rules) >= Math.ceil(((5 + 20) * 7) / 5), "bars cover N misses plus the 20 trailing sessions");
});

test("paper: a hole session does not advance the miss count; a covered session with the name absent does", () => {
  const trailing = ["2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04", "2026-12-07", "2026-12-08"];
  const rows = [
    ...trailing.flatMap((d) => FILLER.map((id) => ({ securityId: id, sessionDate: d, open: 1, close: 1, revision: 1 }))),
    { securityId: "a", sessionDate: "2026-12-01", open: 100, close: 90, revision: 1 },
  ];
  const holeBars = new PaperBars([...rows, ...FILLER.slice(0, 3).map((id) => ({ securityId: id, sessionDate: "2026-12-09", open: 1, close: 1, revision: 1 }))] as never);
  const coveredBars = new PaperBars([...rows, ...FILLER.slice(0, 7).map((id) => ({ securityId: id, sessionDate: "2026-12-09", open: 1, close: 1, revision: 1 }))] as never);
  const intents: PaperIntents = { schemaVersion: "paper-intents-v1", rulesVersion: "v", rulesSha256: "x", sessionDate: "2026-12-09", freezeSessionDate: "2026-12-08", recordedAt: "", sessionOpen: "", orders: [{ rulesVersion: "v", rulesSha256: "x", clientOrderId: "s", sessionDate: "2026-12-09", securityId: "a", side: "SELL", purpose: "EXIT" }] };
  const position = { securityId: "a", qty: 100, entryOpen: 100, entryFillPrice: 100.1, entrySessionDate: "2026-12-01", missedExits: 4 };
  const hole = computeFills({ intents, prior: { cash: 0, positions: [position] }, bars: holeBars, splits: new Map(), loaded });
  assert.deepEqual([hole.fills[0]!.status, hole.fills[0]!.flags], ["NO_PRICE", ["COVERAGE_HOLE"]]);
  assert.deepEqual(hole.positionsAfter, [position], "miss count unchanged, not stuck");
  near(hole.equityAtOpen, 100 * 90, "still marked at the last close");
  const covered = computeFills({ intents, prior: { cash: 0, positions: [position] }, bars: coveredBars, splits: new Map(), loaded });
  assert.equal(covered.fills[0]!.status, "MARKED_ZERO", "7 of 8 names: covered, so the 5th miss counts");
  const lowFraction: LoadedPaperRules = { ...loaded, rules: { ...loaded.rules, coverageHoleFraction: 0.3 } };
  assert.equal(computeFills({ intents, prior: { cash: 0, positions: [position] }, bars: holeBars, splits: new Map(), loaded: lowFraction }).fills[0]!.status, "MARKED_ZERO", "3 of 8 is covered at 0.3: the fraction comes from the rules");
  // The universe's walk counts the same way: the hole session adds nothing (5 covered days before it).
  assert.deepEqual(missedSessions(holeBars, "a", "2026-12-09", { coverageHoleFraction: 0.5, dropoutSpikeMultiple: 3, dropoutSpikeMinNames: 200, dropoutFallbackSessions: 40 }), { misses: 5, lastOpen: "2026-12-01" });
  assert.deepEqual(missedSessions(coveredBars, "a", "2026-12-09", { coverageHoleFraction: 0.5, dropoutSpikeMultiple: 3, dropoutSpikeMinNames: 200, dropoutFallbackSessions: 40 }), { misses: 6, lastOpen: "2026-12-01" });
});

// ---- end to end: a bought at 12-08, then no price; filler names make a hole visible.
function world(): FakeMarket {
  const m = new FakeMarket();
  m.security("spy", { symbol: "SPY", assetType: "ETF", eligibility: "LEVEL_3" });
  for (const id of ["a", "b", "c", ...FILLER]) m.security(id);
  for (const d of ["2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04"]) for (const id of FILLER) m.bar(id, d, 10, 10);
  for (const [id, px] of [["spy", 500], ["a", 100], ["b", 50], ["c", 20], ...FILLER.map((f) => [f, 10] as const)] as const) m.bar(id, "2026-12-07", px, px);
  m.freeze("2026-12-07", "2026-12-08", ["a"]);
  return m;
}
async function step(client: RecordingClient, m: FakeMarket, S: string, opts: { aOpen?: number; hole?: boolean } = {}) {
  if (opts.hole) m.bar("spy", S, 500, 500); // one name of twelve: a coverage hole
  else {
    for (const [id, px] of [["spy", 500], ["b", 50], ["c", 20], ...FILLER.map((f) => [f, 10] as const)] as const) m.bar(id, S, px, px);
    if (opts.aOpen !== undefined) m.bar("a", S, opts.aOpen, opts.aOpen);
  }
  const next = SESSIONS[SESSIONS.indexOf(S) + 1]!;
  m.freeze(S, next, ["b"]);
  return runPaperTrading({ ledger: new PaperLedgerStore(client), market: m, loaded: e2e, now: at(next), env: ON, killFileExists: false });
}
const read = async <T>(client: RecordingClient, key: string) => (await new PaperLedgerStore(client).read<T>(key))!;
const day = (client: RecordingClient, S: string) => read<PaperDay>(client, paperLedgerKey("days", S));
const aFill = async (client: RecordingClient, S: string) => (await read<PaperFills>(client, paperLedgerKey("fills", S))).fills.find((f) => f.securityId === "a" && f.side === "SELL");

async function start(holeAt?: string) {
  const client = new RecordingClient();
  const m = world();
  await runPaperTrading({ ledger: new PaperLedgerStore(client), market: m, loaded: e2e, now: at("2026-12-08"), env: ON, killFileExists: false });
  await step(client, m, "2026-12-08", { aOpen: 100 });
  for (const S of SESSIONS.slice(1, 6)) await step(client, m, S, { hole: S === holeAt });
  return { client, m };
}

test("end to end: a hole inside the 5 sessions delays the $0 mark by one covered session, for paper and the universe alike", async () => {
  const { client, m } = await start("2026-12-11");
  const hole = await aFill(client, "2026-12-11");
  assert.deepEqual([hole!.status, hole!.flags], ["NO_PRICE", ["COVERAGE_HOLE"]]);
  assert.equal((await aFill(client, "2026-12-15"))!.status, "NO_PRICE", "only 4 covered misses so far");
  assert.equal((await day(client, "2026-12-15")).universeStuck, undefined, "the universe agrees");
  await step(client, m, "2026-12-16");
  assert.equal((await aFill(client, "2026-12-16"))!.status, "MARKED_ZERO");
  const d16 = await day(client, "2026-12-16");
  assert.deepEqual(d16.universeStuck!.map((s) => [s.securityId, s.stuckSince]), [["a", "2026-12-16"]]);
  const f16 = await read<PaperFills>(client, paperLedgerKey("fills", "2026-12-16"));
  assert.equal(f16.positionsAfter.find((p) => p.securityId === "a")!.stuckSince, d16.universeStuck![0]!.stuckSince, "same session as paper");
});

test("the universe correction matches paper's: same source, same per-share amount, same share of the $0 loss recovered", async () => {
  const { client, m } = await start();
  const d15 = await day(client, "2026-12-15");
  assert.equal(d15.universeSize, 12);
  near(d15.universeReturn!, -1 / 12, "a at -100%, the rest flat");
  const stuck = d15.universeStuck![0]!;
  assert.deepEqual([stuck.securityId, stuck.stuckSince, stuck.basisSessionDate, stuck.basisClose], ["a", "2026-12-15", "2026-12-08", 100]);
  near(stuck.units, 1 / 12, "index level 1 at the window's open / 12 names");
  await step(client, m, "2026-12-16");
  assert.deepEqual((await day(client, "2026-12-16")).universeStuck!.map((s) => s.securityId), ["a"], "carried while no data");
  await step(client, m, "2026-12-17", { aOpen: 40 });
  const paper = await read<PaperStuckResolution>(client, "paper/v1/corrections/2026-12-15/a_1.json");
  const d17 = await day(client, "2026-12-17");
  const u = d17.universeResolved![0]!;
  assert.deepEqual([u.securityId, u.source, u.sourceSessionDate, u.stuckSince], ["a", paper.source, paper.sourceSessionDate, "2026-12-15"]);
  near(u.perShareUsd, paper.perShareUsd, "same per-share amount (no costs here, so equal)");
  const f15 = await read<PaperFills>(client, paperLedgerKey("fills", "2026-12-15"));
  const paperLoss = (await read<PaperFills>(client, paperLedgerKey("fills", "2026-12-14"))).equityAtOpen - f15.equityAtOpen;
  near(u.recoveredUnits / u.units, paper.cashAdjustmentUsd / paperLoss, "same share of the loss recovered");
  near(d17.universeCorrectionReturn!, u.recoveredUnits / (1 + (await day(client, "2026-12-16")).cumulativeUniverseReturn));
  near(d17.universeReturn!, d17.universeCorrectionReturn!, "the rest flat");
  assert.equal(d17.universeStuck, undefined, "resolved: no longer carried");
  await step(client, m, "2026-12-18", { aOpen: 41 });
  const d18 = await day(client, "2026-12-18");
  assert.equal(d18.universeResolved, undefined, "applied once");
  assert.equal(d18.universeSize, 12, "a is back in the universe");
});

test("a cash settlement corrects the universe too, like paper", async () => {
  const { client, m } = await start();
  m.settle("a", "2026-12-16", "MERGER", 42);
  await step(client, m, "2026-12-16");
  const paper = await read<PaperStuckResolution>(client, "paper/v1/corrections/2026-12-15/a_1.json");
  const u = (await day(client, "2026-12-16")).universeResolved![0]!;
  assert.deepEqual([u.source, u.actionId, u.perShareUsd], ["CASH_SETTLEMENT", paper.actionId, paper.perShareUsd]);
  near(u.recoveredUnits, u.units * 42 / 100);
});

test("universe: a hole session right after the $0 mark does not mark it again", () => {
  const rules = { markZeroAfterMissedExits: 5, coverageHoleFraction: 0.5, dropoutSpikeMultiple: 3, dropoutSpikeMinNames: 200, dropoutFallbackSessions: 40 };
  const dates = ["2026-12-08", "2026-12-09", "2026-12-10", "2026-12-11", "2026-12-14", "2026-12-15", "2026-12-16"];
  const bars = new PaperBars(dates.flatMap((d) => [
    ...(d === "2026-12-16" ? FILLER.slice(0, 2) : FILLER).map((id) => ({ securityId: id, sessionDate: d, open: 1, close: 1, revision: 1 })),
    ...(d === "2026-12-08" ? [{ securityId: "a", sessionDate: d, open: 1, close: 1, revision: 1 }] : []),
  ]) as never);
  assert.equal(universeStuckAt(bars, "a", "2026-12-15", rules), true);
  assert.equal(universeStuckAt(bars, "a", "2026-12-16", rules), false, "12-16 is a hole");
  // Five covered misses but no open anywhere in the loaded bars: unknown, never marked.
  const never = new PaperBars(dates.slice(1, 6).flatMap((d) => FILLER.map((id) => ({ securityId: id, sessionDate: d, open: 1, close: 1, revision: 1 }))) as never);
  assert.deepEqual(missedSessions(never, "a", "2026-12-15", { coverageHoleFraction: 0.5, dropoutSpikeMultiple: 3, dropoutSpikeMinNames: 200, dropoutFallbackSessions: 40 }), { misses: 5 });
  assert.equal(universeStuckAt(never, "a", "2026-12-15", rules), false);
});

test("computeDay: the universe slice is the index level / n; its recovery is split-adjusted, cost-free and a return on today's level", () => {
  const ids = ["a", "b", "c", "d"];
  const master = ids.map((securityId) => ({ securityId, status: "ACTIVE", eligibility: "LEVEL_2", currentSymbol: securityId.toUpperCase(), assetType: "STOCK" })) as unknown as SecurityMasterRecord[];
  const bar = (securityId: string, sessionDate: string, open: number) => ({ securityId, sessionDate, open, close: open, revision: 1 });
  const dates = ["2026-12-08", "2026-12-09", "2026-12-10", "2026-12-11", "2026-12-14", "2026-12-15", "2026-12-16", "2026-12-17"];
  const rows = dates.flatMap((d) => ["b", "c", "d"].map((id) => bar(id, d, 10)));
  rows.push(bar("a", "2026-12-08", 80));
  const f = (S: string) => ({ schemaVersion: "paper-fills-v1", rulesVersion: "r", rulesSha256: "x", sessionDate: S, cashBefore: 1, cashAfterExits: 1, equityAtOpen: 1, cashAfter: 1, positionsAfter: [], fills: [] }) as unknown as PaperFills;
  const prevDay = (cum: number, extra: Partial<PaperDay> = {}) => ({ cumulativePaperReturn: 0, cumulativeSpyReturn: 0, cumulativeUniverseReturn: cum, ...extra }) as PaperDay;
  const marked = computeDay({ from: f("2026-12-14"), to: f("2026-12-15"), bars: new PaperBars(rows as never), splits: new Map(), securities: master, loaded, previousDay: prevDay(0.5) });
  near(marked.universeReturn!, -1 / 4);
  assert.deepEqual(marked.universeStuck, [{ securityId: "a", stuckSince: "2026-12-15", basisSessionDate: "2026-12-08", basisClose: 80, units: 1.5 / 4 }]);
  // a trades again on 12-17 at 30 after a 2-for-1 split on 12-16: 60 per old share, no slippage.
  const later = new PaperBars([...rows, bar("a", "2026-12-17", 30)] as never);
  const half = new Map([["a", [{ effectiveDate: "2026-12-16", factor: 0.5 }]]]);
  const carried = prevDay(0.2, { universeStuck: marked.universeStuck });
  const idle = computeDay({ from: f("2026-12-15"), to: f("2026-12-16"), bars: later, splits: half, securities: master, loaded, previousDay: carried });
  assert.deepEqual([idle.universeStuck, idle.universeResolved], [marked.universeStuck, undefined], "nothing yet: carried");
  const fixed = computeDay({ from: f("2026-12-16"), to: f("2026-12-17"), bars: later, splits: half, securities: master, loaded, previousDay: carried });
  const u = fixed.universeResolved![0]!;
  assert.deepEqual([u.source, u.sourceSessionDate, u.perShareUsd, u.basisClose], ["PRICE", "2026-12-17", 60, 80]);
  near(u.recoveredUnits, (1.5 / 4) * 60 / 80);
  near(fixed.universeCorrectionReturn!, u.recoveredUnits / 1.2, "a return on the index level at this window's open");
  near(fixed.universeReturn!, u.recoveredUnits / 1.2, "b, c, d flat; a has no open at 12-16 so it is not in the window");
  assert.equal(fixed.universeStuck, undefined);
  // A cash record on the same data path; with no other names the window is the correction alone.
  const cash = { actionId: "x", securityId: "a", actionType: "CLOSURE", effectiveDate: "2026-12-16", details: { cash_per_share: 8 }, observedAt: "" } as unknown as CorporateAction;
  const onlyA = computeDay({ from: f("2026-12-15"), to: f("2026-12-16"), bars: new PaperBars([bar("a", "2026-12-08", 80), bar("b", "2026-12-15", 10)] as never), splits: new Map(), securities: master.slice(0, 1), loaded, previousDay: carried, settlements: [cash] });
  assert.equal(onlyA.universeSize, 0);
  near(onlyA.universeReturn!, ((1.5 / 4) * 8) / 80 / 1.2);
});
