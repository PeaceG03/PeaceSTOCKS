export function r2RequestFailure(method: string, message: string): string {
  return "R2_REQUEST_FAILED:" + method + ":" + message;
}
