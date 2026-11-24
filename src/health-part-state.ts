export function partState(silent: boolean, failed: boolean): string {
  return failed ? "ERROR" : (silent ? "SILENT" : "OK");
}

/**
 * State words a part may report. Anything else is an unrecognized word and never counts against the part.
 * BEHIND: a capped run (BACKLOG_REMAINS) that ran fine but left work for the next run, with the remaining
 * count. It is shown as behind, never as an error.
 */
export const HEALTH_STATE_WORDS = ["OK", "ERROR", "BEHIND"] as const;
export type HealthStateWord = (typeof HEALTH_STATE_WORDS)[number];

export function isRecognizedStateWord(word: string): word is HealthStateWord {
  return (HEALTH_STATE_WORDS as readonly string[]).includes(word);
}

/** A part's health status. A silent part is "no response" (tracked as missing), never an error. */
export type HealthPartStatus = "error" | "no response" | "behind" | "unrecognized word" | "OK";

/** Winner order when several apply (Peace, Oct 26-27; behind Nov 23): error > no response > behind > unrecognized word > OK. */
export function partStatus(input: { error: boolean; silent: boolean; unrecognized: boolean; behind?: boolean }): HealthPartStatus {
  if (input.error) return "error";
  if (input.silent) return "no response";
  if (input.behind) return "behind";
  if (input.unrecognized) return "unrecognized word";
  return "OK";
}
