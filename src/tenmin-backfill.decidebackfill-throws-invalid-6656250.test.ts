import assert from "node:assert/strict";
import test from "node:test";
import { decideBackfill } from "./tenmin-backfill";

test("decideBackfill throws INVALID_PENDING_RANGES", () => {
  assert.throws(() => decideBackfill(true, 1.5, false), /INVALID_PENDING_RANGES/);
  assert.equal(decideBackfill(true, 2, false), "dispatch");
});
