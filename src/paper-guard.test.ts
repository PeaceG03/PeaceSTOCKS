// Reverse-split guard (rules v5): a recovery price above recoveryGuardMultiple x the last close before
// the $0 mark, with no stored split or corporate-action record for the name in between, is not booked.
// The name stays STUCK, flagged RECOVERY_NEEDS_REVIEW, until a record or a sane price arrives; paper and
// the universe use the same check (stuckResolutionCheck).
import assert from "node:assert/strict";
import test from "node:test";
import type { CorporateAction } from "./contracts";
import { FakeMarket, RecordingClient } from "./paper-fakes.test-helper";
import { paperLedgerKey, PaperLedgerStore, type PaperDay, type PaperFills, type PaperStuckResolution } from "./paper-ledger";
import { loadPaperRules, type LoadedPaperRules } from "./paper-rules";
import { computeDay, computeFills, PaperBars, runPaperTrading, stuckResolutionCheck, stuckResolutionFor } from "./paper-trading";
import type { SplitEvent } from "./split-adjust";

const ON = { PAPER_TRADING_ENABLED: "true" };
const near = (actual: number, expected: number, what = "") => assert.ok(Math.abs(actual - expected) < 1e-9, `${what} ${actual} != ${expected}`);
const at = (date: string) => new Date(`${date}T11:15:00.000Z`);
const loaded = loadPaperRules();
const e2e: LoadedPaperRules = { ...loaded, rules: { ...loaded.rules, slippageBpsPerSide: 0 } };
const SESSIONS = ["2026-12-08", "2026-12-09", "2026-12-10", "2026-12-11", "2026-12-14", "2026-12-15", "2026-12-16", "2026-12-17", "2026-12-18", "2026-12-21", "2026-12-22"];
const FILLER = Array.from({ length: 8 }, (_, i) => `f${i}`);

test("v5 rules: the recovery guard is one value, 3x the last close", () => {
  assert.equal(loaded.rules.recoveryGuardMultiple, 3);
});

const position = { securityId: "a", qty: 10, entryOpen: 10, entryFillPrice: 10, entrySessionDate: "2026-12-08", stuckSince: "2026-12-15", stuckBasisSessionDate: "2026-12-08", stuckBasisClose: 10 };
const barsWith = (opens: Record<string, number>) => new PaperBars([{ securityId: "a", sessionDate: "2026-12-08", open: 10, close: 10, revision: 1 }, ...Object.entries(opens).map(([d, o]) => ({ securityId: "a", sessionDate: d, open: o, close: o, revision: 1 }))] as never);
const check = (opens: Record<string, number>, extra: { splits?: SplitEvent[]; settlements?: CorporateAction[]; through?: string } = {}) =>
  stuckResolutionCheck({ position, clientOrderId: "x", n: 1, bars: barsWith(opens), splits: new Map(extra.splits ? [["a", extra.splits]] : []), settlements: extra.settlements ?? [], through: extra.through ?? "2026-12-22", loaded: e2e, now: new Date(0) });
const action = (actionType: string, effectiveDate: string, details: object = {}) => ({ actionId: `${actionType}_${effectiveDate}`, securityId: "a", actionType, effectiveDate, details }) as unknown as CorporateAction;

