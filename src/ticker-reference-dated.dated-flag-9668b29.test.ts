import assert from "node:assert/strict";
import test from "node:test";
import { tickerIndexDatedEnabled } from "./ticker-reference-dated";

test("dated flag", () => {
  assert.equal(tickerIndexDatedEnabled({ TICKER_INDEX_DATED: "true", TICKER_INDEX_DATED_FULL: "false" }), true);
  assert.equal(tickerIndexDatedEnabled({ TICKER_INDEX_DATED: "TRUE" }), false);
  assert.equal(tickerIndexDatedEnabled({ TICKER_INDEX_DATED: "false" }), false);
  assert.equal(tickerIndexDatedEnabled({ TICKER_INDEX_DATED_FULL: "true" }), false);
});
