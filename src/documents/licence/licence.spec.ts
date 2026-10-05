import { buildTd1, SAMPLE } from '../mrz/testing';
import { parseTd1 } from '../mrz';
import { checkLicence, licenceClean } from './check';
import { parseLicenceFields } from './parse';
import { buildLicenceText, SAMPLE_LICENCE } from './testing';

const now = new Date('2026-10-04T00:00:00Z');
const id = parseTd1(buildTd1(SAMPLE), { now }).data!;
const text = (over: Partial<typeof SAMPLE_LICENCE> = {}) => buildLicenceText({ ...SAMPLE_LICENCE, ...over });

describe('parseLicenceFields', () => {
  it('reads every printed field of a clean licence', () => {
    const r = parseLicenceFields(text());
    expect(r.found).toEqual(['1', '2', '3', '4a', '4b', '4d', '5', '9']);
    expect(r.fields).toMatchObject({
      surname: 'TESTI',
      givenNames: 'DEMA',
      birthDate: '1990-05-15',
      issueDate: '2022-03-12',
      expiryDate: '2032-03-12',
      personalNumber: '1000000001',
      licenceNumber: 'DL1234567',
      categories: ['AM', 'B'],
    });
    expect(r.repaired).toBe(false);
  });

  it('does not read a date that has letters or digits glued to it', () => {
    const glued = (suffix: string, prefix = '') => parseLicenceFields(`1. TESTI\n2. DEMA\n3. 15.05.1990 PRISHTINE\n4a. ${prefix}12.03.2022${suffix}\n4b. 12.03.2032\n4d. 1000000001\n5. DL1234567\n9. B`);
    for (const suffix of ['GARBAGE', 'X', 'B1', '7']) {
      const r = glued(suffix);
      expect(r.found).not.toContain('4a');
      expect(r.fields.issueDate).toBeUndefined();
    }
    expect(glued('', 'X').found).not.toContain('4a');
    // spaces and the usual neighbours are fine
    for (const ok of [glued(''), glued(' '), glued(' 4b.')]) expect(ok.fields.issueDate).toBe('2022-03-12');
  });

  it('does not mistake dates for field labels, and reads fields in any order and layout', () => {
    // Field 3 holds a date that itself contains "5." and "3."; everything on one line is also fine
    const r = parseLicenceFields('1. TESTI 2. DEMA 3. 05.03.1990 PRISHTINE 4a. 12.03.2022 4b. 12.03.2032 4d. 1000000001 5. DL1234567 9. B');
    expect(r.fields).toMatchObject({ surname: 'TESTI', givenNames: 'DEMA', birthDate: '1990-03-05', issueDate: '2022-03-12', personalNumber: '1000000001' });
    const shuffled = parseLicenceFields(['9. B', '4d. 1000000001', '5. DL1234567', '3. 15.05.1990 X', '4b. 12.03.2032', '4a. 12.03.2022', '2. DEMA', '1. TESTI'].join('\n'));
    expect(shuffled.found).toHaveLength(8);
  });

  it('copes with ë/ç, Cyrillic noise, lower case and separators', () => {
    const r = parseLicenceFields('1) Krasniqi\n2) Arta Ëndërr\n3) 15/05/1990 Prishtinë 4a) 12-03-2022 4b) 12-03-2032\n4d) 1000000001\n5) dl 1234567\n9) am, b ПРИШТИНА');
    expect(r.fields).toMatchObject({ surname: 'KRASNIQI', givenNames: 'ARTA ENDERR', birthDate: '1990-05-15', issueDate: '2022-03-12' });
    expect(r.fields.licenceNumber).toBe('DL1234567');
    expect(r.fields.categories).toEqual(['AM', 'B']);
  });

  it('repairs look-alike characters in dates and numbers, and says so', () => {
    const r = parseLicenceFields(text({ personalNumber: '1OOOOOOOO1', issue: '12.O3.2022' }));
    expect(r.fields.personalNumber).toBe('1000000001');
    expect(r.fields.issueDate).toBe('2022-03-12');
    expect(r.repaired).toBe(true);
  });

  it('leaves out what it cannot read instead of guessing', () => {
    const r = parseLicenceFields('1. TESTI\n2. DEMA\n3. 31.02.1990\n4d. 12345\n5. XYZ');
    expect(r.found).toEqual(['1', '2']);
    expect(r.fields.birthDate).toBeUndefined(); // 31 February
    expect(r.fields.personalNumber).toBeUndefined(); // too short
    expect(parseLicenceFields('').found).toEqual([]);
    expect(parseLicenceFields('random text with 15.05.1990 and 1000000001').found).toEqual([]);
  });

  it('accepts only the documented DL-plus-digits licence number', () => {
    expect(parseLicenceFields('5. DL1234567').found).toEqual(['5']);
    expect(parseLicenceFields('5. dl 1234567').found).toEqual(['5']);
    for (const bad of ['5. XYZ1234567', '5. AB1234567', '5. 1234567', '5. DL123', '5. DL12345678901', '5. DL1234567X']) {
      expect(parseLicenceFields(bad).found).toEqual([]);
    }
  });

  it('treats names with digits or stray punctuation as unreadable, not as the name without them', () => {
    expect(parseLicenceFields('1. TESTI').fields.surname).toBe('TESTI');
    expect(parseLicenceFields("1. O'NEILL-SMITH").fields.surname).toBe('O NEILL SMITH');
    for (const bad of ['1. TESTI123', '1. TE5TI', '1. TESTI|', '1. T', '1. ПРИШТИНА', '1. TESTI, DEMA']) {
      const r = parseLicenceFields(bad);
      expect(r.found).toEqual([]);
      expect(r.fields.surname).toBeUndefined();
    }
  });

  it('does not trim a personal number or a date that is longer or shorter than it should be', () => {
    for (const bad of ['4d. 10000000011', '4d. 100000000', '4d. 1000000001234', '4d. 1000 000001']) {
      expect(parseLicenceFields(bad).found).toEqual([]);
    }
    // Stray text after a valid number means the read is damaged, so the field is not accepted
    for (const bad of ['4d. 1000000001 extra', '4d. 1000000001\nsome other line', '4d. 1000000001 1000000001', '4d. 1000000001.', '5. DL1234567 extra', '5. DL1234567\nstray', '5. DL1234567 DL7654321']) {
      expect(parseLicenceFields(bad).found).toEqual([]);
    }
    expect(parseLicenceFields('4d.  1000000001\n').found).toEqual(['4d']); // surrounding whitespace is fine
    for (const bad of ['3. 115.05.1990', '3. 15.05.19901', '3. 15.05.199', '3. 1990']) {
      expect(parseLicenceFields(bad).found).toEqual([]);
    }
  });

  it('uses the first occurrence of a label', () => {
    expect(parseLicenceFields('1. TESTI\n1. OTHER').fields.surname).toBe('TESTI');
  });
});

