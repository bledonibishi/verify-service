import { CompareFacesCommand, RekognitionClient } from '@aws-sdk/client-rekognition';
import { FaceComparison, FaceProvider, FaceUnavailableError } from './face-provider';

/** Rekognition accepts at most 5 MB of image bytes per call. */
const MAX_BYTES = 5 * 1024 * 1024;

const UNAVAILABLE = new Set([
  'CredentialsProviderError',
  'UnrecognizedClientException',
  'InvalidSignatureException',
  'AccessDeniedException',
  'ExpiredTokenException',
  'AccessDenied',
]);
const UNUSABLE = new Set(['InvalidImageFormatException', 'ImageTooLargeException']);

/**
 * AWS Rekognition CompareFaces. The ID portrait is the source and the selfie the target. Images
 * are sent as bytes and Rekognition does not store them. Credentials come from the SDK's default
 * chain (env vars locally, an IAM role in production).
 */
export class RekognitionProvider implements FaceProvider {
  readonly name = 'rekognition';

  constructor(private readonly client: Pick<RekognitionClient, 'send'>) {}

  static forRegion(region: string): RekognitionProvider {
    return new RekognitionProvider(new RekognitionClient({ region }));
  }

  async compare(idImage: Buffer, selfie: Buffer): Promise<FaceComparison> {
    if (idImage.length > MAX_BYTES || selfie.length > MAX_BYTES) return { status: 'unusable_image' };
    try {
      const res = await this.client.send(
        new CompareFacesCommand({
          SourceImage: { Bytes: idImage },
          TargetImage: { Bytes: selfie },
          // Return every comparison; the tenant's threshold is applied by the decision logic.
          SimilarityThreshold: 0,
          QualityFilter: 'NONE',
        }),
      );
      const scores = [...(res.FaceMatches ?? []).map((m) => m.Similarity), ...(res.UnmatchedFaces ?? []).map(() => 0)];
      const best = Math.max(-1, ...scores.filter((s): s is number => typeof s === 'number'));
      return best < 0 ? { status: 'no_face' } : { status: 'compared', similarity: best };
    } catch (err) {
      const name = (err as Error).name;
      if (UNAVAILABLE.has(name)) throw new FaceUnavailableError('face provider rejected credentials');
      if (UNUSABLE.has(name)) return { status: 'unusable_image' };
      // "There are no faces in the image" arrives as InvalidParameterException.
      if (name === 'InvalidParameterException') {
        return /no faces/i.test((err as Error).message) ? { status: 'no_face' } : { status: 'unusable_image' };
      }
      throw err; // throttling, network, 5xx: let the job retry
    }
  }
}
