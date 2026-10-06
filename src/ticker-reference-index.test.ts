import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MassiveMarketProvider } from "./massive-provider";
import { MemoryObjectClient } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";
import { MarketStorage } from "./storage";
import {
  TICKER_REFERENCE_INDEX_MANIFEST_KEY,
  type TickerReferenceCapture,
  type TickerReferenceDelta,
  type TickerReferencePass,
  loadTickerReferenceIndex,
  parseTickerReferenceBody,
  rawResultsElements,
  tickerReferenceEntry,
  writeTickerReferenceIndex,
} from "./ticker-reference-index";
import { nodeReplyDustBackend } from "./reply-dust";
import { refreshUniverse } from "./universe";

// Hand-written reply bodies (odd spacing, escapes, number forms) so "exact raw" is meaningful.
const ACTIVE_P1_RECORDS = [
  `{"ticker":"AAA","name":"Alpha \\"A\\" Inc","market":"stocks","locale":"us","primary_exchange":"XNYS","type":"CS","active":true,"currency_name":"usd","composite_figi":"BBG000AAA001","share_class_figi":"BBG001AAA001","last_updated_utc":"2026-10-05T00:00:00Z"}`,
  `{ "ticker" : "AAAW", "name":"Alpha Warrants", "market":"stocks","locale":"us","type":"WARRANT","active":true, "weight": 1.0 }`,
];
const ACTIVE_P2_RECORDS = [
  `{"ticker":"BBBU","name":"Bravo Units","market":"stocks","locale":"us","type":"UNIT","active":true,"primary_exchange":"XNAS","composite_figi":null}`,
  `{"ticker":"REUS","name":"Reused New Co","market":"stocks","locale":"us","type":"CS","active":true,"composite_figi":"BBG000NEW001","share_class_figi":"BBG001NEW001","list_date":"2025-03-03"}`,
];
const INACTIVE_RECORDS = [
  `{"ticker":"REUS","name":"Reused Old Warrant","market":"stocks","locale":"us","type":"WARRANT","active":false,"delisted_utc":"2021-06-30T00:00:00Z","composite_figi":"BBG000OLD001","share_class_figi":"BBG001OLD001"}`,
  `{"ticker":"NOFG","name":"No Figi Corp","market":"stocks","locale":"us","type":"CS","active":false,"delisted_utc":"2023-02-01T00:00:00Z","n":1e3}`,
];
const BODIES: Record<string, string> = {
  "true:1": `{"results":[\n  ${ACTIVE_P1_RECORDS.join(" ,\n  ")}\n],"status":"OK","request_id":"a1","next_url":"https://api.massive.com/v3/reference/tickers?cursor=a2"}`,
  "true:2": `{"status":"OK","results":[${ACTIVE_P2_RECORDS.join(",")}],"count":2}`,
  "false:1": `{ "request_id" : "i1", "results" : [ ${INACTIVE_RECORDS.join(", ")} ] }`,
};
const ALL_RAW = [...ACTIVE_P1_RECORDS, ...ACTIVE_P2_RECORDS, ...INACTIVE_RECORDS];

function provider(urls: string[]): MassiveMarketProvider {
  return new MassiveMarketProvider({
    apiKey: "test-key",
    minRequestIntervalMs: 0,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      urls.push(url.pathname + url.search.replace(/apiKey=[^&]*/u, "apiKey=x"));
      const key = url.searchParams.get("cursor") === "a2" ? "true:2" : `${url.searchParams.get("active")}:1`;
      return new Response(BODIES[key], { status: 200 });
    },
  });
}

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "peacestocks-ticker-ref-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("rawResultsElements returns each results element's exact text", () => {
  assert.deepEqual(rawResultsElements(BODIES["true:1"]!), ACTIVE_P1_RECORDS);
  assert.deepEqual(rawResultsElements(BODIES["false:1"]!), INACTIVE_RECORDS);
  // "results" as a nested key or as a value is not the top-level array.
  assert.deepEqual(rawResultsElements(`{"meta":{"results":[1]},"status":"results","results":[{"a":"]"}]}`), [`{"a":"]"}`]);
  assert.deepEqual(rawResultsElements(`{"status":"OK"}`), []);
});

