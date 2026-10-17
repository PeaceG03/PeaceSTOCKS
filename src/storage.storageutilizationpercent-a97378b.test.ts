import assert from "node:assert/strict";
import test from "node:test";
import { storageUtilizationPercent } from "./storage";

test("storageUtilizationPercent returns the expected values", () => {
  assert.equal(storageUtilizationPercent(128), 315);
  assert.equal(storageUtilizationPercent(1024), 2520);
  assert.equal(storageUtilizationPercent(0), 0);
});
