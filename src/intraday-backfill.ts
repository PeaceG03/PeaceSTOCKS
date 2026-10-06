import { appendFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeStoreFile, prepareSafeStoreFile } from "./store-path";
import type {
  CanonicalTenMinuteBar,
  MarketProvider,
  ProviderSecurityRecord,
  SecurityMasterRecord,
} from "./contracts";
import {
  FileReplyDustStore,
  type ReplyDustFileEntry,
  type ReplyDustStore,
  canonicalBarsFromReply,
  listStoredReplyDust,
  readReplyDustManifest,
  verifyStoredReplyDust,
  writeReplyDustFile,
  writeReplyDustManifest,
} from "./intraday-reply-dust";
import { intradaySessionSpec } from "./intraday";
import { MassiveMarketProvider } from "./massive-provider";
import { REPLY_DUST_FALLBACK_VERSION, type ReplyDustBackend } from "./reply-dust";
import {
  type ZstdVersionProbe,
  assertPinnedZstdForWriting,
  replyDustRunReport,
} from "./reply-dust-pin";
import { DustReader } from "./reader";
import { MarketStorage } from "./storage";
import { EphemeralValidationBuffer, sealValidatedDustSession } from "./validation";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

const STATE_VERSION = "markets-scanner-intraday-backfill-v1" as const;
export const MARKET_INTRADAY_BACKFILL_PATH_ERROR = "MARKET_INTRADAY_BACKFILL_PATH_INVALID";

export interface IntradayBackfillState {
  schemaVersion: typeof STATE_VERSION;
  provider: string;
  from: string;
  to: string;
  completedSessions: string[];
  failedSessions: Record<string, string>;
  updatedAt: string;
}

export interface IntradayBackfillResult {
  provider: string;
  requestedFrom: string;
  requestedTo: string;
  attemptedSessions: string[];
  completedSessions: string[];
  skippedExistingSessions: string[];
  failedSessions: Record<string, string>;
  barsStored: number;
  sealedArchives: number;
  stoppedOnError: boolean;
  /** Present only with replyDust on: Reply Dust files written by this run. */
  replyDustFilesWritten?: number;
  /** Present only with replyDust on: files written as the raw-zstd fallback (0x81). */
  replyDustFallbackFiles?: number;
  /** Present only with replyDust on: the pinned zstd version the run checked before writing. */
  replyDustZstdVersion?: string;
  /** Run warnings (not failures), e.g. REPLY_DUST_FALLBACK_FILES:<n> when fallback files > 0. */
  warnings?: string[];
}

function parseDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("INVALID_SESSION_DATE");
  return new Date(`${value}T00:00:00Z`);
}

function sessionDates(from: string, to: string): string[] {
  const start = parseDate(from);
  const end = parseDate(to);
  if (start > end) throw new Error("BACKFILL_RANGE_INVALID");
  const output: string[] = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    if (US_EQUITY_MARKET_CALENDAR.getSession(date).kind !== "CLOSED") output.push(date);
  }
  return output;
}

export async function loadIntradayBackfillState(
  path: string,
  provider: string,
  from: string,
  to: string,
): Promise<IntradayBackfillState> {
  const target = prepareSafeStoreFile(path, MARKET_INTRADAY_BACKFILL_PATH_ERROR);
  assertSafeStoreFile(target, MARKET_INTRADAY_BACKFILL_PATH_ERROR);
  try {
    const state = JSON.parse(await readFile(target, "utf8")) as IntradayBackfillState;
    if (
      state.schemaVersion === STATE_VERSION &&
      state.provider === provider &&
      state.from === from &&
      state.to === to
    )
      return state;
  } catch (error) {
    if (error instanceof Error && error.message === MARKET_INTRADAY_BACKFILL_PATH_ERROR)
      throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    schemaVersion: STATE_VERSION,
    provider,
    from,
    to,
    completedSessions: [],
    failedSessions: {},
    updatedAt: new Date().toISOString(),
  };
}

