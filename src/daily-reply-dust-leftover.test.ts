// Auditor B4: a grouped-daily file left without its manifest (crash between the file and the manifest
// write) is replaced by the next attempt; once the manifest exists a different file is refused.
import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderRawReply } from "./contracts";
import { dailyReplyDustFileKey, dailyReplyDustManifestKey, readDailyReplyDustReply, writeDailyReplyDust } from "./daily-reply-dust";
import { MemoryObjectClient } from "./object-store";
import { decodeReplyDust, encodeReplyDust, nodeReplyDustBackend } from "./reply-dust";

const DAY = "2026-11-20";
const te = new TextEncoder();
const td = new TextDecoder();
const body = (requestId: string) =>
  te.encode(`{"queryCount":1,"resultsCount":1,"adjusted":false,"results":[{"T":"AAA","v":10,"vw":1.5,"o":1,"c":2,"h":2,"l":1,"t":1763672400000,"n":3}],"status":"OK","request_id":"${requestId}","count":1}`);
const reply = (requestId: string): ProviderRawReply => ({
  dataset: "stocks-grouped-daily",
  sessionDate: DAY,
  request: `/v2/aggs/grouped/locale/us/market/stocks/${DAY}`,
  fetchedAt: "2026-11-21T01:00:00.000Z",
  body: body(requestId),
});
const opts = { provider: "massive-stocks", observedAt: "2026-11-21T01:00:00.000Z" };

test("B4: a leftover grouped-daily file with no manifest is replaced by the re-fetch", async () => {
  const store = new MemoryObjectClient();
  await store.put(dailyReplyDustFileKey(DAY), encodeReplyDust(body("crashed-attempt"), nodeReplyDustBackend));
  assert.equal(await store.get(dailyReplyDustManifestKey(DAY)), undefined);
  const manifest = await writeDailyReplyDust(store, reply("refetch"), opts);
  assert.ok(await store.get(dailyReplyDustManifestKey(DAY)));
  const stored = await store.get(dailyReplyDustFileKey(DAY));
  assert.match(td.decode(decodeReplyDust(stored!, nodeReplyDustBackend)), /"request_id":"refetch"/);
  assert.deepEqual(await readDailyReplyDustReply(store, manifest), body("refetch")); // sealed read passes
});

test("B4: once the day's manifest exists a different file is refused and nothing is overwritten", async () => {
  const store = new MemoryObjectClient();
  await writeDailyReplyDust(store, reply("first"), opts);
  const before = await store.get(dailyReplyDustFileKey(DAY));
  const manifestBefore = await store.get(dailyReplyDustManifestKey(DAY));
  await assert.rejects(writeDailyReplyDust(store, reply("second"), opts), /REPLY_DUST_SESSION_ALREADY_SEALED|REPLY_DUST_OVERWRITE_REFUSED/);
  assert.deepEqual(await store.get(dailyReplyDustFileKey(DAY)), before);
  assert.deepEqual(await store.get(dailyReplyDustManifestKey(DAY)), manifestBefore);
});
