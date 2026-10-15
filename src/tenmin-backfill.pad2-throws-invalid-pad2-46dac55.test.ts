import assert from "node:assert/strict";
import test from "node:test";
import { pad2 } from "./tenmin-backfill";

test("pad2 throws INVALID_PAD2", () => {
  assert.throws(() => pad2(-1), /INVALID_PAD2/);
  assert.equal(pad2(7), "07");
});
