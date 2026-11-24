// File store appendBars: the prior-revision lookup is indexed once per month (was a scan of
// existing + incoming for every incoming record: O(month x incoming) per session).
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalDailyBar } from "./contracts";
import { MarketStorage } from "./storage";

const bar = (id: string, date: string, revision: number, close: number): CanonicalDailyBar =>
  ({ securityId: id, sessionDate: date, open: close, high: close, low: close, close, volume: 1, revision,
    observedAt: `${date}T22:00:00.000Z`, ingestedAt: `${date}T22:0${revision}:00.000Z`, dataQuality: "GOOD",
    corporateActionIds: [], flags: [], schemaVersion: "x",
    provenance: { provider: "p", dataset: "d", retrievalId: `r${revision}`, ingestionVersion: "v", normalizerVersion: "n" } }) as unknown as CanonicalDailyBar;

async function withStore(run: (storage: MarketStorage, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "ps-append-"));
  try {
    const storage = new MarketStorage(dir);
    await storage.initialize();
    await run(storage, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("corrections and month file are unchanged: revisions found in stored and incoming rows", async () => {
  await withStore(async (storage, dir) => {
    await storage.appendBars([bar("sec_a", "2026-11-02", 1, 10), bar("sec_b", "2026-11-02", 1, 20), bar("sec_c", "2026-10-30", 1, 5)]);
    // a: rev 2 over a stored rev 1; d: rev 1 and rev 2 both incoming; b: rev 3 with no rev 2 (no correction);
    // c: previous month, rev 2.
    await storage.appendBars([
      bar("sec_a", "2026-11-02", 2, 11), bar("sec_d", "2026-11-03", 2, 31), bar("sec_d", "2026-11-03", 1, 30),
      bar("sec_b", "2026-11-02", 3, 22), bar("sec_c", "2026-10-30", 2, 6),
    ]);
    const corrections = (await readFile(join(dir, "permanent", "corrections.jsonl"), "utf8").catch(() => ""))
      .split("\n").filter(Boolean).map((l) => JSON.parse(l) as { correctionId: string; supersedesRevision: number; correctedAt: string });
    assert.deepEqual(corrections.map((c) => [c.correctionId, c.supersedesRevision, c.correctedAt]).sort(), [
      ["sec_a|2026-11-02|2", 1, "2026-11-02T22:02:00.000Z"],
      ["sec_c|2026-10-30|2", 1, "2026-10-30T22:02:00.000Z"],
      ["sec_d|2026-11-03|2", 1, "2026-11-03T22:02:00.000Z"],
    ]);
    const nov = (await readFile(join(dir, "permanent", "daily-bars", "2026-11.jsonl"), "utf8")).trim().split("\n");
    assert.equal(nov.length, 6);
  });
});

test("appendBars reads each incoming row's securityId a bounded number of times", async () => {
  await withStore(async (storage) => {
    const days = ["2026-11-02", "2026-11-03"];
    await storage.appendBars(Array.from({ length: 3_000 }, (_, i) => bar(`sec_${i}`, days[0]!, 1, i)));
    let reads = 0;
    const incoming = Array.from({ length: 3_000 }, (_, i) => {
      const row = { ...bar(`sec_${i}`, days[1]!, 1, i) } as Record<string, unknown>;
      const id = row.securityId;
      Object.defineProperty(row, "securityId", { enumerable: true, get: () => (reads++, id) });
      return row as unknown as CanonicalDailyBar;
    });
    await storage.appendBars(incoming);
    // The month sort and write still read it O(log n) times per row; the old lookup read it O(n) times.
    const bound = 4 * incoming.length * Math.ceil(Math.log2(2 * incoming.length));
    assert.ok(reads <= bound, `securityId reads=${reads} for ${incoming.length} rows (bound ${bound})`);
  });
});
