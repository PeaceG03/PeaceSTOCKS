import assert from "node:assert/strict";
import test from "node:test";
import type { ScannerRunReport } from "./contracts";
import { MemoryObjectClient } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";
import { createReadWorker, type ReadOnlyBucket } from "./read-worker";

function bucket(client: MemoryObjectClient): ReadOnlyBucket {
  return {
    async get(key: string) {
      const bytes = await client.get(key);
      if (!bytes) return null;
      const copy = new Uint8Array(bytes);
      return { async arrayBuffer() { return copy.buffer; } };
    },
    async list(options: { prefix: string }) {
      const keys = await client.list(options.prefix);
      return { objects: keys.map((key) => ({ key })), truncated: false };
    },
  };
}

test("the read worker serves scanner routes and refuses writes", async () => {
  const client = new MemoryObjectClient();
  const storage = new ObjectMarketStorage(client);
  const report: ScannerRunReport = {
    runId: "run-1",
    session: { sessionDate: "2026-01-22", kind: "NORMAL", market: "US_EQUITIES", source: "test" },
    status: "COMPLETE",
    expectedSecurities: 1,
    processedSecurities: 1,
    validSecurities: 1,
    incompleteSecurities: 0,
    unresolvedFailures: [],
    storage: {
      permanentBytesToday: 1,
      cacheBytes: 0,
      transientBytesCreated: 0,
      transientBytesDeleted: 0,
      rollingMbPerDay: 0,
      projectedGbPerYear: 0,
      targetUtilizationPercent: 0,
      categoryBytes: {},
    },
    scannerVersion: "scanner-v0.1",
    sourceCommit: "abc123",
    completedAt: "2026-01-22T22:00:00.000Z",
    predictionStatus: "FROZEN",
    predictionReason: "PREDICTIONS_FROZEN",
  };
  await storage.writeRunReport(report);
  const before = await client.list("");
  const worker = createReadWorker(bucket(client));
  const health = await worker.fetch(new Request("https://read.peacestocks.local/scanner/health"));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: "COMPLETE",
    sessionDate: "2026-01-22",
    sourceCommit: "abc123",
    completedAt: "2026-01-22T22:00:00.000Z",
    predictionStatus: "FROZEN",
  });
  const denied = await worker.fetch(
    new Request("https://read.peacestocks.local/scanner/health", { method: "POST" }),
  );
  assert.equal(denied.status, 405);
  assert.deepEqual(await client.list(""), before);
});
