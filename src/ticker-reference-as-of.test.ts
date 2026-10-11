import assert from "node:assert/strict";
import test from "node:test";
import { MemoryObjectClient } from "./object-store";
import {
  StoreReadIntegrityError,
  TICKER_INDEX_AS_OF_CORRUPT,
  TICKER_INDEX_AS_OF_FAILED,
  TickerIndexAsOfCorruptError,
  TickerIndexAsOfFailedError,
  isIntegrityStoreReadError,
  isTransientStoreReadError,
  loadTickerReferenceIndexAsOf,
} from "./ticker-reference-as-of";
import {
  TICKER_REFERENCE_INDEX_MANIFEST_KEY,
  type TickerReferenceCapture,
  listTickerReferenceIndexHistory,
  loadTickerReferenceIndexFromManifest,
  tickerReferenceEntry,
  writeTickerReferenceIndex,
} from "./ticker-reference-index";

const D = "2024-11-04";

function capture(rows: Array<{ ticker: string; type: string; active?: boolean }>): TickerReferenceCapture {
  const active: ReturnType<typeof tickerReferenceEntry>[] = [];
  const inactive: ReturnType<typeof tickerReferenceEntry>[] = [];
  for (const row of rows) {
    const raw = JSON.stringify({
      ticker: row.ticker,
      type: row.type,
      active: row.active !== false,
      market: "stocks",
      locale: "us",
      primary_exchange: "XNAS",
    });
    if (row.active === false) {
      inactive.push(tickerReferenceEntry("inactive", 1, inactive.length, raw));
    } else {
      active.push(tickerReferenceEntry("active", 1, active.length, raw));
    }
  }
  return {
    pages: { active: active.length ? 1 : 0, inactive: inactive.length ? 1 : 0 },
    entries: [...active, ...inactive],
  };
}

async function plantIndex(
  store: MemoryObjectClient,
  asOf: string,
  rows: Array<{ ticker: string; type: string; active?: boolean }>,
) {
  return writeTickerReferenceIndex(store, capture(rows), {
    provider: "massive-stocks",
    asOf,
  });
}

const UNIVERSE = [
  { ticker: "SPY", type: "ETF" },
  { ticker: "QQQ", type: "ETF" },
  { ticker: "AAA", type: "CS" },
  { ticker: "BBB", type: "CS" },
  { ticker: "CCC", type: "CS" },
  { ticker: "DDD", type: "CS" },
  { ticker: "EEE", type: "CS" },
  { ticker: "FFF", type: "CS" },
  { ticker: "GGG", type: "CS" },
  { ticker: "HHH", type: "CS" },
  { ticker: "III", type: "CS" },
  { ticker: "JJJ", type: "CS" },
  { ticker: "OLDX", type: "CS", active: false as const }, // delisted, still in index
];

test("loadTickerReferenceIndexAsOf: newest ≤D broken → CORRUPT; older index never used", async () => {
  const store = new MemoryObjectClient();
  const olderAsOf = "2024-10-15";
  await plantIndex(store, olderAsOf, [
    { ticker: "SPY", type: "ETF" },
    { ticker: "QQQ", type: "ETF" },
    { ticker: "OLDONLY", type: "CS" },
  ]);
  await plantIndex(store, D, UNIVERSE);

  const history = await listTickerReferenceIndexHistory(store);
  assert.ok(history.length >= 2);
  assert.equal(history[0]!.key, TICKER_REFERENCE_INDEX_MANIFEST_KEY);
  assert.equal(history[0]!.manifest!.asOf, D);
  const older = history[1]!;
  assert.ok(older.verified && older.manifest);
  assert.equal(older.manifest!.asOf, olderAsOf);
  const olderLoaded = await loadTickerReferenceIndexFromManifest(store, older.manifest!);
  assert.ok(olderLoaded.entries.some((e) => e.ticker === "OLDONLY"));

  const baseKey = history[0]!.manifest!.base.key;
  await store.delete(baseKey);

  await assert.rejects(
    () => loadTickerReferenceIndexAsOf(store, D),
    (e: unknown) =>
      e instanceof TickerIndexAsOfCorruptError &&
      e.key === TICKER_REFERENCE_INDEX_MANIFEST_KEY &&
      e.message.startsWith(`${TICKER_INDEX_AS_OF_CORRUPT}:`),
  );

});

