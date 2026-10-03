import { readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertSafeStoreDirectory,
  assertSafeStoreFile,
  prepareSafeStoreDirectory,
  prepareSafeStoreFile,
} from "./store-path";
import { fileURLToPath } from "node:url";
import type { ScannerRunReport, SessionKind } from "./contracts";
import { MassiveMarketProvider } from "./massive-provider";
import {
  backfillHistoricalIntradayEvidence,
  type IntradayBackfillResult,
} from "./intraday-backfill";
import { collectionDue } from "./scheduler";
import { MarketsScanner, type SessionCalendar } from "./scanner";
import { MarketStorage } from "./storage";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

export const DEFAULT_MARKETS_ROOT = "C:\\ProgramData\\PeaceAI\\Markets";
export const MARKET_SCHEDULER_HOST_PATH_ERROR = "MARKET_SCHEDULER_HOST_PATH_INVALID";
const HOST_STATE_FILE = "scheduler-host-state.json";
const HOST_RUNS_ROOT = "scheduler-host-runs";
const MAX_INITIAL_CATCH_UP_DAYS = 7;
const DAY_MS = 86_400_000;

export interface SchedulerHostState {
  readonly schemaVersion: "peaceai-markets-scheduler-host:v1";
  readonly forwardClockStartedAt: string;
  readonly lastObservedSessionDate: string;
}

export interface SchedulerHostResult {
  readonly status: "NOT_DUE" | "COMPLETED" | "CATCH_UP_COMPLETED" | "FAILED";
  readonly reason:
    | "BEFORE_CLOSE"
    | "WAITING_FOR_DATA"
    | "CLOSED"
    | "ALREADY_COMPLETE"
    | "NO_MISSED_SESSION"
    | "MASSIVE_API_KEY_REQUIRED"
    | "COLLECTION_FAILED"
    | "CATCH_UP_EVIDENCE_ONLY"
    | "PROBE_ONLY";
  readonly sessions: readonly string[];
  readonly reports: readonly ScannerRunReport[];
  readonly completedAt: string;
  readonly intraday?: IntradayBackfillResult;
}

function dateValue(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new Error("INVALID_SESSION_DATE");
  return date;
}