test("the ticker listing captures every record of every type, in order, with no extra requests", async () => {
  const urls: string[] = [];
  const massive = provider(urls);
  const listed = await massive.listApprovedSecurities();
  // Same three page requests the listing always made: active p1, active p2 (next_url), inactive p1.
  assert.equal(urls.length, 3);
  assert.deepEqual(urls.map((u) => new URLSearchParams(u.split("?")[1]).get("active") ?? "cursor"), ["true", "cursor", "false"]);
  // The master's own filter is unchanged: CS/ETF only.
  assert.deepEqual(listed.map((r) => [r.symbol, r.active]).sort(), [["AAA", true], ["NOFG", false], ["REUS", true]]);
  const capture = massive.takeTickerReferenceCapture()!;
  assert.deepEqual(capture.pages, { active: 2, inactive: 1 });
  assert.deepEqual(capture.entries.map((e) => e.raw), ALL_RAW);
  assert.deepEqual(
    capture.entries.map((e) => [e.pass, e.page, e.position, e.ticker, e.type]),
    [
      ["active", 1, 0, "AAA", "CS"],
      ["active", 1, 1, "AAAW", "WARRANT"],
      ["active", 2, 0, "BBBU", "UNIT"],
      ["active", 2, 1, "REUS", "CS"],
      ["inactive", 1, 0, "REUS", "WARRANT"],
      ["inactive", 1, 1, "NOFG", "CS"],
    ],
  );
  // Reused ticker: both records kept, each with its own delisted_utc and FIGI.
  const reus = capture.entries.filter((e) => e.ticker === "REUS");
  assert.deepEqual(
    reus.map((e) => [e.active, e.delisted_utc, e.composite_figi, e.share_class_figi]),
    [
      [true, undefined, "BBG000NEW001", "BBG001NEW001"],
      [false, "2021-06-30T00:00:00Z", "BBG000OLD001", "BBG001OLD001"],
    ],
  );
  assert.equal("delisted_utc" in reus[0]!, false);
  // No FIGI in the record: none invented. An explicit null stays null.
  const nofg = capture.entries.find((e) => e.ticker === "NOFG")!;
  assert.equal("composite_figi" in nofg, false);
  assert.equal("share_class_figi" in nofg, false);
  assert.equal("primary_exchange" in nofg, false);
  assert.equal(capture.entries.find((e) => e.ticker === "BBBU")!.composite_figi, null);
  // Handed over once.
  assert.equal(massive.takeTickerReferenceCapture(), undefined);
});

test("the index is written with the master, round-trips through the reader, and leaves the master bytes unchanged", async () => {
  await withRoot(async (root) => {
    const withIndex = join(root, "with");
    const without = join(root, "without");
    const urlsA: string[] = [];
    const urlsB: string[] = [];
    const a = await refreshUniverse(provider(urlsA), new MarketStorage(withIndex), "2026-10-05");
    // Same replies through a provider with no capture (the master build before this commit).
    const plain = provider(urlsB);
    const b = await refreshUniverse(
      { providerName: plain.providerName, listApprovedSecurities: (o?: Parameters<MassiveMarketProvider["listApprovedSecurities"]>[0]) => plain.listApprovedSecurities(o) } as never,
      new MarketStorage(without),
      "2026-10-05",
    );
    assert.equal(urlsA.length, 3);
    assert.deepEqual(urlsA, urlsB);
    assert.deepEqual(
      await readFile(join(withIndex, "permanent", "security-master.json")),
      await readFile(join(without, "permanent", "security-master.json")),
    );
    assert.deepEqual(
      await readFile(join(withIndex, "permanent", "universe-membership.jsonl")),
      await readFile(join(without, "permanent", "universe-membership.jsonl")),
    );
    assert.deepEqual(a.securities, b.securities);
    assert.deepEqual(a.tickerReferenceIndex, { pages: { active: 2, inactive: 1 }, records: { active: 4, inactive: 2 } });
    assert.equal(a.warnings, undefined);
    assert.equal(b.tickerReferenceIndex, undefined);
    const loaded = (await new MarketStorage(withIndex).loadTickerReferenceIndex())!;
    assert.deepEqual(loaded.entries.map((e) => e.raw), ALL_RAW);
    for (const entry of loaded.entries) assert.deepEqual(JSON.parse(entry.raw), JSON.parse(ALL_RAW[loaded.entries.indexOf(entry)]!));
    assert.equal(loaded.manifest.asOf, "2026-10-05");
    assert.equal(await new MarketStorage(without).loadTickerReferenceIndex(), undefined);
  });
});

