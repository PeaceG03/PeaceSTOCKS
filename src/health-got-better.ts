export function gotBetter(thisWeek: number, lastWeek: number): boolean {
  return !(lastWeek <= thisWeek);
}