export async function saveIntradayBackfillState(
  path: string,
  state: IntradayBackfillState,
): Promise<void> {
  const target = prepareSafeStoreFile(path, MARKET_INTRADAY_BACKFILL_PATH_ERROR);
  assertSafeStoreFile(target, MARKET_INTRADAY_BACKFILL_PATH_ERROR);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  assertSafeStoreFile(temporary, MARKET_INTRADAY_BACKFILL_PATH_ERROR);
  await writeFile(
    temporary,
    `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  assertSafeStoreFile(temporary, MARKET_INTRADAY_BACKFILL_PATH_ERROR);
  assertSafeStoreFile(target, MARKET_INTRADAY_BACKFILL_PATH_ERROR);
  await rename(temporary, target);
  assertSafeStoreFile(target, MARKET_INTRADAY_BACKFILL_PATH_ERROR);
}

// Reply Dust per-file progress marker: one JSON line per file, appended only after that file is
// stored and read back. Append-only so a session of thousands of files costs one line each; a torn
// last line from a crash is ignored (that one file is simply redone). Removed once the session is sealed.
function replyDustProgressPath(root: string, sessionDate: string): string {
  return join(root, "transient", "reply-dust-progress", `${sessionDate}.jsonl`);
}

export async function loadReplyDustProgress(
  root: string,
  sessionDate: string,
): Promise<ReplyDustFileEntry[]> {
  const target = prepareSafeStoreFile(
    replyDustProgressPath(root, sessionDate),
    MARKET_INTRADAY_BACKFILL_PATH_ERROR,
  );
  let text: string;
  try {
    text = await readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: ReplyDustFileEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as ReplyDustFileEntry);
    } catch {
      // torn final line from a crash mid-append
    }
  }
  return entries;
}

async function appendReplyDustProgress(
  root: string,
  sessionDate: string,
  entry: ReplyDustFileEntry,
): Promise<void> {
  const target = prepareSafeStoreFile(
    replyDustProgressPath(root, sessionDate),
    MARKET_INTRADAY_BACKFILL_PATH_ERROR,
  );
  // Start on a fresh line in case a previous crash left a torn one.
  await appendFile(target, `\n${JSON.stringify(entry)}\n`, "utf8");
}

function providerRecords(
  securities: SecurityMasterRecord[],
  provider: string,
): ProviderSecurityRecord[] {
  return securities.flatMap((security) => {
    const identity = security.providerIdentities.find((item) => item.provider === provider);
    return identity
      ? [
          {
            provider,
            providerSecurityId: identity.providerSecurityId,
            symbol: security.currentSymbol,
            assetType: security.assetType,
            country: security.country,
            exchange: security.exchange,
            active: security.status === "ACTIVE",
            tradable: security.tradable,
            ...(security.fractional === undefined ? {} : { fractional: security.fractional }),
            ...(security.listingDate === undefined ? {} : { listingDate: security.listingDate }),
          },
        ]
      : [];
  });
}

export async function backfillHistoricalIntradayEvidence(options: {
  root: string;
  from: string;
  to: string;
  provider?: MarketProvider;
  maxSessions?: number;
  /**
   * Off by default. When on, each security's exact 10-minute reply is also stored as a Reply
   * Dust file under permanent/intraday-reply-dust/; the old .dust session is still sealed as before.
   * A given provider must keep raw replies (MassiveMarketProvider keepRawReplies: true).
   */
  replyDust?: boolean;
  /** Where Reply Dust files go; defaults to the local market root. */
  replyDustStore?: ReplyDustStore;
  replyDustBackend?: ReplyDustBackend;
  /** Tests inject this; production asks the zstd program. */
  zstdVersionProbe?: ZstdVersionProbe;
}): Promise<IntradayBackfillResult> {
  const replyDust = options.replyDust === true;
  // Checked once per run, before anything is fetched or written.
  const replyDustZstdVersion = replyDust
    ? assertPinnedZstdForWriting(options.zstdVersionProbe)
    : undefined;
  const provider =
    options.provider ?? new MassiveMarketProvider(replyDust ? { keepRawReplies: true } : {});
  if (!provider.getIntradayBars) throw new Error("INTRADAY_PROVIDER_UNSUPPORTED");
  if (replyDust && !provider.takeRawReplies) throw new Error("REPLY_DUST_PROVIDER_KEEPS_NO_REPLIES");
  const storage = new MarketStorage(options.root);
  await storage.initialize();
  const securities = await storage.loadSecurities();
  const bind = (
    provider as MarketProvider & { bindUniverse?: (records: ProviderSecurityRecord[]) => void }
  ).bindUniverse;
  if (bind) bind.call(provider, providerRecords(securities, provider.providerName));
  const statePath = join(options.root, "intraday-backfill-state.json");
  const state = await loadIntradayBackfillState(
    statePath,
    provider.providerName,
    options.from,
    options.to,
  );
  const sessions = sessionDates(options.from, options.to).slice(
    0,
    options.maxSessions ?? Number.MAX_SAFE_INTEGER,
  );
  const attemptedSessions: string[] = [];
  const completedSessions: string[] = [];
  const skippedExistingSessions: string[] = [];
  const failedSessions: Record<string, string> = { ...state.failedSessions };
  const activeIds = securities
    .filter((security) => security.status === "ACTIVE")
    .map((security) => security.securityId);
  let barsStored = 0;
  let sealedArchives = 0;
  let stoppedOnError = false;
  const reader = new DustReader(options.root);
  const replyStore = replyDust ? (options.replyDustStore ?? new FileReplyDustStore(options.root)) : undefined;
  let replyDustFilesWritten = 0;
  let replyDustFallbackFiles = 0;

  // Fetch one security at a time and store its reply before the next fetch, so at most one raw
  // reply is held in memory. Progress advances per file, only after the file is stored and read back.
  const fetchWithReplyDust = async (sessionDate: string): Promise<CanonicalTenMinuteBar[]> => {
    const store = replyStore!;
    const getIntradayBars = provider.getIntradayBars!.bind(provider);
    const takeRawReplies = provider.takeRawReplies!.bind(provider);
    if (takeRawReplies().length) throw new Error("REPLY_DUST_UNEXPECTED_HELD_REPLIES");
    // What is done comes from the store itself: the session manifest (read once per session) if
    // sealed, else the .rdust objects listed under the session and verified one by one against
    // their metadata. The local progress log only saves metadata reads; it is never the record.
    const manifest = await readReplyDustManifest(store, sessionDate);
    const hints = new Map(
      (manifest?.files ?? (await loadReplyDustProgress(options.root, sessionDate))).map((entry) => [
        entry.securityId,
        entry,
      ]),
    );
    const stored = manifest ? new Set(hints.keys()) : await listStoredReplyDust(store, sessionDate);
    const written = new Map<string, ReplyDustFileEntry>();
    const bars: CanonicalTenMinuteBar[] = [];
    for (const securityId of activeIds) {
      if (stored.has(securityId)) {
        const hint = hints.get(securityId);
        const verified =
          (hint &&
            (await verifyStoredReplyDust(store, sessionDate, securityId, {
              provider: provider.providerName,
              hint,
              ...(options.replyDustBackend ? { backend: options.replyDustBackend } : {}),
            }))) ||
          (manifest
            ? undefined
            : await verifyStoredReplyDust(store, sessionDate, securityId, {
                provider: provider.providerName,
                ...(options.replyDustBackend ? { backend: options.replyDustBackend } : {}),
              }));
        if (verified) {
          written.set(securityId, verified.entry);
          bars.push(
            ...canonicalBarsFromReply(provider.providerName, sessionDate, verified.entry, verified.reply),
          );
          continue;
        }
        // A sealed session's files are immutable; a bad one there is an error, not a refetch.
        if (manifest) throw new Error(`REPLY_DUST_SEALED_FILE_INVALID:${sessionDate}:${securityId}`);
      } else if (manifest) {
        continue;
      }
      const securityBars = await getIntradayBars(sessionDate, [securityId]);
      const replies = takeRawReplies();
      if (!securityBars.length && !replies.length) continue;
      const reply = replies[0];
      if (
        replies.length !== 1 ||
        !reply ||
        reply.dataset !== "stocks-aggregates-10m" ||
        reply.securityId !== securityId ||
        reply.sessionDate !== sessionDate
      )
        throw new Error(`REPLY_DUST_REPLY_MISSING_OR_UNEXPECTED:${securityId}:${replies.length}`);
      const observedAt = securityBars[0]?.observedAt;
      if (!observedAt) throw new Error(`REPLY_DUST_NO_BARS_FOR_REPLY:${securityId}`);
      const entry = await writeReplyDustFile(
        store,
        reply,
        { provider: provider.providerName, observedAt },
        options.replyDustBackend,
      );
      replyDustFilesWritten += 1;
      if (entry.version === REPLY_DUST_FALLBACK_VERSION) replyDustFallbackFiles += 1;
      await appendReplyDustProgress(options.root, sessionDate, entry);
      written.set(securityId, entry);
      bars.push(...securityBars);
    }
    await writeReplyDustManifest(store, {
      provider: provider.providerName,
      sessionDate,
      files: [...written.values()],
      existing: manifest,
    });
    return bars.sort(
      (a, b) => a.securityId.localeCompare(b.securityId) || a.intervalIndex - b.intervalIndex,
    );
  };

  for (const sessionDate of sessions) {
    if (state.completedSessions.includes(sessionDate)) {
      skippedExistingSessions.push(sessionDate);
      continue;
    }
    try {
      await reader.manifest(sessionDate);
      state.completedSessions = [...new Set([...state.completedSessions, sessionDate])].sort();
      skippedExistingSessions.push(sessionDate);
      await saveIntradayBackfillState(statePath, state);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    attemptedSessions.push(sessionDate);
    const buffer = new EphemeralValidationBuffer(options.root, sessionDate);
    try {
      let bars: CanonicalTenMinuteBar[];
      if (replyDust) {
        bars = await fetchWithReplyDust(sessionDate);
      } else {
        bars = await buffer.load();
        if (!bars.length) {
          bars = await provider.getIntradayBars(sessionDate, activeIds);
          await buffer.append(bars);
        }
      }
      const expected = new Set(activeIds);
      const actual = new Set(bars.map((bar) => bar.securityId));
      const missingSecurities = activeIds.filter((securityId) => !actual.has(securityId));
      if (missingSecurities.length)
        throw new Error(`INTRADAY_MISSING_SECURITIES:${missingSecurities.length}`);
      const sealed = await sealValidatedDustSession({
        root: options.root,
        records: bars,
        session: intradaySessionSpec(sessionDate),
        provider: provider.providerName,
        validationBuffer: buffer,
      });
      if (!sealed.report.valid || !sealed.manifest) {
        throw new Error(
          `INTRADAY_VALIDATION_FAILED:${sealed.report.warnings.join(",") || "invalid-report"}`,
        );
      }
      if (sealed.manifest.securityCount !== expected.size)
        throw new Error("INTRADAY_SECURITY_COUNT_MISMATCH");
      barsStored += bars.length;
      sealedArchives += 1;
      state.completedSessions = [...new Set([...state.completedSessions, sessionDate])].sort();
      delete failedSessions[sessionDate];
      completedSessions.push(sessionDate);
      await saveIntradayBackfillState(statePath, { ...state, failedSessions });
      if (replyDust)
        await rm(
          prepareSafeStoreFile(
            replyDustProgressPath(options.root, sessionDate),
            MARKET_INTRADAY_BACKFILL_PATH_ERROR,
          ),
          { force: true },
        );
    } catch (error) {
      failedSessions[sessionDate] = String(error);
      stoppedOnError = true;
      await saveIntradayBackfillState(statePath, { ...state, failedSessions });
      break;
    }
  }
  return {
    provider: provider.providerName,
    requestedFrom: options.from,
    requestedTo: options.to,
    attemptedSessions,
    completedSessions,
    skippedExistingSessions,
    failedSessions,
    barsStored,
    sealedArchives,
    stoppedOnError,
    ...(replyDustZstdVersion
      ? replyDustRunReport(replyDustFilesWritten, replyDustFallbackFiles, replyDustZstdVersion)
      : {}),
  };
}
