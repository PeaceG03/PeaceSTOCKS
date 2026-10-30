export function stopCatchUp(failedDaysInARow: number): boolean {
  return 3 <= failedDaysInARow;
}
