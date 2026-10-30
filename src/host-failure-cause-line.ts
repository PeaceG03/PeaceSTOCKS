export function hostFailureCauseLine(message: string, causeCode: string): string {
  return "MARKETS_SCHEDULER_HOST_FAILED:" + message + ":cause=" + causeCode;
}