test("guard: a recovery above 3x the last close with no record is not booked; flagged for review", () => {
  const r = check({ "2026-12-16": 50 });
  assert.equal(r.resolution, undefined);
  assert.deepEqual(r.needsReview, { sourceSessionDate: "2026-12-16", rawAmount: 50, ratio: 5 });
  assert.equal(stuckResolutionFor({ position, clientOrderId: "x", n: 1, bars: barsWith({ "2026-12-16": 50 }), splits: new Map(), settlements: [], through: "2026-12-22", loaded: e2e, now: new Date(0) }), undefined, "the wrapper agrees");
  // Exactly 3x is booked; just above is not.
  assert.equal(check({ "2026-12-16": 30 }).resolution?.perShareUsd, 30);
  assert.equal(check({ "2026-12-16": 30.01 }).resolution, undefined);
  // The guard value comes from the rules.
  const loose = stuckResolutionCheck({ position, clientOrderId: "x", n: 1, bars: barsWith({ "2026-12-16": 50 }), splits: new Map(), settlements: [], through: "2026-12-22", loaded: { ...e2e, rules: { ...e2e.rules, recoveryGuardMultiple: 6 } }, now: new Date(0) });
  assert.equal(loose.resolution?.perShareUsd, 50);
  // Only prices up to `through`.
  assert.deepEqual(check({ "2026-12-16": 50 }, { through: "2026-12-15" }), {});
});

test("guard: a split record (or any stored corporate action) for the name in between lets it book; a later sane price books", () => {
  // 1-for-5 reverse split on record: 50 raw is 10 in pre-split terms, booked.
  const split = check({ "2026-12-16": 50 }, { splits: [{ effectiveDate: "2026-12-16", factor: 5 }] });
  assert.equal(split.resolution?.perShareUsd, 10);
  assert.equal(split.needsReview, undefined);
  // A record whose factor does not explain the jump still lets the price book (a record exists to review).
  assert.equal(check({ "2026-12-16": 50 }, { splits: [{ effectiveDate: "2026-12-10", factor: 1.5 }] }).resolution?.perShareUsd, 50 / 1.5);
  // A split record before the last close does not count.
  assert.equal(check({ "2026-12-16": 50 }, { splits: [{ effectiveDate: "2026-12-08", factor: 1.01 }] }).resolution, undefined);
  // A corporate-action record with no cash amount (not a settlement) counts as a record.
  assert.equal(check({ "2026-12-16": 50 }, { settlements: [action("MERGER", "2026-12-14")] }).resolution?.perShareUsd, 50);
  assert.equal(check({ "2026-12-16": 50 }, { settlements: [{ ...action("MERGER", "2026-12-14"), securityId: "b" }] }).resolution, undefined, "another name's record");
  // A later sane price is booked at its own session; the earlier guarded one stays unbooked.
  const later = check({ "2026-12-16": 50, "2026-12-17": 12 });
  assert.deepEqual([later.resolution?.source, later.resolution?.sourceSessionDate, later.resolution?.perShareUsd, later.needsReview], ["PRICE", "2026-12-17", 12, undefined]);
  // A cash settlement after a guarded price still settles it.
  const cash = check({ "2026-12-16": 50 }, { settlements: [action("MERGER", "2026-12-17", { cash_per_share: 9 })] });
  assert.deepEqual([cash.resolution?.source, cash.resolution?.perShareUsd], ["CASH_SETTLEMENT", 9]);
});

function world(): FakeMarket {
  const m = new FakeMarket();
  m.security("spy", { symbol: "SPY", assetType: "ETF", eligibility: "LEVEL_3" });
  for (const id of ["a", "b", "c", ...FILLER]) m.security(id);
  for (const d of ["2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04"]) for (const id of FILLER) m.bar(id, d, 10, 10);
  for (const [id, px] of [["spy", 500], ["a", 100], ["b", 50], ["c", 20], ...FILLER.map((f) => [f, 10] as const)] as const) m.bar(id, "2026-12-07", px, px);
  m.freeze("2026-12-07", "2026-12-08", ["a"]);
  return m;
}
async function step(client: RecordingClient, m: FakeMarket, S: string, aOpen?: number) {
  for (const [id, px] of [["spy", 500], ["b", 50], ["c", 20], ...FILLER.map((f) => [f, 10] as const)] as const) m.bar(id, S, px, px);
  if (aOpen !== undefined) m.bar("a", S, aOpen, aOpen);
  const next = SESSIONS[SESSIONS.indexOf(S) + 1]!;
  m.freeze(S, next, ["b"]);
  return runPaperTrading({ ledger: new PaperLedgerStore(client), market: m, loaded: e2e, now: at(next), env: ON, killFileExists: false });
}
const read = async <T>(client: RecordingClient, key: string) => (await new PaperLedgerStore(client).read<T>(key))!;
const day = (client: RecordingClient, S: string) => read<PaperDay>(client, paperLedgerKey("days", S));
const held = async (client: RecordingClient, S: string) => (await read<PaperFills>(client, paperLedgerKey("fills", S))).positionsAfter.find((p) => p.securityId === "a");
const resolutionKey = "paper/v1/corrections/2026-12-15/a_1.json";

