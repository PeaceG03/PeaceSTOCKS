import assert from "node:assert/strict";
import test from "node:test";
import { monthKeyOf } from "./daily-bar-sessions";

test("monthKeyOf returns the expected values", () => {
  assert.equal(monthKeyOf("2024-10-31"), "2024-10");
  assert.equal(monthKeyOf("2025-01-02"), "2025-01");
});
