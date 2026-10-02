import { CompareFacesCommand, RekognitionClient } from '@aws-sdk/client-rekognition';
import { detectImageType } from '../uploads/image-type';
import { FaceComparison, FaceProvider, FaceUnavailableError } from './face-provider';

/** Rekognition accepts at most 5 MB of image bytes per call, and only JPEG and PNG. */
const MAX_BYTES = 5 * 1024 * 1024;
const SUPPORTED = new Set(['image/jpeg', 'image/png']);
const supported = (img: Buffer) => img.length <= MAX_BYTES && SUPPORTED.has(detectImageType(img) ?? '');

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
    // Checked here so unsupported images are never sent to a third party.
    if (!supported(idImage) || !supported(selfie)) return { status: 'unusable_image' };
    try {
      const res = await this.client.send(
        new CompareFacesCommand({
          SourceImage: { Bytes: idImage },
          TargetImage: { Bytes: selfie },
          // Return every comparison; the tenant's threshold is applied by the decision logic.
          SimilarityThreshold: 0,
          // Drops tiny or blurry faces so they can't be the one that matches.
          QualityFilter: 'AUTO',
        }),
      );
      // The selfie must hold exactly one face: otherwise a second person, the ID card itself or
      // a printed photo could supply the matching face.
      const targets = [...(res.FaceMatches ?? []).map((m) => m.Similarity ?? 0), ...(res.UnmatchedFaces ?? []).map(() => 0)];
      if (targets.length === 0) return { status: 'no_face' };
      if (targets.length > 1) return { status: 'multiple_faces' };
      return { status: 'compared', similarity: targets[0] };
    } catch (err) {
      const name = (err as Error).name;
      if (UNAVAILABLE.has(name)) throw new FaceUnavailableError('face provider rejected credentials');
      if (UNUSABLE.has(name)) return { status: 'unusable_image' };
      // Format and size were validated above, so this is what Rekognition reports when it finds
      // no usable face in the ID portrait (its message text is not stable enough to match on).
      if (name === 'InvalidParameterException') return { status: 'no_face' };
      throw err; // throttling, network, 5xx: let the job retry
    }
  }
}
