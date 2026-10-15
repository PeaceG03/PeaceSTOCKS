import assert from "node:assert/strict";
import test from "node:test";
import { featureRecipe } from "./features";

test("featureRecipe throws INVALID_FEATURE_ID", () => {
  assert.throws(() => featureRecipe(""), /INVALID_FEATURE_ID/);
});
