export function errorCountLine(message: string, count: number): string {
  return message + ": " + ("" + count) + " time/s";
}
