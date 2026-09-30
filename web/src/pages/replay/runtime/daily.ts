/** Today's UTC calendar date as YYYY-MM-DD: the daily seed's key. */
export function utcDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}
