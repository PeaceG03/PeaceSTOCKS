export function undoneSessions(sessions: { date: string; done: boolean }[]): string[] {
  return sessions.filter((x) => !x.done).map((x) => x.date);
}
