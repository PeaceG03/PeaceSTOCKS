import assert from "node:assert/strict";
import test from "node:test";
import { historyBlockingDay } from "./history-blocked";

const W = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"];
const day = (sessionDate: string, state: "done" | "failed" | "untried") => ({
  sessionDate,
  done: state === "done",
  failed: state === "failed",
});

test("history hold: a failed day inside the window with no later done session blocks", () => {
  assert.equal(historyBlockingDay([day("2026-10-08", "done"), day("2026-10-09", "failed")], W), "2026-10-09");
});

test("history hold: a later done session unblocks the chain", () => {
  assert.equal(historyBlockingDay([day("2026-10-08", "failed"), day("2026-10-09", "done")], W), undefined);
  assert.equal(
    historyBlockingDay([day("2026-10-07", "failed"), day("2026-10-08", "failed"), day("2026-10-09", "done")], W),
    undefined,
  );
});

test("history hold: only days still inside the 10-session window block", () => {
  assert.equal(historyBlockingDay([day("2026-09-20", "failed")], W), undefined);
});

test("history hold: a day the daily step has not tried yet does not block", () => {
  assert.equal(historyBlockingDay([day("2026-10-08", "done"), day("2026-10-09", "untried")], W), undefined);
});

test("history hold: the oldest blocking day is named", () => {
  assert.equal(historyBlockingDay([day("2026-10-09", "failed"), day("2026-10-07", "failed")], W), "2026-10-07");
});
