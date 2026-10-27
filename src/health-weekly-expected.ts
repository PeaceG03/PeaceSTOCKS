export function weeklyExpected(perDay: number): number {
  return perDay + (2 * (perDay + (perDay + perDay)));
}
