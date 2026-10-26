export function checkinLine(part: string, status: string, note: string): string {
  return "CHECKIN|" + part + "|" + status + "|" + note;
}
