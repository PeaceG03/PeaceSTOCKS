export function weekChange(firstWeek: boolean, worse: boolean, better: boolean): string {
  return firstWeek ? "first week" : (worse ? "worse" : (better ? "better" : "same"));
}
