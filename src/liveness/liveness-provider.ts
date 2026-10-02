/**
 * Liveness proves the selfie is a live person in front of the camera, not a photo, screen or
 * mask. Providers run a challenge in the user's browser or app, so the flow has two halves:
 * `createSession` when the user starts, `getResult` when the pipeline checks the outcome.
 * Implementations must not log or keep images.
 */
export interface LivenessProvider {
  readonly name: string;
  createSession(): Promise<LivenessSession>;
  getResult(providerSessionId: string): Promise<LivenessResult>;
}

export interface LivenessSession {
  providerSessionId: string;
  /** Anything the client widget needs besides the id. Must hold no secrets beyond the session. */
  clientConfig?: Record<string, unknown>;
}

export interface LivenessResult {
  /** `incomplete`: the user never finished the challenge or the session expired. */
  status: 'live' | 'not_live' | 'incomplete';
  /** 0-100 */
  confidence: number | null;
  /**
   * The face image captured during the challenge. When present it is used for the face match
   * instead of the uploaded selfie, which binds the match to the live person. Never stored.
   */
  referenceImage?: Buffer;
}

export const LIVENESS_PROVIDER = Symbol('LIVENESS_PROVIDER');

/** Liveness is not configured or credentials are rejected. Retrying will not help. */
export class LivenessUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LivenessUnavailableError';
  }
}
