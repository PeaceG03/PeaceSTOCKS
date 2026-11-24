export function historyBlocked(newerScanFailed: boolean, failedDayStored: boolean, failedDayInTenMinWindow: boolean): boolean {
  return newerScanFailed && (failedDayInTenMinWindow && !failedDayStored);
}

/** One session as the daily 10-minute step left it. */
export interface HistoryHoldDay {
  sessionDate: string;
  /** Done by the done-day rule (or owned by a sealed history range). */
  done: boolean;
  /** A full catch-up pass ran for the day and left it not done. */
  failed: boolean;
  /** STUCK_SHORT: 6 failed passes; still not done, but it no longer blocks the chain. */
  stuckShort?: boolean;
}

/**
 * Pure: the session that blocks the history chain, or undefined.
 * - Only a failed day still inside the 10-session catch-up window can block (rule A3).
 * - A later session that is done unblocks it (rule A5): the stuck day stays flagged by the
 *   health check instead of holding the chain forever.
 * A day the daily step has not tried yet does not block, and neither does a STUCK_SHORT day.
 */
export function historyBlockingDay(days: readonly HistoryHoldDay[], windowSessions: readonly string[]): string | undefined {
  const window = new Set(windowSessions);
  const sorted = [...days].sort((a, b) => (a.sessionDate < b.sessionDate ? -1 : a.sessionDate > b.sessionDate ? 1 : 0));
  for (let i = 0; i < sorted.length; i += 1) {
    const day = sorted[i]!;
    if (!day.failed || day.stuckShort) continue;
    const laterDone = sorted.slice(i + 1).some((later) => later.done);
    if (historyBlocked(!laterDone, day.done, window.has(day.sessionDate))) return day.sessionDate;
  }
  return undefined;
}
