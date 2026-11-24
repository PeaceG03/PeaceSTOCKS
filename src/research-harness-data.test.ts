import assert from "node:assert/strict";
import test from "node:test";
import type { CorporateAction, SecurityMasterRecord } from "./contracts";
import { EvalHistory, rng, type EvalBar } from "./holdout-eval";
import { buildHarnessSession, openToNextOpen } from "./research-harness-data";

function weekdays(n: number, first = "2026-03-02"): string[] {
  const out: string[] = [];
  for (let d = new Date(`${first}T00:00:00Z`); out.length < n; d.setUTCDate(d.getUTCDate() + 1))
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  return out;
}
const rec = (id: string, status: "ACTIVE" | "INACTIVE" = "ACTIVE") =>
  ({ securityId: id, currentSymbol: id, assetType: "STOCK", status, eligibility: "LEVEL_3", providerIdentities: [] }) as unknown as SecurityMasterRecord;

function world(n: number, days: string[], seed: number) {
  const r = rng(seed);
  const bars: EvalBar[] = [];
  const ids = Array.from({ length: n }, (_, k) => `s${String(k).padStart(3, "0")}`);
  for (const id of ids) {
    let close = 20 + r() * 50;
    for (const day of days) {
      const open = close * (1 + (r() - 0.5) * 0.002);
      close = open * (1 + (r() - 0.5) * 0.02);
      bars.push({ securityId: id, sessionDate: day, open, close, volume: 1e5 + r() * 1e5, revision: 1 });
    }
  }
  return { bars, ids };
}

test("outcome is open(D+1) -> open(D+2)", () => {
  const days = weekdays(4);
  const history = new EvalHistory(days.map((d, k) => ({ securityId: "a", sessionDate: d, open: 10 + k, close: 100, volume: 1, revision: 1 })));
  assert.equal(openToNextOpen(history, "a", 0), 12 / 11 - 1);
  assert.equal(openToNextOpen(history, "a", 2), undefined);
});

test("session D's lists use nothing after D; outcomes use only D+1 and D+2 opens", () => {
  const days = weekdays(140);
  const { bars, ids } = world(60, days, 5);
  const i = 110;
  const base = buildHarnessSession(ids.map((id) => rec(id)), new EvalHistory(bars), i, { splitActions: [] })!;
  const r = rng(7);
  const later = bars.map((b) => (b.sessionDate > days[i + 2]! ? { ...b, open: b.open * (0.5 + r()), close: b.close * (0.5 + r()) } : b));
  assert.deepEqual(buildHarnessSession(ids.map((id) => rec(id)), new EvalHistory(later), i, { splitActions: [] })!.session, base.session);
  const closesAfterD = bars.map((b) => (b.sessionDate > days[i]! ? { ...b, close: b.close * 1.5 } : b));
  const shifted = buildHarnessSession(ids.map((id) => rec(id)), new EvalHistory(closesAfterD), i, { splitActions: [] })!;
  assert.deepEqual(Object.fromEntries(Object.entries(shifted.session.lists).map(([k, v]) => [k, v.ids])), Object.fromEntries(Object.entries(base.session.lists).map(([k, v]) => [k, v.ids])));
  assert.deepEqual(shifted.session, base.session); // closes after D are not part of the outcome
  assert.ok(base.session.universeSize > 0 && base.session.lists.TOP_15_OVERALL!.ids.length === 15);
});

test("survivorship: a name INACTIVE in today's master is ranked and scored on the days it traded", () => {
  const days = weekdays(140);
  const { bars, ids } = world(40, days, 9);
  const gone = ids[0]!;
  const i = 110;
  const kept = bars.filter((b) => b.securityId !== gone || b.sessionDate <= days[120]!); // delisted after day 120
  const master = ids.map((id) => rec(id, id === gone ? "INACTIVE" : "ACTIVE"));
  const withGone = buildHarnessSession(master, new EvalHistory(kept), i, { splitActions: [] })!;
  const without = buildHarnessSession(master.filter((m) => m.securityId !== gone), new EvalHistory(kept), i, { splitActions: [] })!;
  assert.equal(withGone.session.universeSize, without.session.universeSize + 1);
  // After it stopped trading it is not in the universe.
  const after = buildHarnessSession(master, new EvalHistory(kept), 125, { splitActions: [] })!;
  const afterWithout = buildHarnessSession(master.filter((m) => m.securityId !== gone), new EvalHistory(kept), 125, { splitActions: [] })!;
  assert.equal(after.session.universeSize, afterWithout.session.universeSize);
});

test("a split taking effect on D+2 removes the name's outcome for picks and universe alike", () => {
  const days = weekdays(140);
  const { bars, ids } = world(30, days, 13);
  const i = 110;
  const base = buildHarnessSession(ids.map((id) => rec(id)), new EvalHistory(bars), i, { splitActions: [] })!;
  const pick = base.session.lists.TOP_15_OVERALL!.ids[0]!;
  const split: CorporateAction = { actionId: "x", securityId: pick, actionType: "SPLIT", effectiveDate: days[i + 2]!, details: { split_from: 1, split_to: 2 }, observedAt: "2099-01-01T00:00:00Z" } as unknown as CorporateAction;
  const got = buildHarnessSession(ids.map((id) => rec(id)), new EvalHistory(bars), i, { splitActions: [split] })!;
  assert.equal(got.session.lists.TOP_15_OVERALL!.returns[0], null);
  assert.equal(got.session.universeSize, base.session.universeSize - 1);
  const onEntry = { ...split, effectiveDate: days[i + 1]! } as CorporateAction;
  assert.notEqual(buildHarnessSession(ids.map((id) => rec(id)), new EvalHistory(bars), i, { splitActions: [onEntry] })!.session.lists.TOP_15_OVERALL!.returns[0], null);
});
