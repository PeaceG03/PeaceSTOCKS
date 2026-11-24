import assert from "node:assert/strict";
import test from "node:test";
import {
  paperClientOrderId,
  paperCorrectionKey,
  parsePaperCorrectionKey,
  paperLedgerKey,
  paperLedgerSession,
  PaperLedgerStore,
  PAPER_KILL_KEY,
  type PaperDay,
} from "./paper-ledger";
import { RecordingClient } from "./paper-fakes.test-helper";

const day = (equityTo: number): PaperDay => ({
  schemaVersion: "paper-day-v1",
  rulesVersion: "paper-rules-v3",
  rulesSha256: "x",
  fromSessionDate: "2026-12-01",
  toSessionDate: "2026-12-02",
  equityFrom: 100000,
  equityTo,
  paperReturn: equityTo / 100000 - 1,
  spyReturn: null,
  universeReturn: null,
  universeSize: 0,
  cumulativePaperReturn: 0,
  cumulativeSpyReturn: 0,
  cumulativeUniverseReturn: 0,
  positions: 0,
  costsUsd: 0,
});

test("ledger keys and client order ids: one per session, security and side", () => {
  assert.equal(paperLedgerKey("fills", "2026-12-02"), "paper/v1/fills/2026-12-02.json");
  assert.equal(paperLedgerSession("paper/v1/fills/2026-12-02.json", "fills"), "2026-12-02");
  assert.equal(paperLedgerSession("paper/v1/fills/2026-12-02.json", "days"), undefined);
  assert.equal(paperLedgerSession("paper/v1/fills/2026-12-02.json.bak", "fills"), undefined);
  assert.throws(() => paperLedgerKey("fills", "../x"), /PAPER_LEDGER_SESSION_INVALID/u);
  assert.equal(paperClientOrderId("paper-rules-v1", "2026-12-02", "sec_abc", "BUY"), "paper-rules-v1_2026-12-02_sec_abc_BUY");
  assert.notEqual(paperClientOrderId("paper-rules-v1", "2026-12-02", "sec_abc", "BUY"), paperClientOrderId("paper-rules-v1", "2026-12-02", "sec_abc", "SELL"));
  assert.throws(() => paperClientOrderId("paper-rules-v1", "2026-12-02", "a/b", "BUY"), /PAPER_LEDGER_SECURITY_INVALID/u);
});

test("append-only: a second write to the same key keeps the first object and does not put", async () => {
  const client = new RecordingClient();
  const store = new PaperLedgerStore(client);
  const key = paperLedgerKey("days", "2026-12-02");
  assert.equal(await store.putOnce(key, day(101000)), "WRITTEN");
  assert.equal(await store.putOnce(key, day(99000)), "KEPT_EXISTING");
  assert.deepEqual(client.puts, [key]);
  assert.equal((await store.read<PaperDay>(key))!.equityTo, 101000);
  assert.deepEqual(await store.sessions("days"), ["2026-12-02"]);
});

test("correction keys: one shape, write-once like every ledger key", async () => {
  assert.equal(paperCorrectionKey("2026-12-09", "sec_a", 1), "paper/v1/corrections/2026-12-09/sec_a_1.json");
  assert.deepEqual(parsePaperCorrectionKey("paper/v1/corrections/2026-12-09/sec_a_12.json"), { sessionDate: "2026-12-09", securityId: "sec_a", n: 12 });
  for (const bad of ["paper/v1/corrections/2026-12-09/sec_a_0.json", "paper/v1/corrections/2026-12-09/sec_a.json", "paper/v1/corrections/x/sec_a_1.json", "paper/v1/corrections/2026-12-09/a/b_1.json", "x/paper/v1/corrections/2026-12-09/sec_a_1.json", "paper/v1/corrections/2026-12-09/sec_a_1.json.bak"])
    assert.equal(parsePaperCorrectionKey(bad), undefined, bad);
  assert.throws(() => paperCorrectionKey("2026-12-09", "a/b", 1), /PAPER_LEDGER_SECURITY_INVALID/u);
  assert.throws(() => paperCorrectionKey("2026-12-09", "a", 0), /PAPER_LEDGER_CORRECTION_INVALID/u);
  const client = new RecordingClient();
  const store = new PaperLedgerStore(client);
  const key = paperCorrectionKey("2026-12-09", "sec_a", 1);
  assert.equal(await store.putOnce(key, day(1)), "WRITTEN");
  assert.equal(await store.putOnce(key, day(2)), "KEPT_EXISTING");
  for (const bad of ["paper/v1/corrections/2026-12-09/sec_a_0.json", "x/paper/v1/corrections/2026-12-09/sec_a_1.json"])
    await assert.rejects(store.putOnce(bad, day(1)), /PAPER_LEDGER_KEY_REFUSED/u);
  client.objects.set("paper/v1/corrections/junk", new Uint8Array());
  assert.deepEqual(await store.correctionKeys(), [key]);
});

test("append-only: only ledger keys can be written (no kill key, scanner data, or other prefix)", async () => {
  const client = new RecordingClient();
  const store = new PaperLedgerStore(client);
  for (const key of [PAPER_KILL_KEY, "permanent/predictions/2026-12-02.jsonl", "paper/v1/fills/latest.json", "paper/v2/fills/2026-12-02.json", "x/paper/v1/fills/2026-12-02.json"])
    await assert.rejects(store.putOnce(key, day(1)), /PAPER_LEDGER_KEY_REFUSED/u);
  assert.deepEqual(client.puts, []);
  assert.equal("delete" in store, false);
});

test("kill key: present -> killed", async () => {
  const client = new RecordingClient();
  const store = new PaperLedgerStore(client);
  assert.equal(await store.killed(), false);
  client.objects.set(PAPER_KILL_KEY, new Uint8Array());
  assert.equal(await store.killed(), true);
});
