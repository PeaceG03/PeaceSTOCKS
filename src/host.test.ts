import assert from "node:assert/strict";
import test from "node:test";
import { findMissedEligibleSessions } from "./host";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

test("scheduler host catches up eligible sessions but skips weekends and NYSE holidays", () => {
  const missed = findMissedEligibleSessions(
    "2026-07-02",
    "2026-07-06",
    new Set(["2026-07-02"]),
    US_EQUITY_MARKET_CALENDAR,
  );
  assert.deepEqual(missed, ["2026-07-06"]);
});

test("scheduler host does not requeue completed sessions", () => {
  const missed = findMissedEligibleSessions(
    "2026-08-25",
    "2026-08-26",
    new Set(["2026-08-25", "2026-08-26"]),
    US_EQUITY_MARKET_CALENDAR,
  );
  assert.deepEqual(missed, []);
});

test("scheduler host catch-up excludes the current session before close", () => {
  const missed = findMissedEligibleSessions(
    "2026-08-30",
    "2026-08-31",
    new Set(),
    US_EQUITY_MARKET_CALENDAR,
  );
  assert.deepEqual(missed, ["2026-08-31"]);
});
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScannerHost } from "./host";
import { MassiveMarketProvider } from "./massive-provider";

test("scheduler cursor stays before a provider-not-ready session", async () => {
  const root = await mkdtemp(join(tmpdir(), "peacestocks-host-"));
  const previous = process.env.MASSIVE_API_KEY;
  const previousBucket = process.env.PEACESTOCKS_R2_BUCKET;
  process.env.MASSIVE_API_KEY = "test-key";
  delete process.env.PEACESTOCKS_R2_BUCKET;
  try {
    const provider = new MassiveMarketProvider({
      apiKey: "test-key",
      minRequestIntervalMs: 0,
      retryBackoffMs: 0,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ message: "Attempted to request today's data before end of day" }),
          { status: 403 },
        ),
    });
    // 05:00Z on Jan 23 = 00:00 ET Jan 23 → collectionDue targets prior ET day 2026-01-22.
    const result = await runScannerHost({
      now: new Date("2026-01-23T05:00:00.000Z"),
      storageRoot: root,
      provider,
      completionDelayMinutes: 30,
    });
    assert.equal(result.status, "NOT_READY");
    assert.equal(result.reason, "PROVIDER_NOT_READY");
    const state = JSON.parse(await readFile(join(root, "scheduler-host-state.json"), "utf8")) as {
      lastObservedSessionDate: string;
    };
    // Cursor stays before the NOT_READY session (2026-01-22).
    assert.equal(state.lastObservedSessionDate, "2026-01-21");
  } finally {
    if (previous === undefined) delete process.env.MASSIVE_API_KEY;
    else process.env.MASSIVE_API_KEY = previous;
    if (previousBucket === undefined) delete process.env.PEACESTOCKS_R2_BUCKET;
    else process.env.PEACESTOCKS_R2_BUCKET = previousBucket;
    await rm(root, { recursive: true, force: true });
  }
});

test("online host refuses to start when the object store bucket is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "peacestocks-host-"));
  const previousKey = process.env.MASSIVE_API_KEY;
  const previousRequire = process.env.PEACESTOCKS_REQUIRE_OBJECT_STORE;
  const previousBucket = process.env.PEACESTOCKS_R2_BUCKET;
  process.env.MASSIVE_API_KEY = "test-key";
  process.env.PEACESTOCKS_REQUIRE_OBJECT_STORE = "1";
  delete process.env.PEACESTOCKS_R2_BUCKET;
  try {
    await assert.rejects(
      () => runScannerHost({ now: new Date("2026-01-22T21:45:00.000Z"), storageRoot: root }),
      /OBJECT_STORE_REQUIRED/,
    );
    const names = await readdir(root);
    assert.equal(names.includes("scheduler-host-state.json"), false);
    assert.equal(names.includes("scheduler-host-runs"), false);
  } finally {
    if (previousKey === undefined) delete process.env.MASSIVE_API_KEY;
    else process.env.MASSIVE_API_KEY = previousKey;
    if (previousRequire === undefined) delete process.env.PEACESTOCKS_REQUIRE_OBJECT_STORE;
    else process.env.PEACESTOCKS_REQUIRE_OBJECT_STORE = previousRequire;
    if (previousBucket === undefined) delete process.env.PEACESTOCKS_R2_BUCKET;
    else process.env.PEACESTOCKS_R2_BUCKET = previousBucket;
    await rm(root, { recursive: true, force: true });
  }
});

test("failed evidence does not move the scheduler cursor forward", async () => {
  const root = await mkdtemp(join(tmpdir(), "peacestocks-host-"));
  const previous = process.env.MASSIVE_API_KEY;
  const previousBucket = process.env.PEACESTOCKS_R2_BUCKET;
  process.env.MASSIVE_API_KEY = "test-key";
  delete process.env.PEACESTOCKS_R2_BUCKET;
  const seeded = {
    schemaVersion: "peaceai-markets-scheduler-host:v1",
    forwardClockStartedAt: "2026-01-20T21:45:00.000Z",
    lastObservedSessionDate: "2026-01-20",
  };
  await import("node:fs/promises").then(({ writeFile, mkdir }) =>
    mkdir(root, { recursive: true }).then(() =>
      writeFile(join(root, "scheduler-host-state.json"), `${JSON.stringify(seeded, null, 2)}\n`),
    ),
  );
  try {
    const provider = new MassiveMarketProvider({
      apiKey: "test-key",
      minRequestIntervalMs: 0,
      retryBackoffMs: 0,
      fetchImpl: async () => {
        throw new Error("socket hang up");
      },
    });
    const result = await runScannerHost({
      now: new Date("2026-01-22T21:45:00.000Z"),
      storageRoot: root,
      provider,
      completionDelayMinutes: 30,
    });
    assert.equal(result.status, "FAILED");
    const state = JSON.parse(await readFile(join(root, "scheduler-host-state.json"), "utf8")) as {
      lastObservedSessionDate: string;
    };
    assert.equal(state.lastObservedSessionDate, "2026-01-20");
  } finally {
    if (previous === undefined) delete process.env.MASSIVE_API_KEY;
    else process.env.MASSIVE_API_KEY = previous;
    if (previousBucket === undefined) delete process.env.PEACESTOCKS_R2_BUCKET;
    else process.env.PEACESTOCKS_R2_BUCKET = previousBucket;
    await rm(root, { recursive: true, force: true });
  }
});
