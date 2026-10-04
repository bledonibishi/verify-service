import { normalizeName } from '../mrz';

/**
 * Reads the printed fields of a Kosovo driving licence from OCR text. The licence follows the EU
 * numbering (see docs/kosovo-documents.md): 1 surname, 2 given names, 3 date and place of birth,
 * 4a issue date, 4b expiry date, 4d personal number, 5 licence number, 9 categories.
 *
 * There is no MRZ and no check digit, so everything here is best effort on noisy OCR. The caller
 * treats anything it could not read as "not found" and sends the session to a person. Values are
 * returned to the caller only; nothing in this module logs or stores them.
 */

export type LicenceField = '1' | '2' | '3' | '4a' | '4b' | '4d' | '5' | '9';

/** Needed for a licence to count as read; 9 (categories) is recorded but OCR garbles it too often to require. */
export const REQUIRED_FIELDS: LicenceField[] = ['1', '2', '3', '4a', '4b', '4d', '5'];

export interface LicenceFields {
  surname?: string;
  givenNames?: string;
  /** ISO date */
  birthDate?: string;
  issueDate?: string;
  expiryDate?: string;
  personalNumber?: string;
  licenceNumber?: string;
  categories?: string[];
}

export interface LicenceParse {
  fields: LicenceFields;
  /** Which field numbers were read successfully (names only, never values). */
  found: LicenceField[];
  /** True when look-alike characters (O/0, I/1, ...) had to be corrected in a date or number. */
  repaired: boolean;
}

// Labels: 1 2 3 5 9 and 4a-4d, followed by "." or ")". The label must follow whitespace so dates
// ("12.03.2022") are never mistaken for one; a single-digit label must not be followed by a digit
// ("5.03.1990" is a date, "5. DL123" is a label).
const LABEL = /(?<![A-Za-z0-9.])(?:(4\s?[abcdABCD])\s*[.)]|([1235]|9)\s*[.)](?=\s|[A-Za-z]))/g;

const TO_DIGIT: Record<string, string> = { O: '0', o: '0', Q: '0', D: '0', I: '1', l: '1', L: '1', '|': '1', Z: '2', S: '5', B: '8' };
const digits = (s: string): { value: string; repaired: boolean } => {
  let repaired = false;
  const value = [...s].map((c) => (TO_DIGIT[c] && !/\d/.test(c) ? ((repaired = true), TO_DIGIT[c]) : c)).join('');
  return { value, repaired };
};

// Anchored: a date is a whole token, never a slice of a longer run of digits
const D = '0-9OoIlLSBZ';
const DATE = new RegExp(`(?<![${D}])([${D}]{1,2})\\s?[./-]\\s?([${D}]{1,2})\\s?[./-]\\s?([${D}]{4})(?![${D}])`);

function parseDate(text: string): { iso: string; repaired: boolean } | null {
  const m = text.match(DATE);
  if (!m) return null;
  const parts = m.slice(1, 4).map(digits);
  const [d, mo, y] = parts.map((p) => p.value);
  if (!/^\d{1,2}$/.test(d) || !/^\d{1,2}$/.test(mo) || !/^\d{4}$/.test(y)) return null;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d)) return null;
  return { iso: `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`, repaired: parts.some((p) => p.repaired) };
}

const CATEGORY = /^(AM|A1|A2|A|B1|BE|B|C1E|C1|CE|C|D1E|D1|DE|D|F|G|H|K|T)$/;

function parseName(raw: string): string | undefined {
  // First line only. Accept letters (Latin, including Albanian ë/ç), spaces, hyphens and apostrophes
  // and nothing else: digits or stray punctuation mean OCR damage, which must not be silently
  // dropped ("TESTI123" is not "TESTI"), so the field counts as unreadable.
  const line = raw.split('\n')[0].trim();
  const folded = line.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!/^[A-Za-z][A-Za-z '\-]{1,60}$/.test(folded)) return undefined;
  const cleaned = normalizeName(line);
  return /^[A-Z][A-Z ]{1,60}$/.test(cleaned) ? cleaned : undefined;
}

export function parseLicenceFields(ocrText: string): LicenceParse {
  const text = ocrText.replace(/\r/g, '');
  const marks = [...text.matchAll(LABEL)].map((m) => ({
    label: (m[1] ?? m[2]).replace(/\s/g, '').toLowerCase() as string,
    start: m.index!,
    end: m.index! + m[0].length,
  }));

  // First occurrence of each label wins; its value runs to the next label.
  const values = new Map<string, string>();
  marks.forEach((mark, i) => {
    if (values.has(mark.label)) return;
    values.set(mark.label, text.slice(mark.end, marks[i + 1]?.start ?? text.length).trim());
  });

  const fields: LicenceFields = {};
  const found: LicenceField[] = [];
  let repaired = false;
  const take = (label: LicenceField, ok: boolean) => ok && found.push(label);

  const v1 = values.get('1');
  if (v1) take('1', (fields.surname = parseName(v1)) !== undefined);
  const v2 = values.get('2');
  if (v2) take('2', (fields.givenNames = parseName(v2)) !== undefined);

  for (const [label, key] of [['3', 'birthDate'], ['4a', 'issueDate'], ['4b', 'expiryDate']] as const) {
    const raw = values.get(label);
    const d = raw ? parseDate(raw) : null;
    if (d) {
      fields[key] = d.iso;
      repaired ||= d.repaired;
      found.push(label);
    }
  }

  const v4d = values.get('4d');
  if (v4d) {
    // The whole field must be exactly ten digits (or look-alikes): an extra or missing digit is
    // damage, not something to trim until it fits.
    const token = v4d.split(/\s+/)[0] ?? '';
    if (/^[0-9OoIlLSBZ]{10}$/.test(token)) {
      const d = digits(token);
      if (/^\d{10}$/.test(d.value)) {
        fields.personalNumber = d.value;
        repaired ||= d.repaired;
        found.push('4d');
      }
    }
  }

  const v5 = values.get('5');
  if (v5) {
    // Observed format: "DL" + digits. Anything else is not accepted as a licence number.
    const m = v5.toUpperCase().match(/^(DL)\s?([0-9OIlLSB]{5,10})(?![0-9A-Z])/);
    if (m) {
      const d = digits(m[2]);
      if (/^\d{5,10}$/.test(d.value)) {
        fields.licenceNumber = `DL${d.value}`;
        repaired ||= d.repaired;
        found.push('5');
      }
    }
  }

  const v9 = values.get('9');
  if (v9) {
    const cats = v9.split(/[\s,;/]+/).map((t) => t.toUpperCase()).filter((t) => CATEGORY.test(t));
    if (cats.length > 0) {
      fields.categories = [...new Set(cats)];
      found.push('9');
    }
  }

  // Stable, documented order
  const order: LicenceField[] = ['1', '2', '3', '4a', '4b', '4d', '5', '9'];
  return { fields, found: order.filter((f) => found.includes(f)), repaired };
}
