export function tenMinDayDone(hasNames: boolean, namesMissing: boolean): boolean {
  return hasNames && !namesMissing;
}
