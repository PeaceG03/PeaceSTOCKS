import assert from "node:assert/strict";
import test from "node:test";
import { strictRefillBudgetMs } from "./gap-refill";

test("strictRefillBudgetMs: strict REFILL_BUDGET_MS, fail closed", () => {
  assert.equal(strictRefillBudgetMs(undefined), strictRefillBudgetMs(""));
  assert.equal(strictRefillBudgetMs("1"), 1);
  assert.equal(strictRefillBudgetMs("86400000"), 86400000);
  for (const bad of ["Infinity","1e3","0x10","0","-1","1.5","86400001","abc"]) assert.throws(() => strictRefillBudgetMs(bad), /REFILL_BUDGET_MS_INVALID/, bad);
});