test("object storage: written and read back under permanent/, reader rejects tampering", async () => {
  const client = new MemoryObjectClient();
  const urls: string[] = [];
  await refreshUniverse(provider(urls), new ObjectMarketStorage(client), "2026-10-05");
  const committed = JSON.parse(new TextDecoder().decode(await client.get(TICKER_REFERENCE_INDEX_MANIFEST_KEY)));
  assert.equal(committed.base.key, `permanent/ticker-reference-index/base-2026-10-05-${committed.bodySha256}.jsonl.zst`);
  assert.ok(await client.get(committed.base.key));
  assert.ok(await client.get(TICKER_REFERENCE_INDEX_MANIFEST_KEY));
  const loaded = (await new ObjectMarketStorage(client).loadTickerReferenceIndex())!;
  assert.equal(loaded.entries.length, 6);
  assert.deepEqual(loaded.entries.map((e) => e.raw), ALL_RAW);
  // A tampered manifest is refused.
  const manifest = JSON.parse(new TextDecoder().decode(await client.get(TICKER_REFERENCE_INDEX_MANIFEST_KEY)));
  const tampered = new MemoryObjectClient();
  await tampered.put(manifest.base.key, (await client.get(manifest.base.key))!);
  await tampered.put(TICKER_REFERENCE_INDEX_MANIFEST_KEY, new TextEncoder().encode(JSON.stringify({ ...manifest, records: { active: 5, inactive: 2 } })));
  await assert.rejects(loadTickerReferenceIndex(tampered), /TICKER_REFERENCE_INDEX_MANIFEST_INVALID/);
  // A convenience field that disagrees with its raw record is refused.
  const lines = new TextDecoder().decode(loaded.body).split("\n");
  lines[1] = lines[1]!.replace('"type":"WARRANT"', '"type":"CS"');
  assert.throws(() => parseTickerReferenceBody(new TextEncoder().encode(lines.join("\n"))), /TICKER_REFERENCE_INDEX_ENTRY_INVALID:2/);
  assert.equal(await loadTickerReferenceIndex(new MemoryObjectClient()), undefined);
});

// ---- base + delta ----

/** A capture from [pass, raw] records, split into pages of pageSize per pass. */
function captureOf(records: Array<[TickerReferencePass, string]>, pageSize = 3): TickerReferenceCapture {
  const entries: ReturnType<typeof tickerReferenceEntry>[] = [];
  const pages = { active: 0, inactive: 0 };
  for (const pass of ["active", "inactive"] as const) {
    const list = records.filter(([p]) => p === pass);
    list.forEach(([, raw], i) => entries.push(tickerReferenceEntry(pass, Math.floor(i / pageSize) + 1, i % pageSize, raw)));
    pages[pass] = Math.ceil(list.length / pageSize);
  }
  return { pages, entries };
}
const rec = (ticker: string, type: string, extra: object = {}) => JSON.stringify({ ticker, type, market: "stocks", ...extra });
const DAY1: Array<[TickerReferencePass, string]> = [
  ["active", rec("AAA", "CS")],
  ["active", rec("BBB", "CS")],
  ["active", rec("CCC", "ETF")],
  ["active", rec("DDD", "CS")],
  ["inactive", rec("REUS", "WARRANT", { active: false, delisted_utc: "2021-06-30T00:00:00Z", composite_figi: "OLD" })],
  ["inactive", rec("ZZZ", "CS", { active: false })],
];

