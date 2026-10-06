// A compact index of the stored daily bars: securityId -> the session dates it has a bar for.
// Monthly files under permanent/daily-bars/ are ~100 MB, so they are scanned line by line from
// the raw bytes and only securityId and sessionDate are kept (never whole bars).

/** securityId -> sessionDates (YYYY-MM-DD) with at least one stored daily bar. */
export type DailyBarSessionIndex = Map<string, Set<string>>;

const SECURITY_ID = /"securityId":("(?:[^"\\]|\\.)*")/u;
const SESSION_DATE = /"sessionDate":"(\d{4}-\d{2}-\d{2})"/u;

export function requireMonth(month: string): void {
  if (!/^\d{4}-\d{2}$/u.test(month)) throw new Error("INVALID_DAILY_BAR_MONTH");
}

/**
 * Add every (securityId, sessionDate) in one daily-bars JSONL body to the index. Blank lines are
 * skipped; a line without both fields throws (fail closed: a torn file is not a smaller universe).
 */
export function indexDailyBarSessions(
  body: Uint8Array,
  into: DailyBarSessionIndex = new Map(),
  label = "daily-bars",
): DailyBarSessionIndex {
  const decoder = new TextDecoder();
  // Session date strings repeat for every bar; share one string per date.
  const dates = new Map<string, string>();
  let start = 0;
  let lineNumber = 0;
  while (start < body.length) {
    let end = body.indexOf(0x0a, start);
    if (end < 0) end = body.length;
    lineNumber += 1;
    if (end > start) {
      const line = decoder.decode(body.subarray(start, end));
      if (line.trim()) {
        const securityMatch = SECURITY_ID.exec(line);
        const sessionMatch = SESSION_DATE.exec(line);
        if (!securityMatch || !sessionMatch)
          throw new Error(`DAILY_BARS_LINE_INVALID:${label}:${lineNumber}`);
        const securityId = JSON.parse(securityMatch[1]!) as string;
        const raw = sessionMatch[1]!;
        let sessionDate = dates.get(raw);
        if (!sessionDate) {
          sessionDate = raw;
          dates.set(raw, raw);
        }
        let sessions = into.get(securityId);
        if (!sessions) {
          sessions = new Set();
          into.set(securityId, sessions);
        }
        sessions.add(sessionDate);
      }
    }
    start = end + 1;
  }
  return into;
}

/** YYYY-MM months touched by [from, to] (inclusive). */
export function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const last = to.slice(0, 7);
  for (;;) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    if (key > last) break;
    months.push(key);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
    if (months.length > 48) break;
  }
  return months;
}