async function stuckAtZero() {
  const client = new RecordingClient();
  const m = world();
  await runPaperTrading({ ledger: new PaperLedgerStore(client), market: m, loaded: e2e, now: at("2026-12-08"), env: ON, killFileExists: false });
  await step(client, m, "2026-12-08", 100);
  for (const S of SESSIONS.slice(1, 6)) await step(client, m, S);
  return { client, m };
}

test("end to end: a 4x recovery with no record stays STUCK for paper and the universe, flagged; a split record then books both alike", async () => {
  const { client, m } = await stuckAtZero();
  const p15 = (await held(client, "2026-12-15"))!;
  assert.deepEqual([p15.stuckSince, p15.stuckBasisSessionDate, p15.stuckBasisClose], ["2026-12-15", "2026-12-08", 100], "the basis is fixed at the mark");
  await step(client, m, "2026-12-16", 400);
  assert.equal(client.objects.has(resolutionKey), false, "not booked");
  const review = { sourceSessionDate: "2026-12-16", rawAmount: 400, ratio: 4 };
  assert.deepEqual((await held(client, "2026-12-16"))!.recoveryNeedsReview, review);
  const d16 = await day(client, "2026-12-16");
  assert.deepEqual(d16.universeStuck!.map((s) => [s.securityId, s.recoveryNeedsReview]), [["a", review]]);
  assert.equal(d16.universeResolved, undefined);
  assert.deepEqual([d16.paperRecoveryNeedsReview, d16.universeRecoveryNeedsReview], [1, 1]);
  await step(client, m, "2026-12-17", 410);
  assert.deepEqual((await held(client, "2026-12-17"))!.recoveryNeedsReview, review, "still the first guarded price");
  // The 1-for-4 reverse split record arrives: 400 raw is 100 before the split, booked from 12-16.
  m.split("a", "2026-12-16", 4, 1);
  await step(client, m, "2026-12-18", 420);
  const paper = await read<PaperStuckResolution>(client, resolutionKey);
  assert.deepEqual([paper.source, paper.sourceSessionDate, paper.perShareUsd], ["PRICE", "2026-12-16", 100]);
  const d18 = await day(client, "2026-12-18");
  const u = d18.universeResolved![0]!;
  assert.deepEqual([u.source, u.sourceSessionDate], [paper.source, paper.sourceSessionDate]);
  near(u.perShareUsd, paper.perShareUsd, "same amount");
  near(u.recoveredUnits / u.units, paper.perShareUsd / p15.stuckBasisClose!, "same share of the $0 loss recovered");
  assert.equal(d18.universeRecoveryNeedsReview, undefined);
  assert.equal(await held(client, "2026-12-18"), undefined, "left the book");
});

test("end to end: a sane later price books paper and the universe at that price, the same share", async () => {
  const { client, m } = await stuckAtZero();
  await step(client, m, "2026-12-16", 400);
  await step(client, m, "2026-12-17", 120);
  const paper = await read<PaperStuckResolution>(client, resolutionKey);
  assert.deepEqual([paper.sourceSessionDate, paper.perShareUsd], ["2026-12-17", 120]);
  const u = (await day(client, "2026-12-17")).universeResolved![0]!;
  assert.deepEqual([u.sourceSessionDate, u.perShareUsd], ["2026-12-17", 120]);
  near(u.recoveredUnits / u.units, 1.2);
});