function addDays(value: string, days: number): string {
  const date = dateValue(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function sessionDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function eligible(kind: SessionKind): boolean {
  return kind === "NORMAL" || kind === "HALF_DAY";
}

export function findMissedEligibleSessions(
  lastObservedSessionDate: string,
  throughSessionDate: string,
  completedSessionDates: ReadonlySet<string>,
  calendar: SessionCalendar = US_EQUITY_MARKET_CALENDAR,
): string[] {
  const output: string[] = [];
  for (
    let current = addDays(lastObservedSessionDate, 1);
    current <= throughSessionDate;
    current = addDays(current, 1)
  ) {
    if (eligible(calendar.getSession(current).kind) && !completedSessionDates.has(current)) {
      output.push(current);
    }
  }
  return output;
}

async function readState(root: string): Promise<SchedulerHostState | undefined> {
  assertSafeStoreDirectory(root, MARKET_SCHEDULER_HOST_PATH_ERROR);
  const statePath = join(root, HOST_STATE_FILE);
  assertSafeStoreFile(statePath, MARKET_SCHEDULER_HOST_PATH_ERROR);
  try {
    const state = JSON.parse(await readFile(statePath, "utf8")) as SchedulerHostState;
    if (
      state.schemaVersion !== "peaceai-markets-scheduler-host:v1" ||
      !state.forwardClockStartedAt ||
      !/^\d{4}-\d{2}-\d{2}$/.test(state.lastObservedSessionDate)
    ) {
      throw new Error("invalid state");
    }
    return state;
  } catch (error) {
    if (error instanceof Error && error.message === MARKET_SCHEDULER_HOST_PATH_ERROR) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("SCHEDULER_HOST_STATE_INVALID");
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const target = prepareSafeStoreFile(path, MARKET_SCHEDULER_HOST_PATH_ERROR);
  assertSafeStoreFile(target, MARKET_SCHEDULER_HOST_PATH_ERROR);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  assertSafeStoreFile(temporary, MARKET_SCHEDULER_HOST_PATH_ERROR);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  assertSafeStoreFile(temporary, MARKET_SCHEDULER_HOST_PATH_ERROR);
  assertSafeStoreFile(target, MARKET_SCHEDULER_HOST_PATH_ERROR);
  await rename(temporary, target);
  assertSafeStoreFile(target, MARKET_SCHEDULER_HOST_PATH_ERROR);
}

async function writeHostResult(root: string, value: SchedulerHostResult): Promise<void> {
  const safeRoot = prepareSafeStoreDirectory(root, MARKET_SCHEDULER_HOST_PATH_ERROR);
  const stamp = value.completedAt.replaceAll(/[^0-9]/gu, "").slice(0, 17);
  await atomicJson(join(safeRoot, HOST_RUNS_ROOT, `${stamp}.json`), value);
}

function makeResult(
  status: SchedulerHostResult["status"],
  reason: SchedulerHostResult["reason"],
  sessions: readonly string[] = [],
  reports: readonly ScannerRunReport[] = [],
): SchedulerHostResult {
  return Object.freeze({
    status,
    reason,
    sessions: Object.freeze([...sessions]),
    reports: Object.freeze([...reports]),
    completedAt: new Date().toISOString(),
  });
}

export async function runScannerHost(
  options: {
    readonly now?: Date;
    readonly storageRoot?: string;
    readonly calendar?: SessionCalendar;
    readonly completionDelayMinutes?: number;
    readonly provider?: MassiveMarketProvider;
    readonly intraday?: {
      readonly from: string;
      readonly to: string;
      readonly maxSessions?: number;
    };
  } = {},
): Promise<SchedulerHostResult> {
  const now = options.now ?? new Date();
  const configuredRoot =
    options.storageRoot ?? process.env.PEACEAI_MARKETS_ROOT ?? DEFAULT_MARKETS_ROOT;
  if (typeof configuredRoot !== "string" || !configuredRoot.trim())
    throw new Error(MARKET_SCHEDULER_HOST_PATH_ERROR);
  const root = prepareSafeStoreDirectory(configuredRoot, MARKET_SCHEDULER_HOST_PATH_ERROR);
  if (!process.env.MASSIVE_API_KEY) {
    const failed = makeResult("FAILED", "MASSIVE_API_KEY_REQUIRED");
    await writeHostResult(root, failed);
    return failed;
  }

  const calendar = options.calendar ?? US_EQUITY_MARKET_CALENDAR;
  const storage = new MarketStorage(root);
  await storage.initialize();
  const reports = await storage.loadRunReports();
  const completed = new Set(
    reports
      .filter((report) => report.status !== "FAILED")
      .map((report) => report.session.sessionDate),
  );
  const today = sessionDate(now);
  let state = await readState(root);
  if (!state) {
    const latest = reports.at(-1)?.session.sessionDate;
    const latestIsRecent =
      latest &&
      dateValue(today).getTime() - dateValue(latest).getTime() <=
        MAX_INITIAL_CATCH_UP_DAYS * DAY_MS;
    state = {
      schemaVersion: "peaceai-markets-scheduler-host:v1",
      forwardClockStartedAt: now.toISOString(),
      lastObservedSessionDate: latestIsRecent ? latest : today,
    };
    await atomicJson(join(root, HOST_STATE_FILE), state);
  }

  const due = collectionDue({
    now,
    calendar,
    ...(options.completionDelayMinutes === undefined
      ? {}
      : { completionDelayMinutes: options.completionDelayMinutes }),
  });
  const catchUpThrough = due.due || due.reason === "CLOSED" ? today : addDays(today, -1);
  const missed = findMissedEligibleSessions(
    state.lastObservedSessionDate,
    catchUpThrough,
    completed,
    calendar,
  );
  if (process.env.PEACEAI_MARKETS_SCHEDULER_PROBE === "1") {
    const probed = makeResult("NOT_DUE", "PROBE_ONLY");
    await writeHostResult(root, probed);
    return probed;
  }

  const scanner = new MarketsScanner(
    options.provider ?? new MassiveMarketProvider(),
    storage,
    calendar,
  );
  const collected: ScannerRunReport[] = [];
  for (const missedSession of missed) {
    collected.push(await scanner.run(missedSession, "EVIDENCE_ONLY"));
  }
  if (due.due && !completed.has(due.session.sessionDate)) {
    collected.push(await scanner.run(due.session.sessionDate, "FORWARD"));
  }

  const nextState = {
    ...state,
    lastObservedSessionDate: due.due ? due.session.sessionDate : today,
  } satisfies SchedulerHostState;
  await atomicJson(join(root, HOST_STATE_FILE), nextState);
  const intraday = options.intraday
    ? await backfillHistoricalIntradayEvidence({
        root,
        from: options.intraday.from,
        to: options.intraday.to,
        ...(options.provider === undefined ? {} : { provider: options.provider }),
        ...(options.intraday.maxSessions === undefined
          ? {}
          : { maxSessions: options.intraday.maxSessions }),
      })
    : undefined;
  const failed = collected.find((report) => report.status === "FAILED");
  const finalBase =
    failed || intraday?.stoppedOnError
      ? makeResult(
          "FAILED",
          "COLLECTION_FAILED",
          collected.map((report) => report.session.sessionDate),
          collected,
        )
      : collected.length
        ? makeResult(
            missed.length ? "CATCH_UP_COMPLETED" : "COMPLETED",
            missed.length ? "CATCH_UP_EVIDENCE_ONLY" : "NO_MISSED_SESSION",
            collected.map((report) => report.session.sessionDate),
            collected,
          )
        : makeResult(
            "NOT_DUE",
            completed.has(due.session.sessionDate)
              ? "ALREADY_COMPLETE"
              : due.reason === "READY"
                ? "NO_MISSED_SESSION"
                : due.reason,
          );
  const final = intraday ? { ...finalBase, intraday } : finalBase;
  await writeHostResult(root, final);
  return final;
}

async function main(): Promise<void> {
  const intradayFrom = process.env.PEACEAI_MARKETS_INTRADAY_FROM;
  const intradayTo = process.env.PEACEAI_MARKETS_INTRADAY_TO;
  const output = await runScannerHost(
    intradayFrom && intradayTo ? { intraday: { from: intradayFrom, to: intradayTo } } : {},
  );
  process.stdout.write(
    `${JSON.stringify({ status: output.status, reason: output.reason, sessions: output.sessions })}\n`,
  );
  process.exitCode = output.status === "FAILED" ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `MARKETS_SCHEDULER_HOST_FAILED:${error instanceof Error ? error.message : "UNKNOWN"}\n`,
    );
    process.exitCode = 2;
  });
}
