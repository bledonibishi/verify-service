const WEIGHTS = [7, 3, 1];

/** ICAO 9303 character values: digits as-is, A-Z = 10-35, filler `<` = 0. */
export function charValue(c: string): number {
  if (c === '<') return 0;
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 55;
  throw new Error(`Invalid MRZ character: ${c}`);
}

/** Weighted (7-3-1) mod-10 check digit over an MRZ field. */
export function checkDigit(field: string): string {
  let sum = 0;
  for (let i = 0; i < field.length; i++) sum += charValue(field[i]) * WEIGHTS[i % 3];
  return String(sum % 10);
}