test("guard: the basis is the close the mark took away (kept on the position), not the entry open", () => {
  const marked = { ...position, entryOpen: 10, stuckBasisClose: 20, stuckBasisSessionDate: "2026-12-10" };
  const run = (p: typeof marked) => stuckResolutionCheck({ position: p, clientOrderId: "x", n: 1, bars: barsWith({ "2026-12-16": 50 }), splits: new Map(), settlements: [], through: "2026-12-22", loaded: e2e, now: new Date(0) });
  assert.equal(run(marked).resolution?.perShareUsd, 50, "2.5x the basis close: booked");
  const { stuckBasisClose: _c, stuckBasisSessionDate: _d, ...old } = marked;
  assert.deepEqual(run(old as typeof marked).needsReview, { sourceSessionDate: "2026-12-16", rawAmount: 50, ratio: 5 }, "without a stored basis: the entry open");
  // A split record between the entry and the basis close does not count as a record for the later price.
  assert.equal(stuckResolutionCheck({ position: { ...marked, stuckBasisClose: 10 }, clientOrderId: "x", n: 1, bars: barsWith({ "2026-12-16": 50 }), splits: new Map([["a", [{ effectiveDate: "2026-12-09", factor: 1 }]]]), settlements: [], through: "2026-12-22", loaded: e2e, now: new Date(0) }).resolution, undefined);
});

test("the review flag shows the current check: dropped from a paper position and a universe entry once no price is held back", () => {
  const flagged = { ...position, recoveryNeedsReview: { sourceSessionDate: "2026-12-16", rawAmount: 50, ratio: 5 } };
  const intents = { schemaVersion: "paper-intents-v1", rulesVersion: "v", rulesSha256: "x", sessionDate: "2026-12-17", freezeSessionDate: "", recordedAt: "", sessionOpen: "", orders: [] } as never;
  const plain = computeFills({ intents, prior: { cash: 0, positions: [flagged] }, bars: barsWith({}), splits: new Map(), loaded: e2e });
  assert.equal(plain.positionsAfter[0]!.recoveryNeedsReview, undefined);
  const kept = computeFills({ intents, prior: { cash: 0, positions: [flagged] }, bars: barsWith({}), splits: new Map(), loaded: e2e, recoveryReviews: new Map([["a", flagged.recoveryNeedsReview]]) });
  assert.deepEqual(kept.positionsAfter[0]!.recoveryNeedsReview, flagged.recoveryNeedsReview);
  const notStuck = computeFills({ intents, prior: { cash: 0, positions: [(({ stuckSince: _s, ...p }) => p)(position)] }, bars: barsWith({}), splits: new Map(), loaded: e2e, recoveryReviews: new Map([["a", flagged.recoveryNeedsReview]]) });
  assert.equal(notStuck.positionsAfter[0]!.recoveryNeedsReview, undefined, "only STUCK holdings are flagged");
  const f = (S: string) => ({ schemaVersion: "paper-fills-v1", rulesVersion: "r", rulesSha256: "x", sessionDate: S, cashBefore: 1, cashAfterExits: 1, equityAtOpen: 1, cashAfter: 1, positionsAfter: [], fills: [] }) as unknown as PaperFills;
  const entry = { securityId: "a", stuckSince: "2026-12-15", basisSessionDate: "2026-12-08", basisClose: 10, units: 0.1, recoveryNeedsReview: flagged.recoveryNeedsReview };
  const d = computeDay({ from: f("2026-12-16"), to: f("2026-12-17"), bars: barsWith({}), splits: new Map(), securities: [], loaded: e2e, previousDay: { universeStuck: [entry], cumulativeUniverseReturn: 0 } as unknown as PaperDay });
  const { recoveryNeedsReview: _r, ...unflagged } = entry;
  assert.deepEqual(d.universeStuck, [unflagged]);
  assert.equal(d.universeRecoveryNeedsReview, undefined);
});
