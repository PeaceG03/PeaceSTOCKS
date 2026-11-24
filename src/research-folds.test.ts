import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FOLD_ORDER_INVALID,
  HELD_OUT_NOT_REGISTERED,
  HELD_OUT_SEALED,
  HELD_OUT_WINDOW_CHANGED,
  HeldOutSeal,
  assertFoldOrder,
  walkForwardFolds,
  type Fold,
} from "./research-folds";

test("rolling folds: every test window starts after its train window plus the embargo and before held-out", () => {
  const folds = walkForwardFolds(100, { trainSessions: 20, testSessions: 25, embargoSessions: 2, mode: "rolling" });
  assert.deepEqual(
    folds.map((f) => [f.train.start, f.train.end, f.test.start, f.test.end]),
    [
      [0, 19, 22, 46],
      [25, 44, 47, 71],
      [50, 69, 72, 96],
    ],
  );
  // The 1-session tail (97..97) is dropped; the last outcome read is session 96 + 2 = 98 < 100.
  assert.ok(folds.every((f) => f.test.end + 2 < 100));
});

test("expanding folds start training at session 0", () => {
  const folds = walkForwardFolds(60, { trainSessions: 10, testSessions: 20, embargoSessions: 1, mode: "expanding" });
  assert.deepEqual(folds.map((f) => [f.train.start, f.train.end, f.test.start, f.test.end]), [
    [0, 9, 11, 30],
    [0, 29, 31, 50],
  ]);
  // The 7-session tail (51..57) is shorter than half a test window: dropped.
});

const fold = (index: number, trainStart: number, trainEnd: number, testStart: number, testEnd: number): Fold => ({
  index,
  train: { start: trainStart, end: trainEnd },
  test: { start: testStart, end: testEnd },
});

test("assertFoldOrder refuses a test window that is not strictly after its train window", () => {
  assert.doesNotThrow(() => assertFoldOrder([fold(0, 0, 9, 11, 20)], 30));
  assert.throws(() => assertFoldOrder([fold(0, 0, 9, 10, 20)], 30), /test-not-after-train/); // no embargo
  assert.throws(() => assertFoldOrder([fold(0, 0, 9, 9, 20)], 30), /test-not-after-train/);
  assert.throws(() => assertFoldOrder([fold(0, 10, 19, 2, 8)], 30), /test-not-after-train/); // test before train
  assert.throws(() => assertFoldOrder([fold(0, 0, 9, 11, 20), fold(1, 0, 15, 20, 25)], 40), /test-overlap/);
  assert.throws(() => assertFoldOrder([fold(0, 0, 9, 11, 28)], 30), /reads-held-out/);
  assert.doesNotThrow(() => assertFoldOrder([fold(0, 0, 9, 11, 28)], 31));
  assert.throws(() => assertFoldOrder([fold(0, -1, 9, 11, 20)], 30), /train-range/);
  assert.throws(() => assertFoldOrder([], 30), /no-folds/);
  assert.throws(() => walkForwardFolds(100, { trainSessions: 20, testSessions: 25, embargoSessions: 0, mode: "rolling" }), new RegExp(FOLD_ORDER_INVALID));
});

const WINDOW = { from: "2026-08-27", to: "2026-11-20" };
const sealAt = () => {
  const dir = mkdtempSync(join(tmpdir(), "seal-"));
  return { dir, path: join(dir, "heldout.jsonl") };
};

test("held-out: one evaluation per registered strategy; a second refuses until a human unseal is recorded", () => {
  const { path } = sealAt();
  const seal = new HeldOutSeal(path);
  const config = { list: "TOP_15_OVERALL", slippageBps: 10 };
  assert.throws(() => seal.evaluateOnce("nope", WINDOW, () => 1), new RegExp(HELD_OUT_NOT_REGISTERED));
  const hash = seal.register(config, WINDOW);
  assert.equal(seal.register(config, WINDOW), hash); // idempotent
  let runs = 0;
  assert.equal(seal.evaluateOnce(hash, WINDOW, () => ++runs), 1);
  assert.throws(() => seal.evaluateOnce(hash, WINDOW, () => ++runs), new RegExp(HELD_OUT_SEALED));
  assert.equal(runs, 1);
  // A fresh process reading the same log is sealed too.
  assert.throws(() => new HeldOutSeal(path).evaluateOnce(hash, WINDOW, () => ++runs), new RegExp(HELD_OUT_SEALED));
  assert.throws(() => seal.unseal(hash, "", "x"), /NEEDS_BY_AND_REASON/);
  seal.unseal(hash, "Peace", "re-check after data fix");
  assert.equal(seal.evaluateOnce(hash, WINDOW, () => ++runs), 2);
  assert.throws(() => seal.evaluateOnce(hash, WINDOW, () => ++runs), new RegExp(HELD_OUT_SEALED));
  assert.deepEqual(seal.status(hash), { registered: true, evaluations: 2, unseals: 1 });
});

test("held-out: a throwing evaluation still uses the look; another window is refused", () => {
  const { path } = sealAt();
  const seal = new HeldOutSeal(path);
  const hash = seal.register({ list: "TOP_50_OVERALL" }, WINDOW);
  assert.throws(() => seal.evaluateOnce(hash, WINDOW, () => { throw new Error("boom"); }), /boom/);
  assert.throws(() => seal.evaluateOnce(hash, WINDOW, () => 1), new RegExp(HELD_OUT_SEALED));
  assert.throws(() => seal.register({ list: "TOP_50_OVERALL" }, { ...WINDOW, to: "2026-11-21" }), new RegExp(HELD_OUT_WINDOW_CHANGED));
  const other = seal.register({ list: "DEFENSIVE_LOW_RISK" }, WINDOW);
  assert.throws(() => seal.evaluateOnce(other, { ...WINDOW, from: "2026-09-01" }, () => 1), new RegExp(HELD_OUT_WINDOW_CHANGED));
});

test("held-out: dropping the EVALUATE lines from the log does not reopen the period (marker file)", () => {
  const { path } = sealAt();
  const seal = new HeldOutSeal(path);
  const hash = seal.register({ list: "STRONGEST_MOMENTUM" }, WINDOW);
  seal.evaluateOnce(hash, WINDOW, () => 1);
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  writeFileSync(path, `${lines[0]}\n`); // only REGISTER left: a valid chain
  assert.throws(() => new HeldOutSeal(path).evaluateOnce(hash, WINDOW, () => 2), new RegExp(HELD_OUT_SEALED));
  rmSync(path);
  assert.throws(() => new HeldOutSeal(path).evaluateOnce(hash, WINDOW, () => 2), new RegExp(HELD_OUT_NOT_REGISTERED));
});
