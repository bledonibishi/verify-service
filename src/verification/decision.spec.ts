import { buildTd1, SAMPLE } from '../documents/mrz/testing';
import { bindFaceToLiveness, checkIdBack, decide, emptyOutcome, faceOutcome, livenessOutcome, withFace, withLiveness } from './decision';

const who = { firstName: 'Dema', lastName: 'Testi', birthDate: '1990-05-15' };
const text = (lines = buildTd1(SAMPLE)) => lines.join('\n');
const goodFace = faceOutcome({ similarity: 97 }, 90);
const goodLive = livenessOutcome({ status: 'live', confidence: 98 }, 90);
const full = (o: ReturnType<typeof checkIdBack>) => bindFaceToLiveness({ ...withLiveness(withFace(o, goodFace), goodLive), faceSource: 'liveness' });
const now = new Date('2026-10-02T00:00:00Z');

describe('checkIdBack / decide', () => {
  it('approves only a clean match with auto-approve on', () => {
    const outcome = full(checkIdBack(text(), who, now));
    expect(outcome.issueCodes).toEqual([]);
    expect(decide(outcome, true)).toBe('APPROVED');
    expect(decide(outcome, false)).toBe('NEEDS_REVIEW');
  });

  it('treats an OCR repair as not clean', () => {
    const lines = buildTd1(SAMPLE);
    lines[1] = lines[1].replace('900515', '9O0515');
    const outcome = full(checkIdBack(text(lines), who, now));
    expect(outcome.ocrRepaired).toBe(true);
    expect(decide(outcome, true)).toBe('NEEDS_REVIEW');
  });

  it('never approves without an expected identity', () => {
    expect(decide(full(checkIdBack(text(), {}, now)), true)).toBe('NEEDS_REVIEW');
  });

  it('never approves an empty outcome', () => {
    expect(decide(emptyOutcome('MRZ_NOT_FOUND'), true)).toBe('NEEDS_REVIEW');
  });

  it.each([
    ['below the threshold', faceOutcome({ similarity: 89.9 }, 90), 'FACE_BELOW_THRESHOLD'],
    ['no face found', faceOutcome({ status: 'no_face' }, 90), 'FACE_NOT_DETECTED'],
    ['several faces in the selfie', faceOutcome({ status: 'multiple_faces' }, 90), 'FACE_MULTIPLE_FACES'],
    ['an unusable image', faceOutcome({ status: 'unusable_image' }, 90), 'FACE_IMAGE_UNUSABLE'],
    ['face matching unavailable', null, 'FACE_UNAVAILABLE'],
    ['no face check at all', undefined, undefined],
  ])('never approves with %s', (_n, face, code) => {
    const doc = checkIdBack(text(), who, now);
    const outcome = { ...withLiveness(face === undefined ? doc : withFace(doc, face), goodLive), faceSource: 'liveness' as const };
    if (code) expect(outcome.issueCodes).toContain(code);
    expect(decide(outcome, true)).toBe('NEEDS_REVIEW');
  });

  it('applies the threshold inclusively', () => {
    expect(faceOutcome({ similarity: 90 }, 90).status).toBe('match');
    expect(faceOutcome({ similarity: 90 }, 90.1).status).toBe('below_threshold');
  });

  it('reports missing documents separately from an unavailable provider', () => {
    const doc = checkIdBack(text(), who, now);
    expect(withFace(doc, null, ['SELFIE_MISSING']).issueCodes).toEqual(['SELFIE_MISSING']);
    expect(withFace(doc, null, ['ID_FRONT_MISSING', 'SELFIE_MISSING']).issueCodes).toEqual(['ID_FRONT_MISSING', 'SELFIE_MISSING']);
    expect(withFace(doc, null).issueCodes).toEqual(['FACE_UNAVAILABLE']);
    expect(decide(withFace(doc, null, ['SELFIE_MISSING']), true)).toBe('NEEDS_REVIEW');
  });

  it.each([
    ['not live', livenessOutcome({ status: 'not_live', confidence: 12 }, 90), 'LIVENESS_FAILED'],
    ['incomplete', livenessOutcome({ status: 'incomplete', confidence: null }, 90), 'LIVENESS_INCOMPLETE'],
    ['live but under the tenant minimum', livenessOutcome({ status: 'live', confidence: 89.9 }, 90), 'LIVENESS_FAILED'],
    ['live with no confidence reported', livenessOutcome({ status: 'live', confidence: null }, 90), 'LIVENESS_FAILED'],
    ['provider unavailable', null, 'LIVENESS_UNAVAILABLE'],
  ])('never approves when liveness is %s', (_n, live, code) => {
    const outcome = { ...withLiveness(withFace(checkIdBack(text(), who, now), goodFace), live), faceSource: 'liveness' as const };
    expect(outcome.issueCodes).toEqual([code]);
    expect(decide(outcome, true)).toBe('NEEDS_REVIEW');
  });

  it('never approves when the user did not do a liveness challenge', () => {
    const outcome = { ...withLiveness(withFace(checkIdBack(text(), who, now), goodFace), null, false), faceSource: 'liveness' as const };
    expect(outcome.issueCodes).toEqual(['LIVENESS_NOT_PERFORMED']);
    expect(decide(outcome, true)).toBe('NEEDS_REVIEW');
  });

  it('applies the liveness minimum inclusively', () => {
    expect(livenessOutcome({ status: 'live', confidence: 90 }, 90).status).toBe('live');
  });

  it('never approves a face match made against the uploaded selfie, even with a live verdict', () => {
    const base = { ...withLiveness(withFace(checkIdBack(text(), who, now), goodFace), goodLive), faceSource: 'selfie' as const };
    const bound = bindFaceToLiveness(base);
    expect(bound.issueCodes).toEqual(['FACE_NOT_BOUND_TO_LIVENESS']);
    expect(decide(bound, true)).toBe('NEEDS_REVIEW');
    // Defence in depth: even without the issue code the decision itself refuses
    expect(decide(base, true)).toBe('NEEDS_REVIEW');
  });
});
