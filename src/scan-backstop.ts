// Missed-scheduled-scan backstop (scanner.yml scan_backstop, on the reliable hourly :47 restarter cron).
// GitHub sometimes drops scheduled runs: the 05:30 UTC scan (and its 09:30 UTC backup slot) can silently
// never start. At the first :47 tick 30-89 min after a slot on Tue-Sat, if no scheduled "Scanner" run was
// created since that slot, dispatch scanner.yml mode=scan once. A redundant scan is harmless: the scan
// job only collects when collectionDue says the previous ET trading day is still missing, and it queues
// behind any R2 writer (peacestocks-r2-writer group). Fail closed: an API error dispatches nothing.
// Logs: PASS/FAIL + reason only.
import { pathToFileURL } from "node:url";

/** Scheduled scan slots in UTC minutes after midnight (scanner.yml crons "30 5" and "30 9", Tue-Sat). */
export const SCAN_SLOTS_UTC_MIN = [5 * 60 + 30, 9 * 60 + 30] as const;
export const SCAN_SLOT_DAYS = [2, 3, 4, 5, 6] as const;
/** A tick checks a slot only when it lands this many minutes after it (one hourly tick per slot). */
export const BACKSTOP_WINDOW_MIN = { from: 30, to: 89 } as const;
export const SCAN_RUN_NAME = "Scanner";

export interface ScanRunLike { event?: string; display_title?: string; created_at?: string }
export type BackstopPlan = { action: "none" | "dispatch"; why: string; slot?: string };

/** The slot this tick is responsible for, or null when the tick is outside every slot window. */
export function dueSlot(now: Date): Date | null {
  if (!(SCAN_SLOT_DAYS as readonly number[]).includes(now.getUTCDay())) return null;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  for (const s of SCAN_SLOTS_UTC_MIN) {
    const after = mins - s;
    if (after >= BACKSTOP_WINDOW_MIN.from && after <= BACKSTOP_WINDOW_MIN.to) {
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Math.floor(s / 60), s % 60));
    }
  }
  return null;
}

export function planMissedScan(input: { now: Date; scanRuns: readonly ScanRunLike[] | { error: string } }): BackstopPlan {
  const slot = dueSlot(input.now);
  if (!slot) return { action: "none", why: "PASS no scan slot due on this tick" };
  const iso = slot.toISOString();
  if ("error" in input.scanRuns) return { action: "none", why: `FAIL run check failed (${input.scanRuns.error}); not dispatching`, slot: iso };
  const started = input.scanRuns.some((r) => r.event === "schedule" && r.display_title === SCAN_RUN_NAME
    && (Date.parse(r.created_at ?? "") || 0) >= slot.getTime() - 5 * 60_000);
  if (started) return { action: "none", why: "PASS scheduled scan started", slot: iso };
  return { action: "dispatch", why: "scheduled scan missing", slot: iso };
}

/** Plain-value form for tests and logs: ISO tick time + created_at of scheduled "Scanner" runs -> action. */
export function planMissedScanAt(nowIso: string, scheduledScanCreatedAt: readonly string[]): BackstopPlan["action"] {
  const scanRuns = scheduledScanCreatedAt.map((created_at) => ({ event: "schedule", display_title: SCAN_RUN_NAME, created_at }));
  return planMissedScan({ now: new Date(nowIso), scanRuns }).action;
}

