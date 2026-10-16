import assert from "node:assert/strict";
import test from "node:test";
import { bandOf } from "./num-utils";

test("bandOf throws INVALID_BAND_BOUNDS", () => {
  assert.throws(() => bandOf(1, -1e400, 1e400), /INVALID_BAND_BOUNDS/);
  assert.equal(bandOf(5, 0, 10), "inside");
});
