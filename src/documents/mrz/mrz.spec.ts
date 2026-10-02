import { checkDigit } from './check-digit';
import { compareIdentity, normalizeName } from './identity';
import { extractTd1Lines, parseKosovoTd1, repairKosovoTd1 } from './repair';
import { parseTd1 } from './td1';
import { SAMPLE, buildTd1 } from './testing';

const NOW = new Date('2026-10-02T00:00:00Z');

describe('checkDigit', () => {
  it('matches the ICAO 9303 specimen values', () => {
    expect(checkDigit('L898902C3')).toBe('6');
    expect(checkDigit('740812')).toBe('2');
    expect(checkDigit('120415')).toBe('9');
  });

  it('treats the filler as zero', () => {
    expect(checkDigit('<<<<<<<<<')).toBe('0');
  });
});

describe('parseTd1', () => {
  it('accepts a valid Kosovo-style card and decodes it', () => {
    const res = parseTd1(buildTd1(SAMPLE), { now: NOW });
    expect(res.ok).toBe(true);
    expect(res.checks.every((c) => c.ok)).toBe(true);
    expect(res.issues).toEqual([]);
    expect(res.data).toMatchObject({
      documentType: 'ID',
      issuingState: 'RKS',
      nationality: 'RKS',
      documentNumber: 'ID0000001',
      personalNumber: '1000000001',
      birthDate: '1990-05-15',
      expiryDate: '2029-01-31',
      sex: 'F',
      surname: 'TESTI',
      givenNames: 'DEMA',
      expired: false,
    });
  });

  it('accepts the RKS issuer code that generic ISO-based parsers reject', () => {
    const res = parseTd1(buildTd1(SAMPLE), { now: NOW });
    expect(res.issues.find((i) => i.code === 'UNEXPECTED_ISSUER')).toBeUndefined();
  });

  it('decodes multiple given names and compound surnames', () => {
    const lines = buildTd1({ ...SAMPLE, surname: 'KRASNIQI HOXHA', givenNames: 'ARTA MARIA' });
    const res = parseTd1(lines, { now: NOW });
    expect(res.data).toMatchObject({ surname: 'KRASNIQI HOXHA', givenNames: 'ARTA MARIA' });
  });

  it('infers the century for birth dates', () => {
    expect(parseTd1(buildTd1({ ...SAMPLE, birth: '010601' }), { now: NOW }).data?.birthDate).toBe('2001-06-01');
    expect(parseTd1(buildTd1({ ...SAMPLE, birth: '450601' }), { now: NOW }).data?.birthDate).toBe('1945-06-01');
  });

  it('flags an expired document without invalidating the MRZ', () => {
    const res = parseTd1(buildTd1({ ...SAMPLE, expiry: '200101' }), { now: NOW });
    expect(res.ok).toBe(true);
    expect(res.data?.expired).toBe(true);
  });

  it('rejects a tampered check digit', () => {
    const lines = buildTd1(SAMPLE);
    lines[1] = lines[1].slice(0, 8) + '3' + lines[1].slice(9); // change an expiry digit
    const res = parseTd1(lines, { now: NOW });
    expect(res.ok).toBe(false);
    expect(res.checks.some((c) => !c.ok)).toBe(true);
    expect(res.issues.some((i) => i.code === 'CHECK_DIGIT_MISMATCH')).toBe(true);
  });

  it('rejects a swapped personal number via the composite check', () => {
    const lines = buildTd1(SAMPLE);
    lines[1] = lines[1].slice(0, 18) + '2000000002' + lines[1].slice(28);
    const res = parseTd1(lines, { now: NOW });
    expect(res.ok).toBe(false);
    expect(res.checks.find((c) => c.field === 'composite')?.ok).toBe(false);
  });

  it('rejects impossible calendar dates even with valid check digits', () => {
    const res = parseTd1(buildTd1({ ...SAMPLE, birth: '900230' }), { now: NOW });
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.code === 'INVALID_BIRTH_DATE')).toBe(true);
  });

  it('warns about stray characters in the optional field that check digits cannot catch', () => {
    const lines = buildTd1(SAMPLE);
    lines[0] = lines[0].slice(0, 15) + 'K'.repeat(15);
    const res = parseTd1(lines, { now: NOW });
    expect(res.checks.every((c) => c.ok)).toBe(true); // the weakness being documented
    expect(res.issues.map((i) => i.code)).toContain('OPTIONAL_DATA_PRESENT');
  });

  it('rejects wrong shapes and characters', () => {
    expect(parseTd1(['ID'], { now: NOW }).issues[0].code).toBe('WRONG_LENGTH');
    const lines = buildTd1(SAMPLE);
    lines[2] = lines[2].slice(0, 29) + 'ë';
    expect(parseTd1(lines, { now: NOW }).issues[0].code).toBe('INVALID_CHARACTERS');
  });

  it('warns, but does not fail, when the card deviates from the Kosovo profile', () => {
    const res = parseTd1(buildTd1({ ...SAMPLE, issuer: 'ALB', nationality: 'ALB' }), { now: NOW });
    expect(res.ok).toBe(true);
    const codes = res.issues.map((i) => i.code);
    expect(codes).toContain('UNEXPECTED_ISSUER');
    expect(codes).toContain('UNEXPECTED_NATIONALITY');
  });
});

