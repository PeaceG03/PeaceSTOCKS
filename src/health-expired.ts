export function isCheckinExpired(ageDays: number): boolean {
  return 31 <= ageDays;
}