test("loadTickerReferenceIndexAsOf: transient read on newest ≤D → FAILED; older unused", async () => {
  const inner = new MemoryObjectClient();
  const olderAsOf = "2024-10-15";
  await plantIndex(inner, olderAsOf, [
    { ticker: "SPY", type: "ETF" },
    { ticker: "QQQ", type: "ETF" },
    { ticker: "OLDONLY", type: "CS" },
  ]);
  await plantIndex(inner, D, UNIVERSE);

  const history = await listTickerReferenceIndexHistory(inner);
  const baseKey = history[0]!.manifest!.base.key;
  const olderManifest = history[1]!.manifest!;
  assert.ok(olderManifest);

  const flaky = {
    async get(key: string) {
      if (key === baseKey) throw new Error("ETIMEDOUT");
      return inner.get(key);
    },
    async put(key: string, body: Uint8Array, metadata?: object) {
      return inner.put(key, body, metadata as never);
    },
    async head(key: string) {
      return inner.head(key);
    },
    async delete(key: string) {
      return inner.delete(key);
    },
    async list(prefix: string) {
      return inner.list(prefix);
    },
  };

  await assert.rejects(
    () => loadTickerReferenceIndexAsOf(flaky, D),
    (e: unknown) =>
      e instanceof TickerIndexAsOfFailedError &&
      e.key === TICKER_REFERENCE_INDEX_MANIFEST_KEY &&
      e.message.startsWith(`${TICKER_INDEX_AS_OF_FAILED}:`) &&
      e.message.includes("ETIMEDOUT"),
  );

  const olderLoaded = await loadTickerReferenceIndexFromManifest(inner, olderManifest);
  assert.ok(olderLoaded.entries.some((e) => e.ticker === "OLDONLY"));

});

