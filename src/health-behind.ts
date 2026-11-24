// Capped runs are behind, not failed (Peace, Nov 23). A scan host run that ends
// CATCH_UP_COMPLETED:BACKLOG_REMAINS, or an after-scan gap refill that stops on its budget
// (BACKLOG_REMAINS stopped=DEADLINE), checks in as BEHIND with the remaining count, not OK.

/** Pure: the scan part's check-in for a scan host result. */
export function scanCheckin(output: {
  readonly status: string;
  readonly reason: string;
  readonly backlogRemaining?: readonly string[];
}): { state: "OK" | "ERROR" | "BEHIND"; message: string; remaining?: number } {
  const message = `${output.status}:${output.reason}`;
  if (output.status === "FAILED" || output.status === "NOT_READY") return { state: "ERROR", message };
  if (output.reason === "BACKLOG_REMAINS") {
    const remaining = output.backlogRemaining?.length ?? 0;
    return { state: "BEHIND", message: `${message} remaining=${remaining}`, remaining };
  }
  return { state: "OK", message };
}
