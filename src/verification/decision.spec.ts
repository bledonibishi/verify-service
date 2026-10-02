import { buildTd1, SAMPLE } from '../documents/mrz/testing';
import { checkIdBack, decide, emptyOutcome } from './decision';

const who = { firstName: 'Dema', lastName: 'Testi', birthDate: '1990-05-15' };
const text = (lines = buildTd1(SAMPLE)) => lines.join('\n');
const now = new Date('2026-10-02T00:00:00Z');

describe('checkIdBack / decide', () => {
  it('approves only a clean match with auto-approve on', () => {
    const outcome = checkIdBack(text(), who, now);
    expect(outcome.issueCodes).toEqual([]);
    expect(decide(outcome, true)).toBe('APPROVED');
    expect(decide(outcome, false)).toBe('NEEDS_REVIEW');
  });

  it('treats an OCR repair as not clean', () => {
    const lines = buildTd1(SAMPLE);
    lines[1] = lines[1].replace('900515', '9O0515');
    const outcome = checkIdBack(text(lines), who, now);
    expect(outcome.ocrRepaired).toBe(true);
    expect(decide(outcome, true)).toBe('NEEDS_REVIEW');
  });

  it('never approves without an expected identity', () => {
    expect(decide(checkIdBack(text(), {}, now), true)).toBe('NEEDS_REVIEW');
  });

  it('never approves an empty outcome', () => {
    expect(decide(emptyOutcome('MRZ_NOT_FOUND'), true)).toBe('NEEDS_REVIEW');
  });
});
