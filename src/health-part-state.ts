export function partState(silent: boolean, failed: boolean): string {
  return failed ? "ERROR" : (silent ? "SILENT" : "OK");
}
