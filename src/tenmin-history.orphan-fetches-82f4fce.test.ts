import assert from "node:assert/strict";
import test from "node:test";
import { countOrphanFetches } from "./tenmin-history";

test("orphan fetches", () => {
  assert.equal(countOrphanFetches([{ securityId: "S", symbol: "A", fetchFrom: "f", fetchTo: "t" }], [], [{ securityId: "S", symbol: "B", reason: "r", at: "x", fetchFrom: "f", fetchTo: "t" }]), 1);
  assert.equal(countOrphanFetches([{ securityId: "S", symbol: "A", fetchFrom: "f", fetchTo: "t" }], [], [{ securityId: "S", symbol: "A", reason: "r", at: "x", fetchFrom: "f", fetchTo: "t" }]), 0);
  assert.equal(countOrphanFetches([], [], []), 0);
});
