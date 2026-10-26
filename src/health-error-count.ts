export function countErrorParts(states: string[]): number {
  return states.filter((x) => x === "ERROR").length;
}
