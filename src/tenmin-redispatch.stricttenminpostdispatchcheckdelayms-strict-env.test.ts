import assert from "node:assert/strict";
import test from "node:test";
import { strictTenminPostDispatchCheckDelayMs } from "./tenmin-redispatch";

test("strictTenminPostDispatchCheckDelayMs: strict TENMIN_POST_DISPATCH_CHECK_DELAY_MS, fail closed", () => {
  assert.equal(strictTenminPostDispatchCheckDelayMs(undefined), strictTenminPostDispatchCheckDelayMs(""));
  assert.equal(strictTenminPostDispatchCheckDelayMs("1"), 1);
  assert.equal(strictTenminPostDispatchCheckDelayMs("600000"), 600000);
  for (const bad of ["Infinity","1e3","0x10","0","-1","1.5","600001","abc"]) assert.throws(() => strictTenminPostDispatchCheckDelayMs(bad), /TENMIN_POST_DISPATCH_CHECK_DELAY_MS_INVALID/, bad);
});
