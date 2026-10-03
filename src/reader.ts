import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertSafeStoreDirectory,
  assertSafeStoreFile,
  prepareSafeStoreDirectory,
  prepareSafeStoreFile,
} from "./store-path";
import type { CanonicalTenMinuteBar, DustArchiveManifest } from "./contracts";
import { decodeDust, dustManifestChecksum, encodeDust } from "./dust";
import { reconstructDailyBar } from "./intraday";

export const MARKET_DUST_PATH_ERROR = "MARKET_DUST_PATH_INVALID";

function safeId(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeImmutableBytes(
  path: string,
  bytes: Uint8Array,
  identity: string,
): Promise<void> {
  const target = prepareSafeStoreFile(path, MARKET_DUST_PATH_ERROR);
  assertSafeStoreFile(target, MARKET_DUST_PATH_ERROR);
  try {
    const existing = await readFile(target);
    if (!existing.equals(bytes)) throw new Error(`DUST_IMMUTABLE_BLOCK_CONFLICT:${identity}`);
    return;
  } catch (error) {
    if (error instanceof Error && error.message === MARKET_DUST_PATH_ERROR) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  assertSafeStoreFile(temporary, MARKET_DUST_PATH_ERROR);
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
    assertSafeStoreFile(temporary, MARKET_DUST_PATH_ERROR);
    assertSafeStoreFile(target, MARKET_DUST_PATH_ERROR);
    await rename(temporary, target);
    assertSafeStoreFile(target, MARKET_DUST_PATH_ERROR);
  } catch (error) {
    if (error instanceof Error && error.message === MARKET_DUST_PATH_ERROR) throw error;
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(target);
    if (!existing.equals(bytes)) throw new Error(`DUST_IMMUTABLE_BLOCK_CONFLICT:${identity}`);
  }
}
export interface DustSessionWriteOptions {
  provider: string;
  sessionDate: string;
  quality?: DustArchiveManifest["quality"];
  correctionRevisionState?: string;
}

export async function writeSealedDustSession(
  root: string,
  records: readonly CanonicalTenMinuteBar[],
  options: DustSessionWriteOptions,
): Promise<DustArchiveManifest> {
  if (typeof root !== "string" || !root.trim()) throw new Error(MARKET_DUST_PATH_ERROR);
  if (!records.length) throw new Error("DUST_SESSION_EMPTY");
  if (records.some((record) => record.sessionDate !== options.sessionDate))
    throw new Error("DUST_SESSION_DATE_MISMATCH");
  const safeRoot = prepareSafeStoreDirectory(root, MARKET_DUST_PATH_ERROR);
  const sessionRoot = prepareSafeStoreDirectory(
    join(safeRoot, "permanent", "intraday-dust", options.sessionDate),
    MARKET_DUST_PATH_ERROR,
  );
  const blocks: DustArchiveManifest["blocks"] = [];
  const bySecurity = new Map<string, CanonicalTenMinuteBar[]>();
  for (const record of records)
    bySecurity.set(record.securityId, [...(bySecurity.get(record.securityId) ?? []), record]);
  for (const [securityId, securityRecords] of [...bySecurity.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const encoded = encodeDust(securityRecords);
    const relativePath = `${safeId(securityId)}.dust`;
    const path = join(sessionRoot, relativePath);
    await writeImmutableBytes(path, encoded.bytes, securityId);

    blocks.push({
      securityId,
      relativePath,
      barCount: securityRecords.length,
      byteSize: encoded.bytes.byteLength,
      sha256: sha256(encoded.bytes),
    });
  }
  const manifestWithoutChecksum: DustArchiveManifest = {
    archiveId: `dust-session-${options.sessionDate}`,
    schemaVersion: "dust-v1",
    logicalSchemaVersion: "foundation-d.1-10m-v1",
    provider: options.provider,
    sessionDate: options.sessionDate,
    securityCount: blocks.length,
    barCount: blocks.reduce((sum, block) => sum + block.barCount, 0),
    blockCount: blocks.length,
    compressedBytes: blocks.reduce((sum, block) => sum + block.byteSize, 0),
    checksum: "",
    validation: "SEALED_CANONICAL",
    quality: options.quality ?? "COMPLETE",
    correctionRevisionState:
      options.correctionRevisionState ?? "provider-revision-lineage-preserved",
    sealedAt: new Date().toISOString(),
    blocks,
  };
  const checksum = sha256(Buffer.from(JSON.stringify(manifestWithoutChecksum), "utf8"));
  const manifest = { ...manifestWithoutChecksum, checksum };
  const manifestPath = prepareSafeStoreFile(
    join(sessionRoot, "manifest.json"),
    MARKET_DUST_PATH_ERROR,
  );
  assertSafeStoreFile(manifestPath, MARKET_DUST_PATH_ERROR);
  try {
    const existing = JSON.parse(await readFile(manifestPath, "utf8")) as DustArchiveManifest;
    if (existing.checksum !== checksum) throw new Error("DUST_IMMUTABLE_MANIFEST_CONFLICT");
  } catch (error) {
    if (error instanceof Error && error.message === MARKET_DUST_PATH_ERROR) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const temporary = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
    assertSafeStoreFile(temporary, MARKET_DUST_PATH_ERROR);
    await writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    try {
      assertSafeStoreFile(temporary, MARKET_DUST_PATH_ERROR);
      assertSafeStoreFile(manifestPath, MARKET_DUST_PATH_ERROR);
      await rename(temporary, manifestPath);
      assertSafeStoreFile(manifestPath, MARKET_DUST_PATH_ERROR);
    } catch (renameError) {
      if (renameError instanceof Error && renameError.message === MARKET_DUST_PATH_ERROR)
        throw renameError;
      if ((renameError as NodeJS.ErrnoException).code !== "EEXIST") throw renameError;
      const existing = JSON.parse(await readFile(manifestPath, "utf8")) as DustArchiveManifest;
      if (existing.checksum !== checksum) throw new Error("DUST_IMMUTABLE_MANIFEST_CONFLICT");
    }
  }
  return manifest;
}

export class DustReader {
  readonly root: string;

  constructor(root: string) {
    if (typeof root !== "string" || !root.trim()) throw new Error(MARKET_DUST_PATH_ERROR);
    this.root = prepareSafeStoreDirectory(root, MARKET_DUST_PATH_ERROR);
  }

  private sessionRoot(sessionDate: string): string {
    assertSafeStoreDirectory(this.root, MARKET_DUST_PATH_ERROR);
    return join(this.root, "permanent", "intraday-dust", sessionDate);
  }

  async manifest(sessionDate: string): Promise<DustArchiveManifest> {
    const manifestPath = join(this.sessionRoot(sessionDate), "manifest.json");
    assertSafeStoreFile(manifestPath, MARKET_DUST_PATH_ERROR);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as DustArchiveManifest;
    if (dustManifestChecksum({ ...manifest, checksum: "" }) !== manifest.checksum)
      throw new Error("DUST_MANIFEST_CHECKSUM_MISMATCH");
    return manifest;
  }

  async readSecurityDay(sessionDate: string, securityId: string): Promise<CanonicalTenMinuteBar[]> {
    const manifest = await this.manifest(sessionDate);
    const block = manifest.blocks.find((candidate) => candidate.securityId === securityId);
    if (!block) return [];
    const blockPath = join(this.sessionRoot(sessionDate), block.relativePath);
    assertSafeStoreFile(blockPath, MARKET_DUST_PATH_ERROR);
    const bytes = await readFile(blockPath);
    if (sha256(bytes) !== block.sha256)
      throw new Error(`DUST_BLOCK_CHECKSUM_MISMATCH:${securityId}`);
    return decodeDust(bytes).records;
  }

  async readRange(securityId: string, from: string, to: string): Promise<CanonicalTenMinuteBar[]> {
    const output: CanonicalTenMinuteBar[] = [];
    for (const date of datesBetween(from, to)) {
      try {
        output.push(...(await this.readSecurityDay(date, securityId)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return output;
  }

  async *stream(
    sessionDate: string,
    securityIds?: readonly string[],
  ): AsyncGenerator<CanonicalTenMinuteBar> {
    const manifest = await this.manifest(sessionDate);
    const selected = securityIds ? new Set(securityIds) : undefined;
    for (const block of manifest.blocks) {
      if (selected && !selected.has(block.securityId)) continue;
      const blockPath = join(this.sessionRoot(sessionDate), block.relativePath);
      assertSafeStoreFile(blockPath, MARKET_DUST_PATH_ERROR);
      const bytes = await readFile(blockPath);
      if (sha256(bytes) !== block.sha256)
        throw new Error(`DUST_BLOCK_CHECKSUM_MISMATCH:${block.securityId}`);
      for (const record of decodeDust(bytes).records) yield record;
    }
  }

  async reconstructDaily(
    sessionDate: string,
    securityId: string,
  ): Promise<ReturnType<typeof reconstructDailyBar>> {
    return reconstructDailyBar(await this.readSecurityDay(sessionDate, securityId));
  }

  async randomBlockRead(
    sessionDate: string,
    securityId: string,
  ): Promise<{ bytes: number; bars: CanonicalTenMinuteBar[] }> {
    const records = await this.readSecurityDay(sessionDate, securityId);
    const manifest = await this.manifest(sessionDate);
    return {
      bytes: manifest.blocks.find((block) => block.securityId === securityId)?.byteSize ?? 0,
      bars: records,
    };
  }
}

function datesBetween(from: string, to: string): string[] {
  const start = new Date(`${from}T00:00:00Z`),
    end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end)
    throw new Error("INVALID_DATE_RANGE");
  const output: string[] = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1))
    output.push(cursor.toISOString().slice(0, 10));
  return output;
}