/** Store whose puts fail while failing() is true (the build fails after reading the manifest). */
function flakyStore(failing: () => boolean) {
  const inner = new MemoryObjectClient();
  return {
    inner,
    get: (key: string) => inner.get(key),
    put: async (key: string, body: Uint8Array) => {
      if (failing()) throw new Error("R2_PUT_FAILED:503");
      return inner.put(key, body);
    },
  };
}

async function deltaOf(store: { get(key: string): Promise<Uint8Array | undefined> }, key: string): Promise<TickerReferenceDelta> {
  return JSON.parse(new TextDecoder().decode(nodeReplyDustBackend.decompress((await store.get(key))!, null)));
}

test("delta: identity is the record hash, order is kept, duplicates and reused tickers survive, rebuild is exact", async () => {
  const store = new MemoryObjectClient();
  const first = await writeTickerReferenceIndex(store, captureOf(DAY1), { provider: "massive-stocks", asOf: "2026-10-05" });
  assert.equal(first.wrote, "BASE");
  // Day 2: a record inserted at the front (every position shifts), BBB dropped, an exact
  // duplicate of CCC, and a reused ticker (new CS REUS next to the old inactive warrant).
  const day2: Array<[TickerReferencePass, string]> = [
    ["active", rec("AAA0", "WARRANT")],
    ["active", rec("AAA", "CS")],
    ["active", rec("CCC", "ETF")],
    ["active", rec("CCC", "ETF")],
    ["active", rec("DDD", "CS")],
    ["active", rec("REUS", "CS", { composite_figi: "NEW" })],
    ...DAY1.filter(([p]) => p === "inactive"),
  ];
  const second = await writeTickerReferenceIndex(store, captureOf(day2), { provider: "massive-stocks", asOf: "2026-10-06" });
  assert.equal(second.wrote, "DELTA");
  assert.equal(second.base.asOf, "2026-10-05");
  assert.equal(second.deltas.length, 1);
  const delta = await deltaOf(store, second.deltas[0]!.key);
  // Only the new records' raw text travels; the duplicate CCC is a second occurrence by hash.
  assert.deepEqual(delta.records.map(([, pass, raw]) => [pass, raw]), [
    ["active", rec("AAA0", "WARRANT")],
    ["active", rec("REUS", "CS", { composite_figi: "NEW" })],
  ]);
  assert.equal(delta.fromBodySha256, first.bodySha256);
  const loaded = (await loadTickerReferenceIndex(store))!;
  assert.deepEqual(loaded.entries.map((e) => [e.pass, e.raw]), day2);
  assert.deepEqual(loaded.entries.map((e) => [e.page, e.position]), [[1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2], [1, 0], [1, 1]]);
  assert.equal(createHash("sha256").update(loaded.body).digest("hex"), second.bodySha256);
  // Byte for byte the same body a full snapshot of day 2 would store.
  const fresh = new MemoryObjectClient();
  await writeTickerReferenceIndex(fresh, captureOf(day2), { provider: "massive-stocks", asOf: "2026-10-06" });
  assert.deepEqual((await loadTickerReferenceIndex(fresh))!.body, loaded.body);
  const reus = loaded.entries.filter((e) => e.ticker === "REUS");
  assert.deepEqual(reus.map((e) => [e.type, e.composite_figi]), [["CS", "NEW"], ["WARRANT", "OLD"]]);
});

