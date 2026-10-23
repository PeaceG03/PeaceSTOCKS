import assert from "node:assert/strict";
import test from "node:test";
import { tickerIndexDatedFullEnabled } from "./ticker-reference-dated";

test("full flag", () => {
  assert.equal(tickerIndexDatedFullEnabled({ TICKER_INDEX_DATED_FULL: "true", TICKER_INDEX_DATED: "true" }), true);
  assert.equal(tickerIndexDatedFullEnabled({ TICKER_INDEX_DATED: "true" }), false);
  assert.equal(tickerIndexDatedFullEnabled({ TICKER_INDEX_DATED_FULL: "1" }), false);
  assert.equal(tickerIndexDatedFullEnabled({ TICKER_INDEX_DATED_FULL: "True" }), false);
});