describe('OCR repair', () => {
  const good = buildTd1(SAMPLE);

  it('fixes look-alike swaps in numeric and alphabetic positions', () => {
    const noisy = [...good];
    noisy[1] = noisy[1].replace('900515', '9O05I5'); // O and I where digits belong
    noisy[2] = noisy[2].replace('TESTI', 'TEST1'); // a digit where a letter belongs
    const res = parseKosovoTd1(noisy, { now: NOW });
    expect(res.repaired).toBe(true);
    expect(res.result.ok).toBe(true);
    expect(res.result.data?.birthDate).toBe('1990-05-15');
    expect(res.result.data?.surname).toBe('TESTI');
  });

  it('keeps a name ending in S or E intact while repairing other characters', () => {
    const noisy = buildTd1({ ...SAMPLE, givenNames: 'ALES' });
    noisy[1] = noisy[1].replace('900515', '9O05I5');
    const res = parseKosovoTd1(noisy, { now: NOW });
    expect(res.repaired).toBe(true);
    expect(res.result.data?.givenNames).toBe('ALES');
  });

  it('fixes filler characters misread as letters', () => {
    const noisy = [...good];
    noisy[0] = noisy[0].slice(0, 15) + 'KKKKKKKKKKKKKKK';
    noisy[2] = noisy[2].slice(0, 11) + 'CCCCCCCCCCCCCCCCCCC'.slice(0, 19);
    const res = parseKosovoTd1(noisy, { now: NOW });
    expect(res.result.ok).toBe(true);
    expect(res.lines).toEqual(good);
  });

  it('leaves a clean MRZ alone and does not mangle names containing O, I or S', () => {
    const lines = buildTd1({ ...SAMPLE, surname: 'BORISI', givenNames: 'OLSI' });
    const res = parseKosovoTd1(lines, { now: NOW });
    expect(res.repaired).toBe(false);
    expect(res.result.data).toMatchObject({ surname: 'BORISI', givenNames: 'OLSI' });
  });

  it('never repairs a genuinely altered card into a pass', () => {
    const forged = [...good];
    forged[1] = forged[1].slice(0, 9) + '8' + forged[1].slice(10); // 2029 -> 2028, check digits untouched
    const res = parseKosovoTd1(forged, { now: NOW });
    expect(res.result.ok).toBe(false);
    expect(res.repaired).toBe(false);
  });

  it('leaves wrongly sized input untouched', () => {
    expect(repairKosovoTd1(['ID', 'x', 'y'])).toEqual(['ID', 'x', 'y']);
  });
});

describe('extractTd1Lines', () => {
  const good = buildTd1(SAMPLE);

  it('finds the zone among other OCR text, tolerating case and spaces', () => {
    const text = ['DATA E LESHIMIT', '30.01.2024', ...good.map((l) => l.toLowerCase().replace(/(.{10})/g, '$1 ')), 'VUSHTRRI'].join('\n');
    expect(extractTd1Lines(text)).toEqual(good);
  });

  it('finds the zone when OCR returns it as one string', () => {
    expect(extractTd1Lines(good.join(''))).toEqual(good);
  });

  it('normalises look-alike filler glyphs', () => {
    expect(extractTd1Lines(good.map((l) => l.replace(/</g, '«')).join('\n'))).toEqual(good);
  });

  it('returns null when there is no MRZ', () => {
    expect(extractTd1Lines('REPUBLIKA E KOSOVES\nLETERNJOFTIM')).toBeNull();
  });
});

describe('identity comparison', () => {
  const data = parseTd1(buildTd1({ ...SAMPLE, surname: 'KRASNIQI', givenNames: 'HENA MARIA' }), { now: NOW }).data!;

  it('normalises Albanian diacritics the way the MRZ does', () => {
    expect(normalizeName('Hëna Çelik-Gashi')).toBe('HENA CELIK GASHI');
  });

  it('matches names regardless of case, diacritics and partial given names', () => {
    expect(
      compareIdentity(data, { firstName: 'Hëna', lastName: 'Krasniqi', birthDate: '1990-05-15' }),
    ).toEqual({ surname: 'match', givenNames: 'match', birthDate: 'match' });
    expect(compareIdentity(data, { firstName: 'Hena Maria' }).givenNames).toBe('match');
  });

  it('reports mismatches and omitted fields', () => {
    expect(compareIdentity(data, { lastName: 'Gashi', birthDate: '1990-05-16' })).toEqual({
      surname: 'mismatch',
      givenNames: 'not_provided',
      birthDate: 'mismatch',
    });
  });
});
