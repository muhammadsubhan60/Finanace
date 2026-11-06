/** All business dates are Asia/Karachi (UTC+5, no DST). Timestamps are stored in UTC. */
export const TZ = "Asia/Karachi";
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

/** YYYY-MM-DD of a UTC instant in Asia/Karachi. */
export function karachiDate(d: Date = new Date()): string {
  return new Date(d.getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Period id (YYYY-MM) for a business date or instant. */
export function periodIdOf(date: string | Date): string {
  return (typeof date === "string" ? date : karachiDate(date)).slice(0, 7);
}

export function periodBounds(periodId: string): { start: string; end: string; startUtc: Date; endUtcExclusive: Date } {
  const [y, m] = periodId.split("-").map(Number) as [number, number];
  const start = `${periodId}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${periodId}-${String(last).padStart(2, "0")}`;
  return { start, end, startUtc: karachiStartOfDayUtc(start), endUtcExclusive: new Date(Date.UTC(y, m, 1) - PKT_OFFSET_MS) };
}

export function karachiStartOfDayUtc(date: string): Date {
  return new Date(Date.parse(date + "T00:00:00Z") - PKT_OFFSET_MS);
}

export function addMonths(periodId: string, n: number): string {
  const [y, m] = periodId.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(date + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}

/**
 * Whole months from `from` to `to` (calendar month difference). Used for cap months:
 * the term start month is month 0.
 */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  return (ty - fy) * 12 + (tm - fm);
}