describe('checkLicence', () => {
  it('is clean when everything is read and matches the ID', () => {
    const r = checkLicence(text(), id, now);
    expect(r).toMatchObject({ found: true, expired: false, datesValid: true, repaired: false, personalNumber: 'match', surname: 'match', givenNames: 'match', birthDate: 'match', issueCodes: [] });
    expect(licenceClean(r)).toBe(true);
  });

  it('matches names the way the MRZ prints them (ë becomes E)', () => {
    const arta = parseTd1(buildTd1({ ...SAMPLE, surname: 'KRASNIQI', givenNames: 'ARTA ENDERR' }), { now }).data!;
    const r = checkLicence(text({ surname: 'Krasniqi', givenNames: 'Arta Ëndërr' }), arta, now);
    expect(r.surname).toBe('match');
    expect(r.givenNames).toBe('match');
  });

  it('lets a licence omit later given names but never add any', () => {
    const one = parseTd1(buildTd1({ ...SAMPLE, givenNames: 'DEMA' }), { now }).data!;
    expect(checkLicence(text({ givenNames: 'DEMA ARTA' }), one, now).givenNames).toBe('mismatch');
    const two = parseTd1(buildTd1({ ...SAMPLE, givenNames: 'DEMA ARTA' }), { now }).data!;
    expect(checkLicence(text({ givenNames: 'DEMA' }), two, now).givenNames).toBe('match');
    expect(checkLicence(text({ givenNames: 'DEMA ARTA' }), two, now).givenNames).toBe('match');
    expect(checkLicence(text({ givenNames: 'ARTA DEMA' }), two, now).givenNames).toBe('mismatch');
  });

  it('accepts a licence that prints only the first given name, but not a different one', () => {
    const two = parseTd1(buildTd1({ ...SAMPLE, givenNames: 'DEMA ARTA' }), { now }).data!;
    expect(checkLicence(text({ givenNames: 'DEMA' }), two, now).givenNames).toBe('match');
    expect(checkLicence(text({ givenNames: 'ARTA' }), two, now).givenNames).toBe('mismatch');
  });

  it.each([
    ['personal number', { personalNumber: '1000000002' }, 'LICENCE_PERSONAL_NUMBER_MISMATCH', 'personalNumber'],
    ['surname', { surname: 'OTHER' }, 'LICENCE_SURNAME_MISMATCH', 'surname'],
    ['given names', { givenNames: 'OTHER' }, 'LICENCE_GIVEN_NAMES_MISMATCH', 'givenNames'],
    ['date of birth', { birth: '16.05.1990' }, 'LICENCE_BIRTH_DATE_MISMATCH', 'birthDate'],
  ] as const)('flags a different %s', (_n, over, code, key) => {
    const r = checkLicence(text(over), id, now);
    expect(r[key]).toBe('mismatch');
    expect(r.issueCodes).toContain(code);
    expect(licenceClean(r)).toBe(false);
  });

  it('flags an expired licence', () => {
    const r = checkLicence(text({ issue: '12.03.2010', expiry: '12.03.2020' }), id, now);
    expect(r.expired).toBe(true);
    expect(r.issueCodes).toContain('LICENCE_EXPIRED');
    expect(licenceClean(r)).toBe(false);
  });

  it('treats a licence expiring today as still valid', () => {
    expect(checkLicence(text({ issue: '04.10.2016', expiry: '04.10.2026' }), id, now).expired).toBe(false);
  });

  it.each([
    ['issued in the future', { issue: '12.03.2030', expiry: '12.03.2040' }],
    ['expiring before it was issued', { issue: '12.03.2022', expiry: '12.03.2020' }],
    ['valid for 40 years', { issue: '12.03.2022', expiry: '12.03.2062' }],
    ['valid for a day', { issue: '12.03.2022', expiry: '13.03.2022' }],
    ['issued to someone aged 10', { birth: '15.05.2012' }],
  ])('flags implausible dates: %s', (_n, over) => {
    const r = checkLicence(text(over), id, now);
    expect(r.datesValid).toBe(false);
    expect(r.issueCodes).toContain('LICENCE_DATES_IMPLAUSIBLE');
  });

  it('never calls it clean when the ID could not be read, or the licence is unreadable', () => {
    const noId = checkLicence(text(), null, now);
    expect(noId).toMatchObject({ personalNumber: 'unavailable', surname: 'unavailable', givenNames: 'unavailable', birthDate: 'unavailable' });
    expect(noId.issueCodes).toEqual(['LICENCE_CROSSCHECK_UNAVAILABLE']);
    expect(licenceClean(noId)).toBe(false);
    const junk = checkLicence('nothing here', id, now);
    expect(junk.found).toBe(false);
    expect(junk.issueCodes).toContain('LICENCE_NOT_READABLE');
    expect(licenceClean(junk)).toBe(false);
  });

  it('reports a partly read licence as incomplete, and does not call missing fields a match', () => {
    const r = checkLicence('1. TESTI\n2. DEMA\n4d. 1000000001', id, now);
    expect(r.found).toBe(false);
    expect(r.issueCodes).toContain('LICENCE_FIELDS_INCOMPLETE');
    expect(r.birthDate).toBe('unavailable');
    expect(licenceClean(r)).toBe(false);
  });

  it('treats an OCR repair as not clean', () => {
    const r = checkLicence(text({ personalNumber: '1OOOOOOOO1' }), id, now);
    expect(r.personalNumber).toBe('match'); // the repaired value does match...
    expect(r.repaired).toBe(true);
    expect(r.issueCodes).toContain('LICENCE_OCR_REPAIRED');
    expect(licenceClean(r)).toBe(false); // ...but a person should still look
  });

  it('exposes no printed value in its result', () => {
    const dump = JSON.stringify(checkLicence(text(), id, now));
    for (const secret of ['TESTI', 'DEMA', '1000000001', '1990', 'DL1234567', 'PRISHTINE']) expect(dump).not.toContain(secret);
  });

  describe('date boundaries (calendar arithmetic)', () => {
    const valid = (over: Partial<typeof SAMPLE_LICENCE>, at = now) => checkLicence(text(over), id, at).datesValid;

    it('allows a holder on their fifteenth birthday, not the day before', () => {
      expect(valid({ birth: '28.02.2005', issue: '28.02.2020', expiry: '28.02.2030' })).toBe(true);
      expect(valid({ birth: '01.03.2005', issue: '28.02.2020', expiry: '28.02.2030' })).toBe(false);
      expect(valid({ birth: '01.03.2005', issue: '01.03.2020', expiry: '01.03.2030' })).toBe(true);
    });

    it('counts a 29 February birthday from 1 March in a common year', () => {
      expect(valid({ birth: '29.02.2004', issue: '28.02.2019', expiry: '28.02.2029' })).toBe(false);
      expect(valid({ birth: '29.02.2004', issue: '01.03.2019', expiry: '01.03.2029' })).toBe(true);
      expect(valid({ birth: '29.02.2004', issue: '29.02.2020', expiry: '28.02.2030' })).toBe(true);
    });

    it('allows exactly fifteen years of validity and not a day more', () => {
      expect(valid({ issue: '12.03.2022', expiry: '12.03.2037' })).toBe(true);
      expect(valid({ issue: '12.03.2022', expiry: '13.03.2037' })).toBe(false);
      expect(valid({ issue: '29.02.2020', expiry: '01.03.2035' })).toBe(true); // 29 Feb + 15 years = 1 Mar
      expect(valid({ issue: '29.02.2020', expiry: '02.03.2035' })).toBe(false);
    });

    it('requires at least six months of validity', () => {
      expect(valid({ issue: '12.03.2022', expiry: '12.09.2022' })).toBe(true);
      expect(valid({ issue: '12.03.2022', expiry: '11.09.2022' })).toBe(false);
    });

    it('rejects a licence issued tomorrow, with no allowance', () => {
      expect(valid({ issue: '05.10.2026', expiry: '05.10.2036' })).toBe(false); // tomorrow
      expect(valid({ issue: '04.10.2026', expiry: '04.10.2036' })).toBe(true); // today
    });

    it('uses the local (Kosovo) calendar day, not UTC, for "today"', () => {
      // 23:30 UTC on 3 October is already 4 October in Kosovo (CEST, UTC+2)
      const lateUtc = new Date('2026-10-03T23:30:00Z');
      expect(valid({ issue: '04.10.2026', expiry: '04.10.2036' }, lateUtc)).toBe(true);
      expect(valid({ issue: '05.10.2026', expiry: '05.10.2036' }, lateUtc)).toBe(false);
      expect(checkLicence(text({ issue: '04.10.2016', expiry: '04.10.2026' }), id, lateUtc).expired).toBe(false); // expires today
      expect(checkLicence(text({ issue: '03.10.2016', expiry: '03.10.2026' }), id, lateUtc).expired).toBe(true); // expired yesterday (local)
    });
  });
});
