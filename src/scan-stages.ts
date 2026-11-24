// Scan stage timing for the online scanner host. Every promise-returning call on the wrapped market
// store and provider writes one SCAN_STAGE line (src/scan-stage-line.ts) when it settles; a failed
// call writes "<stage>:FAILED", and a call still running after SLOW_STAGE_MS writes "<stage>:SLOW"
// once, so a hang names the call it is stuck in. Lines carry stage names and timings only.
import { hostFailureCauseLine } from "./host-failure-cause-line";
import { scanStageLine } from "./scan-stage-line";

export type StageSink = (line: string) => void;

export const SLOW_STAGE_MS = 60_000;

export interface StageTracker {
  /** Session the host is working on right now ("host" before the first session). */
  session: string;
  /** First stage that failed in this run, if any. */
  failed?: { readonly session: string; readonly stage: string; readonly ms: number };
}

/** Default sink: stderr, but silent inside the node test runner unless a test passes its own sink. */
export function defaultStageSink(env: NodeJS.ProcessEnv = process.env): StageSink {
  if (env.NODE_TEST_CONTEXT) return () => {};
  return (line) => {
    process.stderr.write(`${line}\n`);
  };
}

export function stageTimed<T extends object>(
  target: T,
  prefix: string,
  tracker: StageTracker,
  sink: StageSink,
  clock: () => number = Date.now,
  slowMs: number = SLOW_STAGE_MS,
): T {
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property) as unknown;
      if (typeof value !== "function" || typeof property !== "string") return value;
      const fn = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        const stage = `${prefix}.${property}`;
        const session = tracker.session;
        const started = clock();
        const result = fn.apply(object, args);
        if (!(result instanceof Promise)) return result;
        const slow = setTimeout(() => sink(scanStageLine(session, `${stage}:SLOW`, clock() - started)), slowMs);
        slow.unref?.();
        return result.then(
          (resolved: unknown) => {
            clearTimeout(slow);
            sink(scanStageLine(session, stage, clock() - started));
            return resolved;
          },
          (error: unknown) => {
            clearTimeout(slow);
            const ms = clock() - started;
            tracker.failed ??= { session, stage, ms };
            sink(scanStageLine(session, `${stage}:FAILED`, ms));
            throw error;
          },
        );
      };
    },
  });
}

/** The cause code of an error: cause.code, else cause.name, else the error's own non-generic name. */
export function errorCauseCode(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const cause = error.cause as { code?: unknown; name?: unknown } | undefined;
  if (cause && typeof cause.code === "string" && cause.code) return cause.code;
  if (cause && typeof cause.name === "string" && cause.name && cause.name !== "Error") return cause.name;
  return error.name && error.name !== "Error" ? error.name : "";
}

/** Final host failure line: message plus cause code (src/host-failure-cause-line.ts). */
export function hostFailureLine(error: unknown): string {
  return hostFailureCauseLine(error instanceof Error ? error.message : "UNKNOWN", errorCauseCode(error));
}
