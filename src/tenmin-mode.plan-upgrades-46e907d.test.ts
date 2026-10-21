import assert from "node:assert/strict";
import test from "node:test";
import { planUpgraded } from "./tenmin-mode";

test("plan upgrades", () => {
  assert.equal(planUpgraded({ windowStart: "2024-01-01", ratePerMin: 5 }, undefined), false);
  assert.equal(planUpgraded({ windowStart: "2023-01-01", ratePerMin: 5 }, { windowStart: "2024-01-01", ratePerMin: 5 }), true);
  assert.equal(planUpgraded({ windowStart: "2024-01-01", ratePerMin: 10 }, { windowStart: "2024-01-01", ratePerMin: 5 }), true);
  assert.equal(planUpgraded({ windowStart: "2025-01-01", ratePerMin: 5 }, { windowStart: "2024-01-01", ratePerMin: 10 }), false);
});
