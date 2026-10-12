// Ten-minute scanner mode state machine (pure). One decision per run boundary, so the Actions chain needs no person
// and no box: CATCH_UP (saved cursor -> last closed session, 24/7) -> DAILY (one step per new close; between closes
// the chain STOPS and the schedule wakes it, so no idle minute-burning) -> BACKFILL_OLDER when the Massive plan's
// history window grows below what is stored -> DAILY again. GAP_FILL takes priority over DAILY whenever a session
// inside the reachable window is missing. Recovery: rate limit / failure / lost handoff retry with backoff; ALERT only
// after MAX_FAILURES consecutive failures or a refusal. The machine only ever adds data (no action deletes or
// overwrites; the writers' never-overwrite guards stay the enforcement point).

export type TenMinMode = "CATCH_UP" | "GAP_FILL" | "BACKFILL_OLDER" | "DAILY" | "RECOVER" | "ALERT";
export type LastOutcome = "ok" | "rate_limited" | "failed" | "cancelled" | "lost_handoff" | "refused" | "none";

export interface PlanInfo {
  /** Oldest session the current plan serves (YYYY-MM-DD). */
  windowStart: string;
  /** Requests per minute allowed. */
  ratePerMin: number;
}

export interface ModeInput {
  /** Next session the forward cursor will fetch (YYYY-MM-DD). */
  cursor: string;
  /** Last closed session (today's if after close). */
  lastClosed: string;
  /** Oldest session already stored. */
  storedFloor: string;
  /** Sessions in [max(storedFloor, plan.windowStart), cursor) that are missing. */
  gaps: readonly string[];
  plan: PlanInfo;
  /** Plan seen at the previous decision (undefined on first run). */
  prevPlan?: PlanInfo;
  lastOutcome: LastOutcome;
  consecutiveFailures: number;
}

export interface ModeDecision {
  mode: TenMinMode;
  /** continue: dispatch the next run now; wait_ms: dispatch after a delay; stop: let the schedule wake it; alert. */
  next: "continue" | "wait" | "stop" | "alert";
  waitMs?: number;
  reason: string;
  /** Request pace for the next run (follows the plan's rate). */
  ratePerMin: number;
  planUpgraded: boolean;
}

export const MAX_FAILURES = 4;
const BACKOFF_MS = [5, 15, 45, 120].map((m) => m * 60_000);

export function planUpgraded(plan: PlanInfo, prev: PlanInfo | undefined): boolean {
  return !!prev && (plan.windowStart < prev.windowStart || plan.ratePerMin > prev.ratePerMin);
}

export function decideTenMinMode(i: ModeInput): ModeDecision {
  const up = planUpgraded(i.plan, i.prevPlan);
  const base = { ratePerMin: i.plan.ratePerMin, planUpgraded: up };
  if (i.lastOutcome === "refused") return { ...base, mode: "ALERT", next: "alert", reason: "REFUSED: plan/guard refusal needs a person" };
  if (i.lastOutcome === "rate_limited" || i.lastOutcome === "failed" || i.lastOutcome === "lost_handoff") {
    if (i.consecutiveFailures >= MAX_FAILURES) return { ...base, mode: "ALERT", next: "alert", reason: `UNRECOVERED:${i.lastOutcome}x${i.consecutiveFailures}` };
    const waitMs = BACKOFF_MS[Math.min(Math.max(i.consecutiveFailures - 1, 0), BACKOFF_MS.length - 1)]!;
    // A lost handoff (dispatch never happened) is safe to resume right away; others back off.
    if (i.lastOutcome === "lost_handoff") return { ...base, mode: "RECOVER", next: "continue", reason: "RESUME_LOST_HANDOFF" };
    return { ...base, mode: "RECOVER", next: "wait", waitMs, reason: `BACKOFF:${i.lastOutcome}` };
  }
  if (i.cursor <= i.lastClosed) return { ...base, mode: "CATCH_UP", next: "continue", reason: `CATCH_UP:${i.cursor}..${i.lastClosed}` };
  if (i.gaps.length > 0) return { ...base, mode: "GAP_FILL", next: "continue", reason: `GAP_FILL:${i.gaps.length}` };
  if (i.plan.windowStart < i.storedFloor) return { ...base, mode: "BACKFILL_OLDER", next: "continue", reason: `BACKFILL_OLDER:${i.plan.windowStart}..${i.storedFloor}` };
  return { ...base, mode: "DAILY", next: "stop", reason: "DAILY:caught-up; schedule wakes next close" };
}

/** Map a finished tenmin_history run's reason/job result to the machine's LastOutcome (used in shadow mode). */
export function lastOutcomeFromRecord(reason: string | undefined, jobResult: string | undefined): LastOutcome {
  if (!reason && !jobResult) return "none";
  if (/RATE|429/u.test(reason ?? "")) return "rate_limited";
  if (/REFUS|STOP_BOUNDED_MANUAL/u.test(reason ?? "")) return "refused";
  if (jobResult === "cancelled") return "cancelled";
  if (jobResult && jobResult !== "success") return "failed";
  return "ok";
}
