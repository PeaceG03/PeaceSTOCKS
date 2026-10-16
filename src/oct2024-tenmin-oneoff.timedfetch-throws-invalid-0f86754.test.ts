import assert from "node:assert/strict";
import test from "node:test";
import { timedFetch } from "./oct2024-tenmin-oneoff";

test("timedFetch throws INVALID_TIMEOUT_MS", () => {
  assert.throws(() => timedFetch(0), /INVALID_TIMEOUT_MS/);
  assert.equal(timedFetch(1000).length, 2);
});
