import { alignLine, TEMPLATES, cleanMrzText, trimJunkTail } from './align';
import { parseTd1 } from './td1';
import { readKosovoMrz } from './repair';
import { buildTd1, SAMPLE, Td1Fields } from './testing';

const now = new Date('2026-10-04T00:00:00Z');
const card = (f: Partial<Td1Fields> = {}) => buildTd1({ ...SAMPLE, ...f });
const read = (text: string) => readKosovoMrz(text, { now });
const original = parseTd1(card(), { now }).data!;
const covered = (d: NonNullable<ReturnType<typeof parseTd1>['data']>) => ({ n: d.documentNumber, b: d.birthDate, e: d.expiryDate, p: d.personalNumber });

describe('alignLine', () => {
  it('leaves a perfect line alone', () => {
    for (const [i, line] of card().entries()) {
      const a = alignLine(line, TEMPLATES[i]);
      expect(a).toEqual({ line, cost: 0, edits: 0 });
    }
  });

  it('puts back lost trailing fillers and drops extra ones, always producing 30 characters', () => {
    const [l1, , l3] = card();
    for (const cut of [1, 2, 3, 5, 9]) {
      expect(alignLine(l1.slice(0, 30 - cut), TEMPLATES[0]).line).toBe(l1);
      expect(alignLine(l3.slice(0, 30 - cut), TEMPLATES[2]).line).toBe(l3);
    }
    for (const extra of [1, 2, 4]) {
      expect(alignLine(l1 + '<'.repeat(extra), TEMPLATES[0]).line).toBe(l1);
      expect(alignLine(l3 + '<'.repeat(extra), TEMPLATES[2]).line).toBe(l3);
    }
  });

  it('prefers to repair at the end of a line, never in the middle of the data', () => {
    const l3 = card()[2];
    const shortened = alignLine(l3.slice(0, 22), TEMPLATES[2]).line;
    expect(shortened.slice(0, 22)).toBe(l3.slice(0, 22));
    expect(shortened.slice(22)).toBe('<'.repeat(8));
  });

  it('always returns exactly 30 characters, whatever it is given', () => {
    for (const raw of ['', 'A', 'X'.repeat(80), '<'.repeat(45), '1234567890'.repeat(4)]) {
      for (const t of TEMPLATES) expect(alignLine(raw, t).line).toHaveLength(30);
    }
  });

  it('costs more the further a line is from the layout, so garbage can be rejected', () => {
    const good = alignLine(card()[0].slice(0, 27), TEMPLATES[0]).cost;
    const junk = alignLine('QWERTYUIOPASDFGHJKLZXCVBNM1234', TEMPLATES[0]).cost;
    expect(good).toBeLessThan(2);
    expect(junk).toBeGreaterThan(5);
  });
});

describe('cleanMrzText', () => {
  it('keeps only MRZ characters and normalises look-alike brackets and case', () => {
    expect(cleanMrzText('id rks 12.34-56 «‹ab')).toBe('IDRKS123456<<AB');
  });
});

