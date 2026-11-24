import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScannerHost } from "./host";
import { MassiveMarketProvider } from "./massive-provider";
import { hostFailureLine, stageTimed, type StageTracker } from "./scan-stages";

async function withHostEnv<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "peacestocks-stages-"));
  const previous = process.env.MASSIVE_API_KEY;
  const previousBucket = process.env.PEACESTOCKS_R2_BUCKET;
  process.env.MASSIVE_API_KEY = "test-key";
  delete process.env.PEACESTOCKS_R2_BUCKET;
  try {
    return await fn(root);
  } finally {
    if (previous === undefined) delete process.env.MASSIVE_API_KEY;
    else process.env.MASSIVE_API_KEY = previous;
    if (previousBucket === undefined) delete process.env.PEACESTOCKS_R2_BUCKET;
    else process.env.PEACESTOCKS_R2_BUCKET = previousBucket;
    await rm(root, { recursive: true, force: true });
  }
}

test("scan host writes a SCAN_STAGE line per storage and provider call, tagged with the session", async () => {
  await withHostEnv(async (root) => {
    const lines: string[] = [];
    const provider = new MassiveMarketProvider({
      apiKey: "test-key",
      minRequestIntervalMs: 0,
      retryBackoffMs: 0,
      fetchImpl: async () =>
        new Response(JSON.stringify({ message: "Attempted to request today's data before end of day" }), { status: 403 }),
    });
    await runScannerHost({
      now: new Date("2026-01-23T05:00:00.000Z"),
      storageRoot: root,
      provider,
      completionDelayMinutes: 30,
      stageSink: (line) => lines.push(line),
    });
    assert.ok(lines.some((l) => /^SCAN_STAGE:host:storage\.loadRunReports:\d+ms$/u.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /^SCAN_STAGE:2026-01-22:storage\.[A-Za-z]+:\d+ms$/u.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /^SCAN_STAGE:2026-01-22:provider\.[A-Za-z]+(:FAILED)?:\d+ms$/u.test(l)), lines.join("\n"));
    assert.ok(lines.every((l) => !l.includes("test-key")));
  });
});

test("a failing call names its stage with :FAILED and is recorded as the first failure", async () => {
  const lines: string[] = [];
  const tracker: StageTracker = { session: "2026-11-20" };
  let t = 0;
  const store = stageTimed(
    {
      ok: async () => 1,
      measureStorage: async () => {
        t += 30_000;
        throw new Error("R2_REQUEST_FAILED:GET:The operation was aborted due to timeout");
      },
    },
    "storage",
    tracker,
    (l) => lines.push(l),
    () => t,
  );
  assert.equal(await store.ok(), 1);
  await assert.rejects(() => store.measureStorage(), /aborted due to timeout/u);
  assert.deepEqual(lines, ["SCAN_STAGE:2026-11-20:storage.ok:0ms", "SCAN_STAGE:2026-11-20:storage.measureStorage:FAILED:30000ms"]);
  assert.deepEqual(tracker.failed, { session: "2026-11-20", stage: "storage.measureStorage", ms: 30000 });
});

test("a call still running past the slow threshold writes one :SLOW line", async () => {
  const lines: string[] = [];
  const store = stageTimed({ hang: () => new Promise((r) => setTimeout(() => r(2), 40)) }, "storage", { session: "d" }, (l) => lines.push(l), () => 0, 5);
  assert.equal(await store.hang(), 2);
  assert.deepEqual(lines, ["SCAN_STAGE:d:storage.hang:SLOW:0ms", "SCAN_STAGE:d:storage.hang:0ms"]);
});

test("host failure line carries the cause code of a timeout or socket error", () => {
  const timeout = new Error("R2_REQUEST_FAILED:GET:The operation was aborted due to timeout", {
    cause: Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }),
  });
  assert.equal(hostFailureLine(timeout), "MARKETS_SCHEDULER_HOST_FAILED:R2_REQUEST_FAILED:GET:The operation was aborted due to timeout:cause=TimeoutError");
  const socket = new Error("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
  assert.equal(hostFailureLine(socket), "MARKETS_SCHEDULER_HOST_FAILED:fetch failed:cause=UND_ERR_SOCKET");
  const dom = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  assert.equal(hostFailureLine(dom), "MARKETS_SCHEDULER_HOST_FAILED:The operation was aborted due to timeout:cause=TimeoutError");
  assert.equal(hostFailureLine("x"), "MARKETS_SCHEDULER_HOST_FAILED:UNKNOWN:cause=");
});
