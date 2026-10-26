import assert from "node:assert/strict";
import test from "node:test";
import { checkinLine } from "./health-checkin-line";

test("checkinLine: the examples from the issue", () => {
  assert.equal(checkinLine("scan", "OK", "rows 812"), "CHECKIN|scan|OK|rows 812");
  assert.equal(checkinLine("tenmin", "ERROR", "R2_GET_500"), "CHECKIN|tenmin|ERROR|R2_GET_500");
  assert.equal(checkinLine("gap-refill", "OK", ""), "CHECKIN|gap-refill|OK|");
  assert.equal(checkinLine("Daily Bars", "WARN", "late 3m"), "CHECKIN|Daily Bars|WARN|late 3m");
  assert.equal(checkinLine("r2", "ERROR", " timeout "), "CHECKIN|r2|ERROR| timeout ");
  assert.equal(checkinLine("", "OK", "no part"), "CHECKIN||OK|no part");
  assert.equal(checkinLine("intraday2", "", "missing status"), "CHECKIN|intraday2||missing status");
  assert.equal(checkinLine(" backfill", "Ok", "done: 4/4"), "CHECKIN| backfill|Ok|done: 4/4");
  assert.equal(checkinLine("read-api ", "SILENT", "last 2026-10-24"), "CHECKIN|read-api |SILENT|last 2026-10-24");
  assert.equal(checkinLine("Sidecar9", " OK", "count=12, ok"), "CHECKIN|Sidecar9| OK|count=12, ok");
  assert.equal(checkinLine("host", "error 2", "fetch failed"), "CHECKIN|host|error 2|fetch failed");
  assert.equal(checkinLine("parser", "Bad, 3 ", "x"), "CHECKIN|parser|Bad, 3 |x");
});
