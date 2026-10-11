// Corporate-action coverage: which sessions had their splits + dividends fetched and stored.
// The actions themselves stay where they always were (permanent/corporate-actions.jsonl, one line per
// action, effectiveDate = the session). A session with zero actions leaves no line there, so every
// successful fetch also records the session here (one line per session, keyed by sessionDate):
//   permanent/corporate-actions-coverage.jsonl
// A session counts as covered if it has a coverage line OR at least one stored action.
export const CORPORATE_ACTIONS_KEY = "permanent/corporate-actions.jsonl";
export const CORPORATE_ACTION_COVERAGE_KEY = "permanent/corporate-actions-coverage.jsonl";
export const CORPORATE_ACTION_COVERAGE_SCHEMA = "corporate-action-coverage-v1" as const;

export interface CorporateActionCoverageRecord {
  schemaVersion: typeof CORPORATE_ACTION_COVERAGE_SCHEMA;
  sessionDate: string;
  provider: string;
  datasets: string[];
  /** Actions stored for this session by this fetch. */
  actions: number;
  recordedAt: string;
  source: string;
}

export function corporateActionCoverageRecords(
  sessions: readonly string[],
  actions: readonly { effectiveDate: string }[],
  options: { provider: string; source: string; recordedAt: string; datasets?: string[] },
): CorporateActionCoverageRecord[] {
  return [...new Set(sessions)].sort().map((sessionDate) => ({
    schemaVersion: CORPORATE_ACTION_COVERAGE_SCHEMA,
    sessionDate,
    provider: options.provider,
    datasets: options.datasets ?? ["stocks-splits", "stocks-dividends"],
    actions: actions.filter((a) => a.effectiveDate === sessionDate).length,
    recordedAt: options.recordedAt,
    source: options.source,
  }));
}

/** effectiveDate of every stored action (regex per line; the file is tens of MB). */
export function actionEffectiveDates(body: Uint8Array | undefined): Set<string> {
  const out = new Set<string>();
  if (!body) return out;
  for (const m of new TextDecoder().decode(body).matchAll(/"effectiveDate":"(\d{4}-\d{2}-\d{2})"/gu)) out.add(m[1]!);
  return out;
}

export function coverageSessions(body: Uint8Array | undefined): Set<string> {
  const out = new Set<string>();
  if (!body) return out;
  for (const line of new TextDecoder().decode(body).split("\n")) {
    if (!line) continue;
    const d = (JSON.parse(line) as { sessionDate?: unknown }).sessionDate;
    if (typeof d === "string") out.add(d);
  }
  return out;
}
