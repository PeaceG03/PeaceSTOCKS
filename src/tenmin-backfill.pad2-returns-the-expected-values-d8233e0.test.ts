import assert from "node:assert/strict";
import test from "node:test";
import { pad2 } from "./tenmin-backfill";

test("pad2 returns the expected values", () => {
  assert.equal(pad2(7), "07");
  assert.equal(pad2(12), "12");
});
