/** Compares the portrait on the ID with the selfie. Implementations must not log or keep images. */
export interface FaceProvider {
  readonly name: string;
  compare(idImage: Buffer, selfie: Buffer): Promise<FaceComparison>;
}

export type FaceComparison =
  | { status: 'compared'; /** 0-100, best match between the two faces */ similarity: number }
  | { status: 'no_face' }
  /** The selfie shows more than one face (another person, the ID card, a printed photo). */
  | { status: 'multiple_faces' }
  | { status: 'unusable_image' };

export const FACE_PROVIDER = Symbol('FACE_PROVIDER');

/** Face matching is not configured or credentials are rejected. Retrying will not help. */
export class FaceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FaceUnavailableError';
  }
}
