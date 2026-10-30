export function historyBlocked(newerScanFailed: boolean, failedDayStored: boolean, failedDayInTenMinWindow: boolean): boolean {
  return newerScanFailed && (failedDayInTenMinWindow && !failedDayStored);
}
