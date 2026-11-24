// Mass drop-out (rules v5): when far more names than normal vanish from one session to the next, it is a
// gap in our data, not a halt. Those names' missing sessions do not count toward the $0 mark (flag
// DATA_DROPOUT), for paper and the universe through the same code, until a longer fallback window ends.
import assert from "node:assert/strict";
import test from "node:test";
import type { SecurityMasterRecord } from "./contracts";
import type { PaperFills, PaperIntents, PaperPosition } from "./paper-ledger";
import { loadPaperRules, type LoadedPaperRules } from "./paper-rules";
import { computeDay, computeFills, missKind, missedSessions, PaperBars, paperBarsLookbackDays, universeStuckAt } from "./paper-trading";
import { nextEligibleSession } from "./session-open";

const loaded = loadPaperRules();
const small = (patch: Partial<LoadedPaperRules["rules"]> = {}): LoadedPaperRules => ({ ...loaded, rules: { ...loaded.rules, dropoutSpikeMinNames: 5, dropoutFallbackSessions: 3, markZeroAfterMissedExits: 2, ...patch } });
const SESSIONS: string[] = ["2026-10-01"];
while (SESSIONS.length < 36) SESSIONS.push(nextEligibleSession(SESSIONS.at(-1)!)!);
const SPIKE = 25;
const BASE = Array.from({ length: 60 }, (_, i) => `n${i}`);
const DROPPED = ["a", ...BASE.slice(0, 19)];

/** 60 steady names plus "a"; 2 one-day names each session (normal churn: 2 drop-outs a day); at SPIKE,
 * "a" and 19 others vanish until `backAt` (exclusive end of the gap). */
function bars(backAt = 99, extraDrop = 0) {
  const rows: object[] = [];
  SESSIONS.forEach((d, i) => {
    const gone = i >= SPIKE && i < backAt;
    for (const id of [...BASE, "a"]) if (!(gone && DROPPED.includes(id)) && !(i >= SPIKE && i < backAt && BASE.indexOf(id) >= 19 && BASE.indexOf(id) < 19 + extraDrop))
      rows.push({ securityId: id, sessionDate: d, open: id === "a" ? 50 : 10, close: id === "a" ? 50 : 10, revision: 1 });
    for (const k of [0, 1]) rows.push({ securityId: `c${i}_${k}`, sessionDate: d, open: 1, close: 1, revision: 1 });
  });
  return new PaperBars(rows as never);
}

test("v5 rules: the drop-out values from the replay (3x the trailing p99, at least 200 names, 40-session fallback)", () => {
  assert.equal(loaded.rules.rulesVersion, "paper-rules-v5");
  assert.deepEqual([loaded.rules.dropoutSpikeMultiple, loaded.rules.dropoutSpikeMinNames, loaded.rules.dropoutFallbackSessions], [3, 200, 40]);
  const r = loaded.rules;
  assert.ok(paperBarsLookbackDays(r) >= Math.ceil(((r.markZeroAfterMissedExits + r.dropoutFallbackSessions + 20 + 1) * 7) / 5), "bars reach back past the fallback window and its trailing sessions");
});

test("drop-out spike: far more names than the trailing p99 vanish at once, and more than the floor", () => {
  const b = bars();
  const r = small().rules;
  assert.equal(b.dropouts(SESSIONS[SPIKE - 1]!), 2);
  assert.equal(b.dropouts(SESSIONS[SPIKE]!), 22);
  assert.equal(b.dropouts(SESSIONS[0]!), undefined, "no session before");
  assert.equal(b.dropoutSpike(SESSIONS[SPIKE]!, r), true, "22 > max(5, 3 x 2)");
  assert.equal(b.dropoutSpike(SESSIONS[SPIKE - 1]!, r), false, "normal churn");
  assert.equal(b.dropoutSpike(SESSIONS[SPIKE]!, { ...r, dropoutSpikeMinNames: 22 }), false, "not above the floor");
  assert.equal(b.dropoutSpike(SESSIONS[SPIKE]!, { ...r, dropoutSpikeMultiple: 11 }), false, "not above 11 x 2");
  assert.equal(b.dropoutSpike(SESSIONS[SPIKE]!, { ...r, dropoutSpikeMultiple: 10.9 }), true);
  assert.equal(b.covered(SESSIONS[SPIKE]!, r.coverageHoleFraction), true, "not a coverage hole: 43 of 63 names");
});

