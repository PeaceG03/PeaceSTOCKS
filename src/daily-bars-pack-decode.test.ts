import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { CanonicalDailyBar } from "./contracts";
import { canonicalJson, decodeDailyBarsPack, monthFileFromLines } from "./daily-bars-pack-decode";
import {
  dailyBarsSidecarFileKey,
  dailyBarsSidecarManifestKey,
  writeDailyBarsSidecar,
} from "./daily-bars-sidecar";
import { stableJson } from "./identity";
import { MemoryObjectClient } from "./object-store";

// Synthetic values only (no market data).
const DAY = "2030-01-15";
const OBS = "2030-01-16T12:00:00.000Z";
function bar(id: string, i: number, extra: Partial<CanonicalDailyBar> = {}): CanonicalDailyBar {
  return {
    securityId: id, sessionDate: DAY, open: 10 + i + 0.125, high: 11 + i + 0.1, low: 9 + i + 0.3, close: 10.5 + i,
    volume: 1000 * (i + 1) + 0.5, sourceTimestamp: "2030-01-15T21:00:00.000Z", observedAt: OBS, ingestedAt: OBS,
    dataQuality: "GOOD", corporateActionIds: [], flags: ["MASSIVE_GROUPED_DAILY", "UNADJUSTED"], schemaVersion: "markets-v1" as any,
    revision: 1, provenance: { provider: "massive-stocks", dataset: "stocks-grouped-daily", retrievalId: "req-1",
      providerTimestamp: OBS, ingestionVersion: "markets-scanner-v0", normalizerVersion: "massive-v1" }, ...extra,
  };
}
const ids = ["sec_aaa", "sec_bbb", "sec_ccc", "sec_ddd"];
const symbols: Record<string, string> = { sec_aaa: "AAA", sec_bbb: "BBB", sec_ccc: "CCC", sec_ddd: "DDD" };
const rowsBase = () => ids.map((id, i) => bar(id, i));
function replyFor(rows: CanonicalDailyBar[], omit: string[] = []): Uint8Array {
  const results = rows.filter((r) => !omit.includes(r.securityId)).map((r) => ({
    T: symbols[r.securityId], o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume, vw: 1.5, n: 7,
    t: Date.parse(r.sourceTimestamp!) }));
  results.push({ T: "ZZZ", o: 1, h: 1, l: 1, c: 1, v: 1, vw: 1, n: 1, t: 0 });
  return new TextEncoder().encode(JSON.stringify({ status: "OK", request_id: "req-1", results }));
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
function dustOf(reply: Uint8Array) {
  return { replySha256: sha(reply), replyByteLength: reply.length, results: JSON.parse(new TextDecoder().decode(reply)).results };
}
async function writeAndRead(rows: CanonicalDailyBar[], reply: Uint8Array | null) {
  const store = new MemoryObjectClient();
  const result = await writeDailyBarsSidecar({ store, sessionDate: DAY, rows, dust: reply ? dustOf(reply) : null,
    symbolsFor: (id) => [symbols[id]!] });
  return { store, result, file: (await store.get(dailyBarsSidecarFileKey(DAY)))!, manifest: (await store.get(dailyBarsSidecarManifestKey(DAY)))! };
}
const expected = (rows: CanonicalDailyBar[]) => rows.map((r) => stableJson(r));

test("canonicalJson matches the stored line serializer on varied values", () => {
  for (const v of [{ b: 1, a: [3, { y: null, x: "é\u0001" }], c: 1e21, d: -0.1 + 0.2 }, [1.5, "s", true], "x", 0, null, { z: { b: 2, a: 1 } }])
    assert.equal(canonicalJson(v), stableJson(v));
});

test("round trip: Dust-bound sidecar decodes to the exact lines", async () => {
  const rows = rowsBase(); const reply = replyFor(rows);
  const { file, manifest, result } = await writeAndRead(rows, reply);
  assert.equal(result.manifest?.source, "dust");
  assert.deepEqual(decodeDailyBarsPack({ file, manifest, dustReply: reply }).lines, expected(rows));
});

test("round trip: pure pack (no Dust) and mixed (ticker missing from Dust) decode exactly", async () => {
  const rows = rowsBase(); rows[2] = bar("sec_ccc", 2); delete (rows[2] as any).sourceTimestamp;
  const pack = await writeAndRead(rows, null);
  assert.equal(pack.result.manifest?.source, "pack");
  assert.deepEqual(decodeDailyBarsPack({ file: pack.file, manifest: pack.manifest }).lines, expected(rows));
  const fullRows = rowsBase(); const reply = replyFor(fullRows, ["sec_bbb"]);
  const mixed = await writeAndRead(fullRows, reply);
  assert.equal(mixed.result.manifest?.source, "dust+pack");
  assert.equal(mixed.result.manifest?.packedRows, 1);
  assert.deepEqual(decodeDailyBarsPack({ file: mixed.file, manifest: mixed.manifest, dustReply: reply }).lines, expected(fullRows));
});

test("corrections: a value Massive later revised keeps the original daily-bars value", async () => {
  const rows = rowsBase(); const reply = replyFor(rows);
  const original = rowsBase(); original[1] = { ...original[1]!, volume: original[1]!.volume + 3 }; original[3] = { ...original[3]!, close: 99.25 };
  const { file, manifest, result } = await writeAndRead(original, reply);
  assert.equal(result.manifest?.correctionRows, 2);
  assert.deepEqual(decodeDailyBarsPack({ file, manifest, dustReply: reply }).lines, expected(original));
});

test("exceptions: per-row metadata and an absent field are reproduced", async () => {
  const rows = rowsBase();
  rows[0] = { ...rows[0]!, observedAt: "2030-01-17T00:00:00.000Z", ingestedAt: "2030-01-17T00:00:00.000Z",
    provenance: { ...rows[0]!.provenance, retrievalId: "req-2", providerTimestamp: "2030-01-17T00:00:00.000Z" } };
  rows[2] = { ...rows[2]!, flags: ["OTHER"] };
  const r3 = { ...rows[3]! } as any; delete r3.provenance.providerTimestamp; r3.provenance = { ...rows[3]!.provenance }; delete r3.provenance.providerTimestamp; rows[3] = r3;
  const reply = replyFor(rowsBase());
  const { file, manifest, result } = await writeAndRead(rows, reply);
  assert.equal(result.manifest?.exceptionRows, 3);
  assert.deepEqual(decodeDailyBarsPack({ file, manifest, dustReply: reply }).lines, expected(rows));
});

test("tamper: file, manifest, Dust reply and binding changes all fail closed", async () => {
  const rows = rowsBase(); const reply = replyFor(rows);
  const { file, manifest } = await writeAndRead(rows, reply);
  const flipped = new Uint8Array(file); flipped[flipped.length - 3]! ^= 1;
  assert.throws(() => decodeDailyBarsPack({ file: flipped, manifest, dustReply: reply }), /FILE_CHECKSUM/u);
  const m = JSON.parse(new TextDecoder().decode(manifest)); m.rows += 1;
  assert.throws(() => decodeDailyBarsPack({ file, manifest: JSON.stringify(m), dustReply: reply }), /MANIFEST_CHECKSUM/u);
  const otherReply = replyFor(rows.map((r) => ({ ...r, close: r.close + 1 })));
  assert.throws(() => decodeDailyBarsPack({ file, manifest, dustReply: otherReply }), /DUST_REPLY_CHECKSUM/u);
  assert.throws(() => decodeDailyBarsPack({ file, manifest }), /DUST_REPLY_REQUIRED/u);
  const badVersion = new Uint8Array(file); badVersion[0] = 0x22;
  assert.throws(() => decodeDailyBarsPack({ file: badVersion, manifest, dustReply: reply }), /FILE_CHECKSUM|VERSION/u);
});

test("writer never overwrites: same rows => exists-same, changed rows => exists-different, bytes unchanged", async () => {
  const rows = rowsBase(); const reply = replyFor(rows);
  const { store, file } = await writeAndRead(rows, reply);
  const same = await writeDailyBarsSidecar({ store, sessionDate: DAY, rows, dust: dustOf(reply), symbolsFor: (id) => [symbols[id]!] });
  assert.equal(same.status, "exists-same");
  const changed = await writeDailyBarsSidecar({ store, sessionDate: DAY, rows: [...rows, bar("sec_eee", 9)], dust: null });
  assert.equal(changed.status, "exists-different");
  assert.deepEqual(await store.get(dailyBarsSidecarFileKey(DAY)), file);
  const leftover = new MemoryObjectClient(); await leftover.put(dailyBarsSidecarFileKey(DAY), new Uint8Array([1]));
  const r = await writeDailyBarsSidecar({ store: leftover, sessionDate: DAY, rows, dust: null });
  assert.equal(r.status, "exists-different");
  assert.equal(await leftover.get(dailyBarsSidecarManifestKey(DAY)), undefined);
});

test("frozen fixture: committed pack bytes decode to the committed lines (format drift guard)", () => {
  const dir = new URL("./fixtures/daily-bars-sidecar/", import.meta.url);
  const file = new Uint8Array(readFileSync(new URL("sidecar.dbs", dir)));
  const manifest = readFileSync(new URL("manifest.json", dir));
  const reply = new Uint8Array(readFileSync(new URL("grouped-reply.json", dir)));
  const lines = readFileSync(new URL("lines.jsonl", dir), "utf8").split("\n").filter(Boolean);
  assert.deepEqual(decodeDailyBarsPack({ file, manifest, dustReply: reply }).lines, lines);
});

test("month file: lines sorted by securityId|sessionDate|revision with trailing newline", () => {
  const a = stableJson(bar("sec_b", 1)), b = stableJson({ ...bar("sec_a", 2), sessionDate: "2030-01-16" }), c = stableJson(bar("sec_a", 3));
  assert.equal(monthFileFromLines([a, b, c]), `${c}\n${b}\n${a}\n`);
});
