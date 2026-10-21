import assert from "node:assert/strict";
import test from "node:test";
import { resolveTenMinDelistedCoverageForSeal } from "./tenmin-range-reply-dust";

test("requested coverage", () => {
  assert.equal(resolveTenMinDelistedCoverageForSeal(undefined, []), "MISSING");
  assert.equal(resolveTenMinDelistedCoverageForSeal("MISSING", []), "MISSING");
  assert.equal(resolveTenMinDelistedCoverageForSeal("COMPLETE", []), "COMPLETE");
});
