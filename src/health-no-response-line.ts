export function noResponseLine(part: string, requests: number): string {
  return "no response from " + part + ", requested health check " + ("" + requests) + " time/s";
}
