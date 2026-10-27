export function countExpiredCheckins(ageDays: number[]): number {
  return ageDays.filter((x) => 31 <= x).length;
}