test("isTransientStoreReadError: inverted — only clear integrity is non-transient", () => {
  // Auditor cases: R2_ + timeout → FAILED (transient); integrity-in-cause → CORRUPT;
  // status 500 → FAILED; plain unknown → FAILED.
  const r2Timeout = new Error("R2_GET timed out waiting for upstream");
  assert.equal(isTransientStoreReadError(r2Timeout), true);
  assert.equal(isIntegrityStoreReadError(r2Timeout), false);

  const wrappedChecksum = new Error("store get failed", {
    cause: new Error("REPLY_DUST_MANIFEST_CHECKSUM_MISMATCH"),
  });
  assert.equal(isIntegrityStoreReadError(wrappedChecksum), true);
  assert.equal(isTransientStoreReadError(wrappedChecksum), false);

  const typedWrapped = new Error("wrapper", {
    cause: new StoreReadIntegrityError("REPLY_DUST_FILE_CHECKSUM_MISMATCH"),
  });
  assert.equal(isIntegrityStoreReadError(typedWrapped), true);

  const status500 = Object.assign(new Error("upstream"), { status: 500 });
  assert.equal(isTransientStoreReadError(status500), true);
  assert.equal(isIntegrityStoreReadError(status500), false);

  assert.equal(isTransientStoreReadError(new Error("something")), true);
  assert.equal(isIntegrityStoreReadError(new Error("something")), false);

  // Transient table (must be true / not integrity).
  const transientCases: unknown[] = [
    new Error("R2_GET_500"),
    new Error("R2_HEAD_503"),
    new Error("R2_GET_429"),
    new Error("SlowDown"),
    new Error("ETIMEDOUT"),
    Object.assign(new Error("aborted"), { name: "AbortError" }),
    Object.assign(new Error("reset"), { code: "ECONNRESET" }),
    new Error("fetch failed"),
    Object.assign(new Error("connect"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
    new Error("R2_LIST_TRUNCATED_WITHOUT_TOKEN"),
    new Error("R2_CONFIG_REQUIRED"),
  ];
  for (const err of transientCases) {
    assert.equal(
      isTransientStoreReadError(err),
      true,
      `expected transient: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Integrity table (must be false for transient / true for integrity).
  const integrityCases: unknown[] = [
    new Error("REPLY_DUST_MANIFEST_CHECKSUM_MISMATCH"),
    new Error("REPLY_DUST_FILE_CHECKSUM_MISMATCH:grouped-daily:2024-11-04"),
    new Error("REPLY_DUST_VERSION_UNSUPPORTED:99"),
    new Error("REPLY_DUST_ZSTD_FAILED"),
    new Error("TICKER_REFERENCE_INDEX_BODY_MISMATCH:base"),
    new Error("TICKER_REFERENCE_INDEX_FILE_MISMATCH:permanent/x"),
    new Error("TICKER_REFERENCE_INDEX_ARCHIVE_SHA_MISMATCH:permanent/y"),
    new Error("TICKER_REFERENCE_INDEX_MANIFEST_INVALID"),
    new Error("TICKER_REFERENCE_INDEX_ARCHIVE_MISSING:permanent/archive.json"),
    new Error("TICKER_REFERENCE_INDEX_HISTORY_LOOP:permanent/archive.json"),
    new Error("TICKER_REFERENCE_DELTA_UNKNOWN_RECORD"),
    new Error("REPLY_DUST_FILE_MISSING:grouped-daily:2024-11-04"),
    new SyntaxError("Unexpected token } in JSON at position 0"),
    new StoreReadIntegrityError("REPLY_DUST_HASH_MISMATCH"),
    // R2-prefixed wrapper must not hide integrity in cause:
    new Error("R2_GET_200 body invalid", {
      cause: new Error("TICKER_REFERENCE_INDEX_BODY_MISMATCH"),
    }),
  ];
  for (const err of integrityCases) {
    assert.equal(
      isIntegrityStoreReadError(err),
      true,
      `expected integrity: ${err instanceof Error ? err.message : String(err)}`,
    );
    assert.equal(isTransientStoreReadError(err), false);
  }

  // Each new code: direct + wrapped in cause → integrity (CORRUPT).
  for (const code of [
    "TICKER_REFERENCE_INDEX_ARCHIVE_MISSING",
    "TICKER_REFERENCE_INDEX_HISTORY_LOOP",
    "TICKER_REFERENCE_DELTA_UNKNOWN_RECORD",
    "REPLY_DUST_FILE_MISSING",
  ]) {
    const direct = new Error(`${code}:detail`);
    assert.equal(isIntegrityStoreReadError(direct), true, code);
    assert.equal(isTransientStoreReadError(direct), false, code);
    const wrapped = new Error("wrap", { cause: new Error(`${code}:via-cause`) });
    assert.equal(isIntegrityStoreReadError(wrapped), true, `${code} cause`);
    assert.equal(isTransientStoreReadError(wrapped), false, `${code} cause`);
  }
});

test("isTransientStoreReadError: zstd environment codes stay FAILED (not integrity)", () => {
  // Decode failures stay integrity; missing/wrong-version/unavailable CLI are env → FAILED.
  assert.equal(isIntegrityStoreReadError(new Error("REPLY_DUST_ZSTD_MAGIC")), true);
  assert.equal(isIntegrityStoreReadError(new Error("REPLY_DUST_ZSTD_FAILED")), true);

  const envCases = [
    new Error("REPLY_DUST_ZSTD_MISSING"),
    new Error("REPLY_DUST_ZSTD_VERSION:1.5.8"),
    new Error("REPLY_DUST_ZSTD_UNAVAILABLE"),
  ];
  for (const err of envCases) {
    assert.equal(isIntegrityStoreReadError(err), false, err.message);
    assert.equal(isTransientStoreReadError(err), true, err.message);
  }
});
