import assert from "node:assert/strict";
import test from "node:test";
import { r2RetryDelayMs } from "./r2-retry-delay";

test("r2RetryDelayMs: the examples from the issue", () => {
  assert.equal(r2RetryDelayMs(0, 1000), 1000);
  assert.equal(r2RetryDelayMs(1, 1000), 4000);
  assert.equal(r2RetryDelayMs(2, 1000), 9000);
  assert.equal(r2RetryDelayMs(3, 1000), 16000);
  assert.equal(r2RetryDelayMs(4, 1000), 25000);
  assert.equal(r2RetryDelayMs(5, 1000), 30000);
  assert.equal(r2RetryDelayMs(10, 1000), 30000);
  assert.equal(r2RetryDelayMs(100, 1000), 30000);
  assert.equal(r2RetryDelayMs(0, 500), 500);
  assert.equal(r2RetryDelayMs(1, 500), 2000);
  assert.equal(r2RetryDelayMs(2, 250), 2250);
  assert.equal(r2RetryDelayMs(0, 0), 0);
  assert.equal(r2RetryDelayMs(7, 0), 0);
  assert.equal(r2RetryDelayMs(0, 40000), 30000);
});
