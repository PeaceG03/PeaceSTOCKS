export function gotWorse(thisWeek: number, lastWeek: number): boolean {
  return !(thisWeek <= lastWeek);
}
