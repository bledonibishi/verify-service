import { buildTd1, SAMPLE } from '../documents/mrz/testing';
import { checkIdBack, decide, emptyOutcome, faceOutcome, withFace } from './decision';

const who = { firstName: 'Dema', lastName: 'Testi', birthDate: '1990-05-15' };
const text = (lines = buildTd1(SAMPLE)) => lines.join('\n');
const goodFace = faceOutcome({ similarity: 97 }, 90);
const now = new Date('2026-10-02T00:00:00Z');

describe('checkIdBack / decide', () => {
  it('approves only a clean match with auto-approve on', () => {
    const outcome = withFace(checkIdBack(text(), who, now), goodFace);
    expect(outcome.issueCodes).toEqual([]);
    expect(decide(outcome, true)).toBe('APPROVED');
    expect(decide(outcome, false)).toBe('NEEDS_REVIEW');
  });

  it('treats an OCR repair as not clean', () => {
    const lines = buildTd1(SAMPLE);
    lines[1] = lines[1].replace('900515', '9O0515');
    const outcome = withFace(checkIdBack(text(lines), who, now), goodFace);
    expect(outcome.ocrRepaired).toBe(true);
    expect(decide(outcome, true)).toBe('NEEDS_REVIEW');
  });

  it('never approves without an expected identity', () => {
    expect(decide(withFace(checkIdBack(text(), {}, now), goodFace), true)).toBe('NEEDS_REVIEW');
  });

  it('never approves an empty outcome', () => {
    expect(decide(emptyOutcome('MRZ_NOT_FOUND'), true)).toBe('NEEDS_REVIEW');
  });

  it.each([
    ['below the threshold', faceOutcome({ similarity: 89.9 }, 90), 'FACE_BELOW_THRESHOLD'],
    ['no face found', faceOutcome({ status: 'no_face' }, 90), 'FACE_NOT_DETECTED'],
    ['an unusable image', faceOutcome({ status: 'unusable_image' }, 90), 'FACE_IMAGE_UNUSABLE'],
    ['face matching unavailable', null, 'FACE_UNAVAILABLE'],
    ['no face check at all', undefined, undefined],
  ])('never approves with %s', (_n, face, code) => {
    const doc = checkIdBack(text(), who, now);
    const outcome = face === undefined ? doc : withFace(doc, face);
    if (code) expect(outcome.issueCodes).toContain(code);
    expect(decide(outcome, true)).toBe('NEEDS_REVIEW');
  });

  it('applies the threshold inclusively', () => {
    expect(faceOutcome({ similarity: 90 }, 90).status).toBe('match');
    expect(faceOutcome({ similarity: 90 }, 90.1).status).toBe('below_threshold');
  });
});