test("delta base: day 2's write fails, day 3's delta applies to day 1's committed index and rebuilds day 3 exactly", async () => {
  let failing = false;
  const store = flakyStore(() => failing);
  await writeTickerReferenceIndex(store, captureOf(DAY1), { provider: "massive-stocks", asOf: "2026-10-05" });
  const day1Manifest = JSON.parse(new TextDecoder().decode(await store.get(TICKER_REFERENCE_INDEX_MANIFEST_KEY)));
  failing = true;
  const day2: Array<[TickerReferencePass, string]> = [["active", rec("NEW2", "UNIT")], ...DAY1];
  await assert.rejects(
    writeTickerReferenceIndex(store, captureOf(day2), { provider: "massive-stocks", asOf: "2026-10-06" }),
    /R2_PUT_FAILED/,
  );
  failing = false;
  const day3: Array<[TickerReferencePass, string]> = [["active", rec("NEW2", "UNIT")], ...DAY1.slice(1), ["active", rec("NEW3", "CS")]];
  const third = await writeTickerReferenceIndex(store, captureOf(day3), { provider: "massive-stocks", asOf: "2026-10-07" });
  assert.equal(third.wrote, "DELTA");
  assert.equal(third.deltas.length, 1);
  const deltaBytes = nodeReplyDustBackend.decompress((await store.get(third.deltas[0]!.key))!, null);
  assert.equal(
    third.deltas[0]!.key,
    `permanent/ticker-reference-index/delta-2026-10-07-001-${createHash("sha256").update(deltaBytes).digest("hex")}.json.zst`,
  );
  const delta = await deltaOf(store, third.deltas[0]!.key);
  // Covers both days: against day 1's committed body, with day 2's new record included.
  assert.equal(delta.fromBodySha256, day1Manifest.bodySha256);
  assert.deepEqual(delta.records.map(([, , raw]) => raw).sort(), [rec("NEW2", "UNIT"), rec("NEW3", "CS")].sort());
  const loaded = (await loadTickerReferenceIndex(store))!;
  assert.deepEqual(loaded.entries.map((e) => [e.pass, e.raw]), [
    ...day3.filter(([p]) => p === "active"),
    ...day3.filter(([p]) => p === "inactive"),
  ]);
  assert.equal(createHash("sha256").update(loaded.body).digest("hex"), third.bodySha256);
});

test("month snapshot: a failure on the 1st, then success on the 2nd writes the full snapshot", async () => {
  let failing = false;
  const store = flakyStore(() => failing);
  await writeTickerReferenceIndex(store, captureOf(DAY1), { provider: "massive-stocks", asOf: "2026-10-30" });
  const oct31 = await writeTickerReferenceIndex(store, captureOf(DAY1), { provider: "massive-stocks", asOf: "2026-10-31" });
  assert.equal(oct31.wrote, "DELTA");
  failing = true;
  await assert.rejects(writeTickerReferenceIndex(store, captureOf(DAY1), { provider: "massive-stocks", asOf: "2026-11-01" }));
  failing = false;
  const nov2 = await writeTickerReferenceIndex(store, captureOf(DAY1.slice(1)), { provider: "massive-stocks", asOf: "2026-11-02" });
  assert.equal(nov2.wrote, "BASE");
  assert.equal(nov2.baseReason, "BASE_NOT_THIS_MONTH");
  assert.equal(nov2.base.key, `permanent/ticker-reference-index/base-2026-11-02-${nov2.bodySha256}.jsonl.zst`);
  assert.deepEqual(nov2.deltas, []);
  // October's committed objects are untouched.
  assert.equal((await store.inner.list("permanent/ticker-reference-index/base-2026-10-30-")).length, 1);
  const nov3 = await writeTickerReferenceIndex(store, captureOf(DAY1), { provider: "massive-stocks", asOf: "2026-11-03" });
  assert.equal(nov3.wrote, "DELTA");
  assert.deepEqual((await loadTickerReferenceIndex(store))!.entries.map((e) => e.raw), DAY1.map(([, raw]) => raw));
});

