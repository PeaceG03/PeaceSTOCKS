import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeStoreFile, prepareSafeStoreFile } from "./store-path";
import type { MarketProvider, ProviderSecurityRecord, SecurityMasterRecord } from "./contracts";
import { intradaySessionSpec } from "./intraday";
import { MassiveMarketProvider } from "./massive-provider";
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
}): Promise<IntradayBackfillResult> {
  const provider = options.provider ?? new MassiveMarketProvider();
  if (!provider.getIntradayBars) throw new Error("INTRADAY_PROVIDER_UNSUPPORTED");
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
      let bars = await buffer.load();
      if (!bars.length) {
        bars = await provider.getIntradayBars(sessionDate, activeIds);
        await buffer.append(bars);
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
  };
}
