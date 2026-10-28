export function countWrongFacts(wrong: boolean[]): number {
  return wrong.filter((x) => x).length;
}
