export function checkinLine(part: string, sent: number, expected: number): string {
  return part + ": sent " + ("" + sent) + " of " + ("" + expected) + " check-ins";
}
