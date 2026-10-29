export function r2RetryAllowed(failedTries: number): boolean {
  return failedTries <= 2;
}
