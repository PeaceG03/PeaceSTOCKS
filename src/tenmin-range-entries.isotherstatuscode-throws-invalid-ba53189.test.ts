import assert from "node:assert/strict";
import test from "node:test";
import { isOtherStatusCode } from "./tenmin-range-entries";

test("isOtherStatusCode throws INVALID_STATUS_CODE", () => {
  assert.throws(() => isOtherStatusCode(-1), /INVALID_STATUS_CODE/);
  assert.equal(isOtherStatusCode(0), false);
});
