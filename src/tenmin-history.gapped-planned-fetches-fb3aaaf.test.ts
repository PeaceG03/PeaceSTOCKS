import assert from "node:assert/strict";
import test from "node:test";
import { countGappedPlannedFetches } from "./tenmin-history";

test("gapped planned fetches", () => {
  assert.equal(countGappedPlannedFetches([{ securityId: "S", symbol: "A", fetchFrom: "f", fetchTo: "t" }], [{ securityId: "S", symbol: "A", reason: "r", at: "x", fetchFrom: "f", fetchTo: "t" }]), 1);
  assert.equal(countGappedPlannedFetches([{ securityId: "S", symbol: "A", fetchFrom: "f", fetchTo: "t" }], [{ securityId: "S", symbol: "B", reason: "r", at: "x", fetchFrom: "f", fetchTo: "t" }]), 0);
  assert.equal(countGappedPlannedFetches([{ securityId: "S", symbol: "A", fetchFrom: "f", fetchTo: "t" }], [{ securityId: "S", symbol: "A", reason: "r", at: "x" }]), 0);
});