async function gh(path: string, init: RequestInit = {}): Promise<Response> {
  const env = process.env;
  const api = env.GITHUB_API_URL ?? "https://api.github.com";
  return fetch(`${api}/repos/${env.GITHUB_REPOSITORY}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN ?? ""}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
}

export interface ScannerRunLike extends ScanRunLike { id?: number; name?: string }

/** Scan runs only: scheduled "Scanner" runs (05:30/09:30 crons) and dispatched runs whose scan job is not skipped. */
export async function scanRunCreatedSince(sinceMs: number, runs: readonly ScannerRunLike[], scanJobRan: (id: number) => Promise<boolean>): Promise<string[]> {
  const out: string[] = [];
  for (const r of runs) {
    if (r.display_title !== SCAN_RUN_NAME || (Date.parse(r.created_at ?? "") || 0) < sinceMs) continue;
    if (r.event === "schedule" || (r.event === "workflow_dispatch" && r.id !== undefined && await scanJobRan(r.id))) out.push(r.created_at ?? "");
  }
  return out;
}

async function main(): Promise<number> {
  const now = new Date();
  const slot = lastScanSlot(now);
  const since = slot.getTime() - 5 * 60_000;
  let created: string[];
  try {
    const r = await gh(`/actions/workflows/scanner.yml/runs?created=${encodeURIComponent(`>=${new Date(since).toISOString()}`)}&per_page=100`);
    if (!r.ok) { console.log(`scan-backstop: FAIL run check failed (http-${r.status}); not dispatching`); return 1; }
    const runs = ((await r.json()) as { workflow_runs?: ScannerRunLike[] }).workflow_runs ?? [];
    created = await scanRunCreatedSince(since, runs, async (id) => {
      const j = await gh(`/actions/runs/${id}/jobs?per_page=50`);
      if (!j.ok) throw new Error(`jobs-http-${j.status}`);
      const jobs = ((await j.json()) as { jobs?: Array<{ name?: string; conclusion?: string | null }> }).jobs ?? [];
      return jobs.some((x) => x.name === "scan" && x.conclusion !== "skipped");
    });
  } catch { console.log("scan-backstop: FAIL run check failed (fetch); not dispatching"); return 1; }
  const action = planOpenScanAt(now.toISOString(), created);
  if (action !== "dispatch") { console.log(`scan-backstop: PASS ${action} (slot ${slot.toISOString()}, scan runs since ${created.length})`); return 0; }
  const d = await gh(`/actions/workflows/scanner.yml/dispatches`, { method: "POST", body: JSON.stringify({ ref: "main", inputs: { mode: "scan" } }) });
  console.log(`scan-backstop: DISPATCH ${d.ok ? "PASS" : `FAIL http-${d.status}`} (scan missing since slot ${slot.toISOString()})`);
  return d.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c), () => { console.error("scan-backstop: FAIL"); process.exit(1); });
}

// Open-ended backstop (replaces the 30-89 min tick window, which a late or dropped :47 tick skips entirely).
/** Scan guard windows (UTC minutes): no backstop dispatch inside 05:15-06:15 / 09:15-10:15. */
export const SCAN_GUARD_WINDOWS_UTC_MIN = [[5 * 60 + 15, 6 * 60 + 15], [9 * 60 + 15, 10 * 60 + 15]] as const;
export const OPEN_BACKSTOP_MIN_AFTER_SLOT = 30;

/** Most recent scheduled scan slot at or before now (Tue-Sat 05:30/09:30 UTC), looking back at most 4 days. */
export function lastScanSlot(now: Date): Date {
  for (let d = 0; d <= 4; d += 1) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - d));
    if (!(SCAN_SLOT_DAYS as readonly number[]).includes(day.getUTCDay())) continue;
    for (const s of [...SCAN_SLOTS_UTC_MIN].reverse()) {
      const t = new Date(day.getTime() + s * 60_000);
      if (t.getTime() <= now.getTime()) return t;
    }
  }
  throw new Error("SCAN_SLOT_NOT_FOUND");
}

export function inScanGuardWindow(now: Date): boolean {
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  return SCAN_GUARD_WINDOWS_UTC_MIN.some(([a, b]) => m >= a && m < b);
}

/**
 * Plain values: ISO now + created_at of every scan run (scheduled or dispatched; the caller filters to runs whose
 * scan job ran or is queued) -> "dispatch" | "wait" (guard window) | "none". A run created from 5 min before the
 * last slot onward counts, so a slot is backed up once, from 30 min after it until the next slot.
 */
export function planOpenScanAt(nowIso: string, scanRunCreatedAt: readonly string[]): "dispatch" | "wait" | "none" {
  const now = new Date(nowIso);
  if (!Number.isFinite(now.getTime())) throw new Error("SCAN_BACKSTOP_BAD_NOW");
  const slot = lastScanSlot(now);
  if (now.getTime() - slot.getTime() < OPEN_BACKSTOP_MIN_AFTER_SLOT * 60_000) return "none";
  if (scanRunCreatedAt.some((c) => (Date.parse(c) || 0) >= slot.getTime() - 5 * 60_000)) return "none";
  return inScanGuardWindow(now) ? "wait" : "dispatch";
}
