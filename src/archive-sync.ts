import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { decodePackedBars, logicalFixtureHash } from "./packed-dust";
import type { ObjectMarketStorage } from "./object-storage";

export function archiveChecksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function syncPackedArchive(
  storage: ObjectMarketStorage,
  objectId: string,
  transferred: Uint8Array,
  localPath: string,
): Promise<{ logicalHash: string }> {
  const pending = await storage.putPendingArchive(objectId, transferred);
  const online = await storage.readPendingArchive(objectId);
  if (!online) throw new Error("ARCHIVE_TRANSFER_MISSING");
  if (archiveChecksum(online) !== pending.sha256) throw new Error("ARCHIVE_CHECKSUM_MISMATCH");
  const decoded = decodePackedBars(online);
  const temporary = `${localPath}.tmp-${process.pid}`;
  await writeFile(temporary, online);
  const written = new Uint8Array(await readFile(temporary));
  if (archiveChecksum(written) !== pending.sha256) {
    throw new Error("ARCHIVE_LOCAL_CHECKSUM_MISMATCH");
  }
  decodePackedBars(written);
  await rename(temporary, localPath);
  await storage.ackPendingArchive(objectId);
  await storage.purgePendingArchive(objectId);
  return { logicalHash: logicalFixtureHash(decoded) };
}