describe('trimJunkTail', () => {
  it('drops a few stray characters after a run of fillers, and only then', () => {
    expect(trimJunkTail('TESTI<<DEMA<<<<<<<<<<A99')).toBe('TESTI<<DEMA<<<<<<<<<<');
    expect(trimJunkTail('TESTI<<DEMA<<<<X')).toBe('TESTI<<DEMA<<<<');
    // names, separators and full-length lines are left alone
    expect(trimJunkTail('TESTI<<DEMA')).toBe('TESTI<<DEMA');
    expect(trimJunkTail('TESTI<<DEMA<<MARIA')).toBe('TESTI<<DEMA<<MARIA');
    expect(trimJunkTail('ABCDEFGHIJKLMNOPQRSTUVWXYZ1234')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ1234');
    // a longer tail is not a speck
    expect(trimJunkTail('TESTI<<DEMA<<<<ABCDEF')).toBe('TESTI<<DEMA<<<<ABCDEF');
  });
});

describe('readKosovoMrz with lines of the wrong length', () => {
  it('reads what a real photo gave: 31, 30 and 27 characters with a short junk line after', () => {
    const [l1, l2, l3] = card();
    const text = [l1 + '<', l2, l3.slice(0, 27), 'XYZ12'].join('\n');
    const r = read(text)!;
    expect(r.result.ok).toBe(true);
    expect(covered(r.result.data!)).toEqual(covered(original));
    expect(r.result.data).toMatchObject({ surname: 'TESTI', givenNames: 'DEMA', birthDate: '1990-05-15' });
    expect(r.repaired).toBe(true);
    expect(r.result.issues.map((i) => i.code)).toContain('OCR_REPAIRED'); // so a person still looks
  });

  it.each([
    ['filler lost at the end of line 1', (l: string[]) => [l[0].slice(0, 26), l[1], l[2]]],
    ['filler lost at the end of line 3', (l: string[]) => [l[0], l[1], l[2].slice(0, 20)]],
    ['extra fillers on line 1', (l: string[]) => [l[0] + '<<<', l[1], l[2]]],
    ['extra fillers on line 3', (l: string[]) => [l[0], l[1], l[2] + '<<']],
    ['both ends wrong at once', (l: string[]) => [l[0] + '<', l[1], l[2].slice(0, 25)]],
    ['stray marks in the filler', (l: string[]) => [l[0].slice(0, 20) + '.' + l[0].slice(20), l[1], l[2].slice(0, 10) + ',' + l[2].slice(10)]],
    ['spaces inside lines', (l: string[]) => l.map((x) => x.slice(0, 12) + ' ' + x.slice(12))],
    ['lower case', (l: string[]) => l.map((x) => x.toLowerCase())],
  ])('recovers: %s', (_name, damage) => {
    const r = read(damage(card()).join('\n'))!;
    expect(r.result.ok).toBe(true);
    expect(covered(r.result.data!)).toEqual(covered(original));
  });

  it('skips junk lines before, between and after the three lines', () => {
    const [l1, l2, l3] = card();
    for (const text of [
      ['Data e leshimit Date of issue', 'Personal No.', l1, l2, l3.slice(0, 24), '5'].join('\n'),
      ['AB', l1.slice(0, 28), 'noise', l2, l3].join('\n'),
      ['...', l1, l2, l3, 'trailing words here', 'X'].join('\n'),
    ]) {
      const r = read(text);
      expect(r?.result.ok).toBe(true);
      expect(covered(r!.result.data!)).toEqual(covered(original));
    }
  });

  it('skips a junk line between the MRZ lines, even a long one or a 12-character label', () => {
    const [l1, l2, l3] = card();
    for (const junk of ['DATEOFISSUE1', 'PERSONALNUMBERRESIDENCEADDRESS', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ']) {
      const r = read([l1 + '<', junk, l2, l3.slice(0, 27)].join('\n'));
      expect(r?.result.ok).toBe(true);
      expect(covered(r!.result.data!)).toEqual(covered(original));
      const r2 = read([l1 + '<', l2, junk, l3.slice(0, 27)].join('\n'));
      expect(r2?.result.ok).toBe(true);
    }
  });

  it('does not let a closer-fitting but damaged triple hide a valid one further down', () => {
    const [l1, l2, l3] = card();
    const tampered = l1.slice(0, 7) + (l1[7] === '9' ? '8' : '9') + l1.slice(8); // wrong document digit, fits the layout perfectly
    // The damaged triple fits the layout exactly (cost 0); the valid one needs filler repairs
    const text = [tampered, l2, l3, 'LABEL', l1 + '<<', l2, l3.slice(0, 25)].join('\n');
    const r = read(text);
    expect(r?.result.ok).toBe(true);
    expect(covered(r!.result.data!)).toEqual(covered(original));
  });

  it('with only the damaged triple present, still reports it as not valid', () => {
    const [l1, l2, l3] = card();
    const tampered = l1.slice(0, 7) + (l1[7] === '9' ? '8' : '9') + l1.slice(8);
    expect(read([tampered, l2, l3].join('\n'))?.result.ok ?? false).toBe(false);
  });

  it('reads a card whose name line ends in stray characters after the fillers', () => {
    const [l1, l2, l3] = card();
    for (const tail of ['A99', 'X', '12', 'AB9']) {
      const r = read([l1, l2, l3.slice(0, 25) + tail].join('\n'));
      expect(r?.result.ok).toBe(true);
      expect(covered(r!.result.data!)).toEqual(covered(original));
      expect(r!.result.data).toMatchObject({ surname: 'TESTI', givenNames: 'DEMA' });
    }
    // the same on line 1
    expect(read([l1 + 'A99', l2, l3].join('\n'))?.result.ok).toBe(true);
  });

  it('writes the fixed characters of the layout when OCR gave a look-alike, without a warning about them', () => {
    const [l1, l2, l3] = card();
    for (const first of ['1', 'L']) {
      const r = read([first + l1.slice(1), l2, l3].join('\n'))!;
      expect(r.result.ok).toBe(true);
      expect(r.result.data!.documentType).toBe('ID');
      expect(r.result.issues.map((i) => i.code)).not.toContain('UNEXPECTED_DOCUMENT_TYPE');
    }
    // a different, non-look-alike character is not turned into an I
    const x = read(['X' + l1.slice(1) + '<', l2, l3].join('\n'));
    expect(x?.result.data?.documentType ?? 'X').not.toBe('ID');
  });

  it('also fixes a misread state on lines of the right length, and says it was repaired', () => {
    const [l1, l2, l3] = card();
    const misread = [l1.replace('RKS', 'RK5'), l2.replace('RKS', 'RK5'), l3];
    const r = read(misread.join('\n'))!;
    expect(r.result.ok).toBe(true);
    expect(r.result.data).toMatchObject({ issuingState: 'RKS', nationality: 'RKS' });
    expect(r.result.issues.map((i) => i.code)).not.toContain('UNEXPECTED_ISSUER');
    expect(r.result.issues.map((i) => i.code)).not.toContain('UNEXPECTED_NATIONALITY');
    expect(r.repaired).toBe(true);
    expect(r.result.issues.map((i) => i.code)).toContain('OCR_REPAIRED');
  });

  it('still reads a clean card exactly as before, without calling it repaired', () => {
    const r = read(card().join('\n'))!;
    expect(r.result.ok).toBe(true);
    expect(r.repaired).toBe(false);
    expect(r.result.issues.map((i) => i.code)).not.toContain('OCR_REPAIRED');
  });

  it('never accepts a repaired read whose check digits disagree', () => {
    const [l1, l2, l3] = card();
    const tampered = l2.slice(0, 2) + (l2[2] === '9' ? '8' : '9') + l2.slice(3); // a changed birth-date digit
    const r = read([l1 + '<', tampered, l3.slice(0, 25)].join('\n'));
    expect(r?.result.ok ?? false).toBe(false);
    // ...and a lost digit in the data is not "fixed" into something else
    const lostDigit = read([l1, l2.slice(0, 3) + l2.slice(4), l3].join('\n'));
    expect(lostDigit?.result.ok ?? false).toBe(false);
  });

  it('reports a repaired read with the wrong field shape as not valid, never as a read', () => {
    // A lost trailing zero of the personal number passes the check digits (a `<` weighs 0)...
    const p = buildTd1({ ...SAMPLE, personalNumber: '1087354000' });
    const lost = [p[0], p[1].slice(0, 27) + p[1].slice(28), p[2]]; // 29 characters: one zero gone
    const r = read(lost.join('\n'));
    // ...so it must not come back ok, nor be marked as a clean read
    expect(r?.result.ok ?? false).toBe(false);
    expect(r?.result.issues.map((i) => i.code)).toContain('MRZ_SHAPE_INVALID');
  });

  it('does not invent an MRZ out of ordinary text or noise', () => {
    expect(read('Republika e Kosoves Republic of Kosovo\nLetërnjoftim Identity Card\nDate of issue\nResidence')).toBeNull();
    expect(read('QWERTYUIOPASDFGHJKLZXCVBNM1234\nASDFGHJKLQWERTYUIOPZXCVBNM5678\nZXCVBNMASDFGHJKLQWERTYUIOP9012')?.result.ok ?? false).toBe(false);
    expect(read('')).toBeNull();
    expect(read('<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<\n<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<\n<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<')?.result.ok ?? false).toBe(false);
  });
});

// Deterministic pseudo-random numbers, so a failure can be reproduced
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe('safety: a repair can never produce different data that still passes the check digits', () => {
  const r = rng(20261004);
  const pick = (n: number) => Math.floor(r() * n);
  const letters = (n: number) => Array.from({ length: n }, () => String.fromCharCode(65 + pick(26))).join('');
  const digits = (n: number) => Array.from({ length: n }, () => pick(10)).join('');
  const person = (): Td1Fields => ({
    documentNumber: letters(2) + digits(7),
    birth: `${String(60 + pick(40)).padStart(2, '0')}${String(1 + pick(12)).padStart(2, '0')}${String(1 + pick(28)).padStart(2, '0')}`,
    sex: pick(2) ? 'M' : 'F',
    expiry: `${String(27 + pick(8)).padStart(2, '0')}${String(1 + pick(12)).padStart(2, '0')}${String(1 + pick(28)).padStart(2, '0')}`,
    personalNumber: digits(10),
    surname: letters(3 + pick(8)),
    givenNames: letters(3 + pick(8)),
  });
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<';
  const mutate = (line: string) => {
    const i = pick(line.length + 1);
    const c = ALPHABET[pick(ALPHABET.length)];
    const kind = pick(3);
    return kind === 0 ? line.slice(0, i) + c + line.slice(i) : kind === 1 ? line.slice(0, i) + line.slice(i + 1) : line.slice(0, i) + c + line.slice(i + 1);
  };

  it('a single damaged character is never turned into a different card', () => {
    let recovered = 0;
    let rejected = 0;
    for (let n = 0; n < 500; n++) {
      const lines = buildTd1(person());
      const truth = covered(parseTd1(lines, { now }).data!);
      for (let trial = 0; trial < 6; trial++) {
        const damaged = [...lines];
        const which = pick(3);
        damaged[which] = mutate(damaged[which]);
        const res = readKosovoMrz(damaged.join('\n'), { now });
        if (res?.result.ok && res.result.data) {
          // The exact reader's own blind spots (a letter and a digit can weigh the same in a check
          // digit, so R read as 7 passes) are not what is under test; only repaired reads are
          if (res.repaired) expect(covered(res.result.data)).toEqual(truth);
          recovered++;
        } else rejected++;
      }
    }
    // It does help (some damaged reads are recovered) and it does refuse (others are not guessed)
    expect(recovered).toBeGreaterThan(200);
    expect(rejected).toBeGreaterThan(200);
  });

  it('with several damaged characters a wrong card is accepted only as rarely as the check digits allow', () => {
    // One check digit cannot catch every combination of errors (about one in ten for errors that
    // cancel out), and that is true of the exact reader too. The repair adds no new way in: it
    // never invents or chooses digits. The accepted-wrong rate must stay near zero.
    let accepted = 0;
    let wrong = 0;
    const total = 2000;
    for (let n = 0; n < total; n++) {
      const lines = buildTd1(person());
      const truth = covered(parseTd1(lines, { now }).data!);
      const damaged = [...lines];
      for (let k = 0; k < 2 + pick(2); k++) {
        const which = pick(3);
        damaged[which] = mutate(damaged[which]);
      }
      const res = readKosovoMrz(damaged.join('\n'), { now });
      if (res?.result.ok && res.result.data) {
        accepted++;
        if (res.repaired && JSON.stringify(covered(res.result.data)) !== JSON.stringify(truth)) wrong++;
      }
    }
    expect(wrong / total).toBeLessThan(0.01);
    expect(accepted).toBeGreaterThanOrEqual(wrong);
  });

  it('and over random edits that only change line lengths, almost all are recovered', () => {
    let ok = 0;
    let total = 0;
    for (let n = 0; n < 200; n++) {
      const lines = buildTd1(person());
      const truth = covered(parseTd1(lines, { now }).data!);
      const damaged = [lines[0], lines[1], lines[2]];
      damaged[0] = damaged[0].slice(0, 30 - pick(8)) + '<'.repeat(pick(3));
      damaged[2] = damaged[2].slice(0, 30 - pick(10)) + '<'.repeat(pick(3));
      const res = readKosovoMrz(damaged.join('\n'), { now });
      total++;
      if (res?.result.ok && res.result.data) {
        expect(covered(res.result.data)).toEqual(truth);
        ok++;
      }
    }
    expect(ok / total).toBeGreaterThan(0.95);
  });
});
