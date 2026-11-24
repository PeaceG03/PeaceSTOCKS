/**
 * A short, safe reason for a failed site read, shown on the private page next to
 * "Could not read: <name>". Only an HTTP status, the S3 <Code> element when it is a plain word, or
 * an exception's name. Never the <Message>, <AWSAccessKeyId>, <StringToSign>, <CanonicalRequest>,
 * <RequestId>, <HostId> or any other body text (signature and key errors echo the access key id and
 * the signed request), never an error message, URL, key value or object data.
 */
export const READ_REASON_MAX = 120;
const S3_CODE = /^[A-Za-z]{1,64}$/u;
const ERROR_NAME = /^[A-Za-z]{1,64}$/u;

export class SiteReadError extends Error {
  override readonly name = "SiteReadError";
  constructor(readonly reason: string, options?: { cause?: unknown }) {
    super(reason, options);
  }
}

/** "HTTP 403 SignatureDoesNotMatch", or "HTTP 403" when the body has no plain-word <Code>. */
export function httpReadReason(status: number, body: string): string {
  const match = /<Code>([^<]*)<\/Code>/u.exec(body);
  const code = match?.[1]?.trim() ?? "";
  const status3 = Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : "?";
  return S3_CODE.test(code) ? `HTTP ${status3} ${code}` : `HTTP ${status3}`;
}

/** The exception's name only (e.g. TypeError, TimeoutError), never its message. */
export function errorNameReason(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return ERROR_NAME.test(name) ? name : "Error";
}

export function readReason(error: unknown): string {
  const reason = error instanceof SiteReadError ? error.reason : errorNameReason(error);
  return reason.length > READ_REASON_MAX ? `${reason.slice(0, READ_REASON_MAX - 1)}…` : reason;
}
