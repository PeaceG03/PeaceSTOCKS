import assert from "node:assert/strict";
import test from "node:test";
import { readbackVerdict } from "./oct2024-tenmin-oneoff";

test("short read-back", () => {
  assert.equal(readbackVerdict({ listed: 5, verifiedOk: 4, failed: 0, sealed: true }), "FAIL");
  assert.equal(readbackVerdict({ listed: 5, verifiedOk: 6, failed: 0, sealed: true }), "FAIL");
  assert.equal(readbackVerdict({ listed: 1, verifiedOk: 1, failed: 0, sealed: true }), "PASS");
});
