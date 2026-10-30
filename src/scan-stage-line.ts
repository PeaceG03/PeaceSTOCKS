export function scanStageLine(session: string, stage: string, ms: number): string {
  return "SCAN_STAGE:" + session + ":" + stage + ":" + ("" + ms) + "ms";
}
