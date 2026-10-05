/** A billing month is a UTC calendar month, written `YYYY-MM`. */
export interface Month {
  label: string;
  /** Inclusive start, exclusive end. */
  from: Date;
  to: Date;
}

export function parseMonth(raw: string): Month | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(raw);
  if (!m) return null;
  const year = Number(m[1]);
  if (year < 2000 || year > 2100) return null;
  const month = Number(m[2]);
  return { label: raw, from: new Date(Date.UTC(year, month - 1, 1)), to: new Date(Date.UTC(year, month, 1)) };
}

export function currentMonth(now = new Date()): Month {
  return parseMonth(`${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`)!;
}
