import assert from "node:assert/strict";
import test from "node:test";
import { assertCancelRunAccepted } from "./tenmin-redispatch";

test("assertCancelRunAccepted throws INVALID_RUN_ID", () => {
  assert.throws(() => assertCancelRunAccepted(202, 0), /INVALID_RUN_ID/);
  assert.equal(assertCancelRunAccepted(202, 5), undefined);
});