function walk(b: PaperBars, rules: LoadedPaperRules, from = SPIKE, to = SESSIONS.length - 1) {
  let position: PaperPosition = { securityId: "a", qty: 10, entryOpen: 50, entryFillPrice: 50, entrySessionDate: SESSIONS[SPIKE - 1]! };
  const out: string[] = [];
  for (let i = from; i <= to && !position.stuckSince; i += 1) {
    const S = SESSIONS[i]!;
    const intents: PaperIntents = { schemaVersion: "paper-intents-v1", rulesVersion: "v", rulesSha256: "x", sessionDate: S, freezeSessionDate: "", recordedAt: "", sessionOpen: "", orders: [{ rulesVersion: "v", rulesSha256: "x", clientOrderId: S, sessionDate: S, securityId: "a", side: "SELL", purpose: "EXIT" }] };
    const f = computeFills({ intents, prior: { cash: 0, positions: [position] }, bars: b, splits: new Map(), loaded: rules });
    out.push(`${f.fills[0]!.status}${f.fills[0]!.flags.length ? `:${f.fills[0]!.flags.join(",")}` : ""}`);
    if (!f.positionsAfter.length) break;
    position = f.positionsAfter[0]!;
  }
  return out;
}

test("paper: a drop-out name's missing sessions do not count for the fallback window; then the normal rule ($0 after N)", () => {
  const rules = small();
  assert.deepEqual(walk(bars(), rules), ["NO_PRICE:DATA_DROPOUT", "NO_PRICE:DATA_DROPOUT", "NO_PRICE:DATA_DROPOUT", "NO_PRICE", "MARKED_ZERO:STUCK_AT_ZERO"]);
  assert.equal(missKind(bars(), "a", SESSIONS[SPIKE + 2]!, rules.rules), "DATA_DROPOUT");
  assert.equal(missKind(bars(), "a", SESSIONS[SPIKE + 3]!, rules.rules), "MISS");
  // Without a spike (floor too high) the same gap is an ordinary miss: $0 after N.
  assert.deepEqual(walk(bars(), small({ dropoutSpikeMinNames: 1000 })), ["NO_PRICE", "MARKED_ZERO:STUCK_AT_ZERO"]);
  // Back inside the window: sold at the open, never marked.
  assert.deepEqual(walk(bars(SPIKE + 2), rules), ["NO_PRICE:DATA_DROPOUT", "NO_PRICE:DATA_DROPOUT", "FILLED"]);
  // The fallback window length comes from the rules.
  assert.deepEqual(walk(bars(), small({ dropoutFallbackSessions: 1 })), ["NO_PRICE:DATA_DROPOUT", "NO_PRICE", "MARKED_ZERO:STUCK_AT_ZERO"]);
});

test("universe: the same code marks the drop-out name at the same session as paper, once", () => {
  const b = bars();
  const r = small().rules;
  const fired = SESSIONS.filter((S) => universeStuckAt(b, "a", S, r));
  assert.deepEqual(fired, [SESSIONS[SPIKE + 4]], "fallback 3 + N 2 covered sessions, the same session paper marks");
  assert.deepEqual(missedSessions(b, "a", SESSIONS[SPIKE + 2]!, r), { misses: 0, lastOpen: SESSIONS[SPIKE - 1], dropout: true });
  assert.deepEqual(missedSessions(b, "a", SESSIONS[SPIKE + 4]!, r), { misses: 2, lastOpen: SESSIONS[SPIKE - 1], dropout: true });
  assert.deepEqual(SESSIONS.filter((S) => universeStuckAt(b, "a", S, { ...r, dropoutSpikeMinNames: 1000 })), [SESSIONS[SPIKE + 1]]);
  assert.deepEqual(SESSIONS.filter((S) => universeStuckAt(bars(SPIKE + 2), "a", S, r)), []);
});

