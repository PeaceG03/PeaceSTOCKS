import assert from "node:assert/strict";
import test from "node:test";
import { shouldDispatchHeal } from "./tenmin-redispatch";

test("heal dispatch", () => {
  assert.equal(shouldDispatchHeal({ dispatch: false, nextAction: "wait", reason: "WAIT_GUARD_WINDOW", nextChain: 1 }), true);
  assert.equal(shouldDispatchHeal({ dispatch: false, nextAction: "wait", reason: "WAIT_NEAR_GUARD_WINDOW", nextChain: 1 }), true);
  assert.equal(shouldDispatchHeal({ dispatch: true, nextAction: "continue", reason: "WAIT_GUARD_WINDOW", nextChain: 1 }), false);
  assert.equal(shouldDispatchHeal({ dispatch: false, nextAction: "wait", reason: "OTHER", nextChain: 1 }), false);
});
