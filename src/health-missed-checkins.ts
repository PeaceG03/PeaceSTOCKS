export function missedCheckins(expected: number, sent: number): number {
  return 0 <= (expected - sent) ? (expected - sent) : 0;
}