test("day rows show the drop-out: universe names and paper fills flagged DATA_DROPOUT that window", () => {
  const b = bars();
  const master = [...BASE, "a"].map((securityId) => ({ securityId, status: "ACTIVE", eligibility: "LEVEL_2", currentSymbol: securityId, assetType: "STOCK" })) as unknown as SecurityMasterRecord[];
  const f = (S: string, flags: string[] = []) => ({ schemaVersion: "paper-fills-v1", rulesVersion: "r", rulesSha256: "x", sessionDate: S, cashBefore: 1, cashAfterExits: 1, equityAtOpen: 1, cashAfter: 1, positionsAfter: [], fills: flags.length ? [{ securityId: "a", side: "SELL", status: "NO_PRICE", flags }] : [] }) as unknown as PaperFills;
  const day = computeDay({ from: f(SESSIONS[SPIKE]!), to: f(SESSIONS[SPIKE + 1]!, ["DATA_DROPOUT"]), bars: b, splits: new Map(), securities: master, loaded: small() });
  assert.equal(day.universeDataDropout, 20);
  assert.equal(day.paperDataDropout, 1);
  assert.equal(day.universeSize, 41, "drop-out names are left out, not marked");
  const normal = computeDay({ from: f(SESSIONS[SPIKE - 2]!), to: f(SESSIONS[SPIKE - 1]!), bars: b, splits: new Map(), securities: master, loaded: small() });
  assert.equal(normal.universeDataDropout, undefined);
  assert.equal(normal.paperDataDropout, undefined);
});

test("drop-out edges: p99 of the trailing counts, a name with a bar on the spike session, a hole before it", () => {
  const r = small().rules;
  // One trailing session with 8 drop-outs: the trailing p99 is 8, so 22 is not above 3 x 8.
  const rows: object[] = [];
  SESSIONS.forEach((d, i) => {
    const gone = i >= SPIKE;
    for (const id of [...BASE, "a"]) if (!(gone && DROPPED.includes(id)) && !(i === SPIKE - 5 && BASE.indexOf(id) >= 40 && BASE.indexOf(id) < 46)) rows.push({ securityId: id, sessionDate: d, open: 10, close: 10, revision: 1 });
    for (const k of [0, 1]) rows.push({ securityId: `c${i}_${k}`, sessionDate: d, open: 1, close: 1, revision: 1 });
  });
  const bumpy = new PaperBars(rows as never);
  assert.equal(bumpy.dropouts(SESSIONS[SPIKE - 5]!), 8);
  assert.equal(bumpy.dropoutSpike(SESSIONS[SPIKE]!, r), false, "22 is not above 3 x the p99 (8)");
  assert.equal(bumpy.dropoutSpike(SESSIONS[SPIKE]!, { ...r, dropoutSpikeMultiple: 2.7 }), true);
  // "a" keeps a bar with no usable open on the spike session: it did not drop out, so it counts as missed.
  const rowsA: object[] = [];
  SESSIONS.forEach((d, i) => {
    for (const id of [...BASE, "a"]) {
      const gone = i >= SPIKE && DROPPED.includes(id);
      if (!gone) rowsA.push({ securityId: id, sessionDate: d, open: 10, close: 10, revision: 1 });
      else if (id === "a" && i === SPIKE) rowsA.push({ securityId: id, sessionDate: d, open: 0, close: 10, revision: 1 });
    }
    for (const k of [0, 1]) rowsA.push({ securityId: `c${i}_${k}`, sessionDate: d, open: 1, close: 1, revision: 1 });
  });
  const withBar = new PaperBars(rowsA as never);
  assert.equal(withBar.dropoutSpike(SESSIONS[SPIKE]!, r), true, "21 others still dropped out");
  assert.equal(missKind(withBar, "a", SESSIONS[SPIKE]!, r), "MISS");
  assert.deepEqual(walk(withBar, small()), ["NO_PRICE", "MARKED_ZERO:STUCK_AT_ZERO"]);
  // A session with no bars at all between the last open and the drop-out is a hole, not the drop-out.
  const holed = new PaperBars(SESSIONS.flatMap((d, i) => (i === SPIKE - 1 ? [] : [...BASE, "a"].filter((id) => !(i >= SPIKE && DROPPED.includes(id))).map((id) => ({ securityId: id, sessionDate: d, open: 10, close: 10, revision: 1 })))) as never);
  assert.deepEqual(missedSessions(holed, "a", SESSIONS[SPIKE - 1]!, r), { misses: 0, lastOpen: SESSIONS[SPIKE - 2] });
});
