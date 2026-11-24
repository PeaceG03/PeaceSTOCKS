// Required put-path guard (Auditor B3 + addition): a stored reply-dust object is never overwritten.
// Byte-identical content is a no-op success (reruns and refills keep working); different content is
// refused and nothing is touched. Named replacements never apply under a sealed range.
import assert from "node:assert/strict";
import test from "node:test";
import type { TenMinuteRangeReply } from "./contracts";
import { REPLY_DUST_OVERWRITE_REFUSED, storeVerifiedReplyDust } from "./intraday-reply-dust";
import { MemoryObjectClient } from "./object-store";
import { tenMinRangeFileKey, tenMinRangeManifestKey, writeTenMinRangeFetch } from "./tenmin-range-reply-dust";

const enc = new TextEncoder();
const KEY = "permanent/test-reply-dust/x.rdust";

function counting(store: MemoryObjectClient) {
  let puts = 0;
  const wrapped = Object.assign(Object.create(store) as MemoryObjectClient, {
    put: async (...args: Parameters<MemoryObjectClient["put"]>) => {
      puts += 1;
      return store.put(...args);
    },
  });
  return { wrapped, puts: () => puts };
}

test("no-overwrite: byte-identical content is a no-op success", async () => {
  const store = new MemoryObjectClient();
  const { wrapped, puts } = counting(store);
  const first = await storeVerifiedReplyDust(wrapped, KEY, enc.encode('{"results":[1]}'), "x");
  const again = await storeVerifiedReplyDust(wrapped, KEY, enc.encode('{"results":[1]}'), "x");
  assert.deepEqual(again, first);
  assert.equal(puts(), 1, "the rerun wrote nothing");
});

test("no-overwrite: different content is refused and nothing is overwritten", async () => {
  const store = new MemoryObjectClient();
  const stored = await storeVerifiedReplyDust(store, KEY, enc.encode('{"results":[1]}'), "x");
  await assert.rejects(storeVerifiedReplyDust(store, KEY, enc.encode('{"results":[1,2]}'), "x"), new RegExp(`^Error: ${REPLY_DUST_OVERWRITE_REFUSED}:x$`, "u"));
  assert.deepEqual(await store.get(KEY), stored);
  // The daily step's named replacement of its own shorter reply still works outside a seal.
  await storeVerifiedReplyDust(store, KEY, enc.encode('{"results":[1,2]}'), "x", undefined, undefined, { replace: "shorter-reply" });
  assert.notDeepEqual(await store.get(KEY), stored);
});

const page = (bars: number): TenMinuteRangeReply[] => [
  {
    page: 1,
    request: "/v2/aggs/ticker/BBB/range/10/minute/2026-10-09/2026-10-09?adjusted=false&sort=asc&limit=50000",
    fetchedAt: "2026-10-10T06:31:00.000Z",
    body: enc.encode(`{"ticker":"BBB","adjusted":false,"results":[${Array.from({ length: bars }, (_, i) => `{"v":1,"o":1,"c":1,"h":1,"l":1,"t":${1791552600000 + i * 600000},"n":1}`).join(",")}],"status":"OK","request_id":"SYN","count":${bars}}`),
    rangeFrom: "2026-10-09",
    rangeTo: "2026-10-09",
    securityId: "sec_bbb",
    symbol: "BBB",
  },
];
const opts = { provider: "massive-stocks", calendarFrom: "2026-09-01", calendarTo: "2026-10-31", fetchFrom: "2026-10-09", fetchTo: "2026-10-09" };

test("no-overwrite: under a sealed range even the named replacement is refused; the object stays byte-identical", async () => {
  const store = new MemoryObjectClient();
  await writeTenMinRangeFetch(store, page(30), opts);
  const key = tenMinRangeFileKey("2026-09-01", "2026-10-31", "sec_bbb", "BBB", "2026-10-09", "2026-10-09", 1);
  const before = await store.get(key);
  await store.put(tenMinRangeManifestKey("2026-09-01", "2026-10-31"), enc.encode("{}")); // sealed
  await assert.rejects(writeTenMinRangeFetch(store, page(39), { ...opts, replace: "shorter-reply" }), /REPLY_DUST_OVERWRITE_REFUSED:sec_bbb:BBB:p1/u);
  assert.deepEqual(await store.get(key), before);
  // A rerun of the same reply under the seal is still a no-op success.
  await writeTenMinRangeFetch(store, page(30), opts);
  assert.deepEqual(await store.get(key), before);
});
