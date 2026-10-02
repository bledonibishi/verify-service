/** Reads text from an image. Implementations must not log or persist the image or its text. */
export interface OcrProvider {
  readonly name: string;
  readText(image: Buffer): Promise<OcrResult>;
}

export interface OcrResult {
  text: string;
}

export const OCR_PROVIDER = Symbol('OCR_PROVIDER');

/** The OCR engine is not installed or not reachable. Retrying will not help. */
export class OcrUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrUnavailableError';
  }
}

/** Transient OCR failure. `reason` is a fixed code, safe to log (the engine's own output is not). */
export class OcrError extends Error {
  constructor(readonly reason: 'timeout' | 'output_too_large' | 'exit' | 'spawn') {
    super(`OCR failed: ${reason}`);
    this.name = 'OcrError';
  }
}
