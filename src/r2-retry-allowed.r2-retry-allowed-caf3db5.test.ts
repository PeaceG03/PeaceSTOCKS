import assert from "node:assert/strict";
import test from "node:test";
import { r2RetryAllowed } from "./r2-retry-allowed";

test("r2RetryAllowed: the examples from the issue", () => {
  assert.equal(r2RetryAllowed(1), true);
  assert.equal(r2RetryAllowed(2), true);
  assert.equal(r2RetryAllowed(3), false);
  assert.equal(r2RetryAllowed(4), false);
  assert.equal(r2RetryAllowed(103), false);
  assert.equal(r2RetryAllowed(50), false);
  assert.equal(r2RetryAllowed(0), true);
  assert.equal(r2RetryAllowed(-100), true);
});
