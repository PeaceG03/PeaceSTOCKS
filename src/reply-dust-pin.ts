import { spawnSync } from "node:child_process";

// Writing Reply Dust needs the exact zstd release the frozen outputs were made with: a different
// zstd can produce different (still valid) frames, which would change stored bytes and could push
// files to the raw fallback. Reading never needs this pin; any zstd decodes old files.
export const REPLY_DUST_PINNED_ZSTD_VERSION = "1.5.7";

/** Returns `zstd --version` output, or undefined when the program is not installed. */
export type ZstdVersionProbe = () => string | undefined;

export const nodeZstdVersionProbe: ZstdVersionProbe = () => {
  const result = spawnSync("zstd", ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return undefined;
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
};

/**
 * Run once before a run writes any Reply Dust file. Throws REPLY_DUST_ZSTD_MISSING or
 * REPLY_DUST_ZSTD_VERSION:<found> unless zstd reports exactly the pinned version.
 */
export function assertPinnedZstdForWriting(probe: ZstdVersionProbe = nodeZstdVersionProbe): string {
  const output = probe();
  if (output === undefined) throw new Error("REPLY_DUST_ZSTD_MISSING");
  const found = /\bv?(\d+\.\d+\.\d+)\b/u.exec(output)?.[1];
  if (found !== REPLY_DUST_PINNED_ZSTD_VERSION)
    throw new Error(`REPLY_DUST_ZSTD_VERSION:${found ?? output.trim().slice(0, 80)}`);
  return found;
}

export const REPLY_DUST_FALLBACK_WARNING = "REPLY_DUST_FALLBACK_FILES";

/**
 * Run-report fields for a run with Reply Dust on. Fallback files are exact and stored; a count
 * above zero is a warning to raise in the team room, never a failure.
 */
export function replyDustRunReport(filesWritten: number, fallbackFiles: number, zstdVersion: string): {
  replyDustFilesWritten: number;
  replyDustFallbackFiles: number;
  replyDustZstdVersion: string;
  warnings?: string[];
} {
  return {
    replyDustFilesWritten: filesWritten,
    replyDustFallbackFiles: fallbackFiles,
    replyDustZstdVersion: zstdVersion,
    ...(fallbackFiles > 0 ? { warnings: [`${REPLY_DUST_FALLBACK_WARNING}:${fallbackFiles}`] } : {}),
  };
}
