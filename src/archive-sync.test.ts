import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { syncPackedArchive } from "./archive-sync";
import { MemoryObjectClient } from "./object-store";
import { ObjectMarketStorage } from "./object-storage";
import { decodePackedBars, encodePackedBars, FROZEN_PACKED_FIXTURE_HASH, logicalFixtureHash } from "./packed-dust";
import { legacyFixtureCannotBeReproduced, REGENERABLE_FIXTURE_ID, regenerablePackedFixture } from "./packed-fixture";

const REGENERABLE_HASH = "7912e21f0e8f5655b4e0bf80607e1825709b3dd42a390b1acd015138cc5cbadf";

test("regenerable fixture certifies the packed codec without claiming the legacy hash", () => {
  const bars = regenerablePackedFixture();
  assert.equal(REGENERABLE_FIXTURE_ID, "peacestocks-regenerable-packed-v1");
  assert.deepEqual(regenerablePackedFixture(), bars);
  assert.equal(logicalFixtureHash(bars), REGENERABLE_HASH);
  assert.notEqual(REGENERABLE_HASH, FROZEN_PACKED_FIXTURE_HASH);
  assert.equal(legacyFixtureCannotBeReproduced(), true);
  assert.deepEqual(decodePackedBars(encodePackedBars(bars)), bars);
});

test("archive sync acks only after checksum, decode, and the local write", async () => {
  const bars = regenerablePackedFixture();
  const packed = encodePackedBars(bars);
  const client = new MemoryObjectClient();
  const storage = new ObjectMarketStorage(client);
  const root = await mkdtemp(join(tmpdir(), "peacestocks-archive-"));
  const localPath = join(root, "local.bin");
  try {
    const pending = await storage.putPendingArchive("session-2026-01-22", packed);
    assert.equal(pending.acked, false);
    await assert.rejects(() => storage.purgePendingArchive(pending.objectId), /PENDING_ARCHIVE_NOT_ACKED/);
    await client.delete(`pending-archive/${pending.objectId}.bin`);
    await client.delete(`pending-archive/${pending.objectId}.json`);

    await assert.rejects(
      () => syncPackedArchive(storage, "bad-bytes", new TextEncoder().encode("not-packed"), localPath),
      /PACKED_/,
    );
    await assert.rejects(() => storage.purgePendingArchive("bad-bytes"), /PENDING_ARCHIVE_NOT_ACKED/);
    assert.ok(await client.get("pending-archive/bad-bytes.bin"));

    const synced = await syncPackedArchive(storage, "session-2026-01-22", packed, localPath);
    assert.equal(synced.logicalHash, REGENERABLE_HASH);
    assert.deepEqual(new Uint8Array(await readFile(localPath)), packed);
    assert.equal(await storage.readPendingArchive("session-2026-01-22"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a read-back checksum mismatch does not ack or purge", async () => {
  const client = new MemoryObjectClient();
  const storage = new ObjectMarketStorage(client);
  const original = storage.readPendingArchive.bind(storage);
  storage.readPendingArchive = async (objectId: string) => {
    const bytes = await original(objectId);
    if (!bytes) return undefined;
    const flipped = new Uint8Array(bytes);
    const first = flipped[0] ?? 0;
    flipped[0] = first ^ 0xff;
    return flipped;
  };
  const root = await mkdtemp(join(tmpdir(), "peacestocks-archive-"));
  try {
    await assert.rejects(
      () =>
        syncPackedArchive(
          storage,
          "checksum",
          encodePackedBars(regenerablePackedFixture()),
          join(root, "local.bin"),
        ),
      /ARCHIVE_CHECKSUM_MISMATCH/,
    );
    await assert.rejects(() => storage.purgePendingArchive("checksum"), /PENDING_ARCHIVE_NOT_ACKED/);
    assert.ok(await client.get("pending-archive/checksum.bin"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
