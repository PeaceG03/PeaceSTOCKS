// Before a ten-minute history range's per-ticker fetches, store the whole-market grouped-daily
// reply for every trading session in its fetch span as grouped-daily Reply Dust, reusing the
// existing format and key layout (src/daily-reply-dust.ts):
//   permanent/daily-reply-dust/YYYY-MM-DD/grouped-daily.rdust
//   permanent/daily-reply-dust/YYYY-MM-DD/manifest.json
// A later commit builds the range universe from these replies; this step only stores them.

import type { ProviderRawReply } from "./contracts";
import {
  readDailyReplyDustManifest,
  readDailyReplyDustReply,
  writeDailyReplyDust,
} from "./daily-reply-dust";
import type { ReplyDustStore } from "./intraday-reply-dust";
import type { ReplyDustBackend } from "./reply-dust";
import {
  TENMIN_RANGE_OUTAGE_STOP,
  TENMIN_RANGE_OUTAGE_STREAK,
  type TenMinRangeGapEntry,
  isTenMinRangeAbortError,
  isTenMinRangeOutageError,
  withTenMinMassiveRequests,
} from "./tenmin-range-reply-dust";

/** Range-level gap (securityId and symbol empty, fetchFrom = fetchTo = the session). */
export const GROUPED_DAILY_MISSING = "GROUPED_DAILY_MISSING";

export interface GroupedDailyStepResult {
  /** Massive grouped-daily requests made (one per session not already stored). */
  requests: number;
  stored: number;
  resumed: number;
  gaps: TenMinRangeGapEntry[];
  /** Consecutive network/5xx failures at the end of the step (carried into the 10-minute step). */
  outageStreak: number;
  yieldedForScan?: string;
  outageStop?: string;
}

function hasResults(body: Uint8Array): boolean {
  const parsed = JSON.parse(new TextDecoder().decode(body)) as { results?: unknown };
  return Array.isArray(parsed.results) && parsed.results.length > 0;
}

/**
 * Make sure a verified grouped-daily reply is stored for every session, oldest first.
 * - Already sealed and verified (manifest + file checksums + decode): resumed, 0 requests. A
 *   sealed day that fails verification throws (fail closed; it is never silently replaced).
 * - Store/R2/Reply Dust errors throw; 401/403/429-after-retries abort (isTenMinRangeAbortError).
 * - Network/5xx count toward the outage streak shared with the 10-minute step; the 5th in a row
 *   stops the run (unsealed, resumable). Below that, the day is a GROUPED_DAILY_MISSING gap.
 * - A 404, an empty reply, or any other per-session provider error becomes a range-level
 *   GROUPED_DAILY_MISSING gap for that date; nothing is stored for it, so a later run retries it.
 * - Every session therefore ends stored, resumed, as a gap, or the step returns a resumable
 *   stop (yield, time budget, outage) or throws. A gap is cleared only when the day is stored.
 * - shouldYield is asked before every request; a reason stops the step cleanly.
 * Thrown errors carry the requests already made (tenMinMassiveRequestsOf).
 */
export async function storeRangeGroupedDaily(options: {
  store: ReplyDustStore;
  provider: string;
  sessions: readonly string[];
  fetchGroupedDaily: (sessionDate: string) => Promise<ProviderRawReply>;
  shouldYield?: () => Promise<string | undefined>;
  now?: () => string;
  backend?: ReplyDustBackend;
  outageStreak?: number;
}): Promise<GroupedDailyStepResult> {
  const stamp = options.now ?? (() => new Date().toISOString());
  const gaps: TenMinRangeGapEntry[] = [];
  let requests = 0;
  let stored = 0;
  let resumed = 0;
  let outageStreak = options.outageStreak ?? 0;
  const gap = (sessionDate: string): TenMinRangeGapEntry => ({
    securityId: "",
    symbol: "",
    reason: GROUPED_DAILY_MISSING,
    at: stamp(),
    fetchFrom: sessionDate,
    fetchTo: sessionDate,
  });
  const result = (extra: Partial<GroupedDailyStepResult> = {}): GroupedDailyStepResult => ({
    requests,
    stored,
    resumed,
    gaps,
    outageStreak,
    ...extra,
  });
  try {
    for (const sessionDate of options.sessions) {
      const manifest = await readDailyReplyDustManifest(options.store, sessionDate);
      if (manifest) {
        if (manifest.provider !== options.provider)
          throw new Error(`REPLY_DUST_GROUPED_PROVIDER_MISMATCH:${sessionDate}`);
        await readDailyReplyDustReply(options.store, manifest, options.backend);
        resumed += 1;
        continue;
      }
      if (options.shouldYield) {
        const reason = await options.shouldYield();
        if (reason) return result({ yieldedForScan: reason });
      }
      let reply: ProviderRawReply;
      try {
        requests += 1;
        reply = await options.fetchGroupedDaily(sessionDate);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isTenMinRangeAbortError(message) || message.startsWith("PROVIDER_NOT_READY")) throw error;
        if (isTenMinRangeOutageError(message)) {
          outageStreak += 1;
          // The 5th in a row stops the run unsealed (resumable); earlier ones are recorded as
          // gaps so the day can never vanish from a sealed range, and reopen retries it.
          if (outageStreak >= TENMIN_RANGE_OUTAGE_STREAK)
            return result({ outageStop: `${TENMIN_RANGE_OUTAGE_STOP}:${message}` });
          gaps.push(gap(sessionDate));
          continue;
        }
        outageStreak = 0;
        gaps.push(gap(sessionDate));
        continue;
      }
      outageStreak = 0;
      if (
        reply.dataset !== "stocks-grouped-daily" ||
        reply.sessionDate !== sessionDate ||
        /[?&]apikey=/iu.test(reply.request)
      )
        throw new Error(`REPLY_DUST_GROUPED_REPLY_UNEXPECTED:${sessionDate}`);
      if (!hasResults(reply.body)) {
        gaps.push(gap(sessionDate));
        continue;
      }
      await writeDailyReplyDust(
        options.store,
        reply,
        { provider: options.provider, observedAt: reply.fetchedAt },
        options.backend,
      );
      stored += 1;
    }
  } catch (error) {
    throw withTenMinMassiveRequests(error, requests);
  }
  return result();
}