test("content-hash keys: a same-day full snapshot after an unreadable delta never overwrites the committed base", async () => {
  // Reads of delta objects can be made to return corrupt bytes; manifest puts can be made to fail.
  let corruptDeltas = false;
  let failManifest = false;
  const inner = new MemoryObjectClient();
  const store = {
    get: async (key: string) => {
      const bytes = await inner.get(key);
      return corruptDeltas && bytes && key.includes("/delta-") ? Uint8Array.from(bytes, (b, i) => (i === 8 ? b ^ 0xff : b)) : bytes;
    },
    put: async (key: string, body: Uint8Array) => {
      if (failManifest && key === TICKER_REFERENCE_INDEX_MANIFEST_KEY) throw new Error("R2_PUT_FAILED:503");
      return inner.put(key, body);
    },
  };
  const D = "2026-10-06";
  const base = await writeTickerReferenceIndex(store, captureOf(DAY1), { provider: "massive-stocks", asOf: D });
  const baseBytes = (await inner.get(base.base.key))!;
  // Same-session retry with one new record: a delta on the same date.
  const plusOne: Array<[TickerReferencePass, string]> = [...DAY1, ["active", rec("EEE", "CS")]];
  const retry = await writeTickerReferenceIndex(store, captureOf(plusOne), { provider: "massive-stocks", asOf: D });
  assert.equal(retry.wrote, "DELTA");
  const earlierManifest = (await inner.get(TICKER_REFERENCE_INDEX_MANIFEST_KEY))!;
  // A third same-day build cannot read the delta: it writes a full snapshot, but its manifest
  // does not land. The committed base is byte-identical, and the earlier manifest still loads.
  corruptDeltas = true;
  failManifest = true;
  const plusTwo: Array<[TickerReferencePass, string]> = [...plusOne, ["active", rec("FFF", "CS")]];
  await assert.rejects(writeTickerReferenceIndex(store, captureOf(plusTwo), { provider: "massive-stocks", asOf: D }), /R2_PUT_FAILED/);
  corruptDeltas = false;
  failManifest = false;
  assert.deepEqual(await inner.get(base.base.key), baseBytes);
  assert.deepEqual(await inner.get(TICKER_REFERENCE_INDEX_MANIFEST_KEY), earlierManifest);
  assert.deepEqual((await loadTickerReferenceIndex(store))!.entries.map((e) => e.raw).sort(), plusOne.map(([, r]) => r).sort());
  assert.equal((await inner.list(`permanent/ticker-reference-index/base-${D}-`)).length, 2);
  // Now it lands: a new base under its own hash key; the original base is still untouched.
  corruptDeltas = true;
  const full = await writeTickerReferenceIndex(store, captureOf(plusTwo), { provider: "massive-stocks", asOf: D });
  corruptDeltas = false;
  assert.equal(full.wrote, "BASE");
  assert.match(full.baseReason ?? "", /^COMMITTED_INDEX_UNREADABLE:/);
  assert.notEqual(full.base.key, base.base.key);
  assert.deepEqual(await inner.get(base.base.key), baseBytes);
  assert.deepEqual((await loadTickerReferenceIndex(store))!.entries.map((e) => e.raw).sort(), plusTwo.map(([, r]) => r).sort());
  // The landed base reused the identical object the failed attempt left: still two bases.
  assert.equal((await inner.list(`permanent/ticker-reference-index/base-${D}-`)).length, 2);
});

test("content-hash keys: an existing key with different bytes is a conflict and is never overwritten", async () => {
  const store = new MemoryObjectClient();
  const probe = new MemoryObjectClient();
  const planned = await writeTickerReferenceIndex(probe, captureOf(DAY1), { provider: "massive-stocks", asOf: "2026-10-06" });
  const junk = new Uint8Array([1, 2, 3]);
  await store.put(planned.base.key, junk);
  await assert.rejects(
    writeTickerReferenceIndex(store, captureOf(DAY1), { provider: "massive-stocks", asOf: "2026-10-06" }),
    /TICKER_REFERENCE_INDEX_OBJECT_CONFLICT/,
  );
  assert.deepEqual(await store.get(planned.base.key), junk);
  assert.equal(await store.get(TICKER_REFERENCE_INDEX_MANIFEST_KEY), undefined);
});

test("a failed index write is a warning: the master build still succeeds", async () => {
  await withRoot(async (root) => {
    const storage = new MarketStorage(root);
    storage.saveTickerReferenceIndex = async () => {
      throw new Error("R2_PUT_FAILED:503");
    };
    const urls: string[] = [];
    const result = await refreshUniverse(provider(urls), storage, "2026-10-05");
    assert.deepEqual(result.warnings, ["TICKER_REFERENCE_INDEX_WRITE_FAILED:R2_PUT_FAILED:503"]);
    assert.equal(result.tickerReferenceIndex, undefined);
    assert.equal((await storage.loadSecurities()).length, 3);
  });
});
