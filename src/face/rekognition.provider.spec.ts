import { CompareFacesCommand } from '@aws-sdk/client-rekognition';
import { FaceUnavailableError } from './face-provider';
import { RekognitionProvider } from './rekognition.provider';

// The AWS client is replaced by a stub: these tests never reach the network.
const provider = (send: jest.Mock) => new RekognitionProvider({ send } as never);
const jpeg = (tail = 'x') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(tail)]);
const img = jpeg();
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
const awsError = (name: string, message = '') => Object.assign(new Error(message), { name });

describe('RekognitionProvider', () => {
  it('sends ID as source and selfie as target, with no server-side threshold', async () => {
    const send = jest.fn().mockResolvedValue({ FaceMatches: [{ Similarity: 91.5 }] });
    await expect(provider(send).compare(jpeg('id'), jpeg('selfie'))).resolves.toEqual({ status: 'compared', similarity: 91.5 });
    const cmd = send.mock.calls[0][0] as CompareFacesCommand;
    expect(cmd.input.SourceImage?.Bytes).toEqual(jpeg('id'));
    expect(cmd.input.TargetImage?.Bytes).toEqual(jpeg('selfie'));
    expect(cmd.input.SimilarityThreshold).toBe(0);
    expect(cmd.input.QualityFilter).toBe('AUTO');
  });

  it('rejects a selfie with more than one face, matched or not', async () => {
    const two = provider(jest.fn().mockResolvedValue({ FaceMatches: [{ Similarity: 99 }], UnmatchedFaces: [{}] }));
    await expect(two.compare(img, img)).resolves.toEqual({ status: 'multiple_faces' });
    const twoMatches = provider(jest.fn().mockResolvedValue({ FaceMatches: [{ Similarity: 99 }, { Similarity: 97 }] }));
    await expect(twoMatches.compare(img, img)).resolves.toEqual({ status: 'multiple_faces' });
  });

  it('scores a single unmatched face as 0', async () => {
    const none = provider(jest.fn().mockResolvedValue({ FaceMatches: [], UnmatchedFaces: [{}] }));
    await expect(none.compare(img, img)).resolves.toEqual({ status: 'compared', similarity: 0 });
  });

  it('reports no face when nothing was found in the target', async () => {
    await expect(provider(jest.fn().mockResolvedValue({})).compare(img, img)).resolves.toEqual({ status: 'no_face' });
  });

  it('maps AWS errors', async () => {
    const run = (e: Error) => provider(jest.fn().mockRejectedValue(e)).compare(img, img);
    // The message text is not relied on: any wording means no usable face
    await expect(run(awsError('InvalidParameterException', 'There are no faces in the image.'))).resolves.toEqual({ status: 'no_face' });
    await expect(run(awsError('InvalidParameterException', 'Request has invalid parameters'))).resolves.toEqual({ status: 'no_face' });
    await expect(run(awsError('InvalidImageFormatException'))).resolves.toEqual({ status: 'unusable_image' });
    await expect(run(awsError('UnrecognizedClientException'))).rejects.toBeInstanceOf(FaceUnavailableError);
    await expect(run(awsError('CredentialsProviderError'))).rejects.toBeInstanceOf(FaceUnavailableError);
    // Throttling and network errors must stay retryable
    const throttled = await run(awsError('ProvisionedThroughputExceededException')).catch((e) => e);
    expect(throttled).not.toBeInstanceOf(FaceUnavailableError);
    expect(throttled.name).toBe('ProvisionedThroughputExceededException');
  });

  it('does not call AWS for images over 5 MB', async () => {
    const send = jest.fn();
    await expect(provider(send).compare(jpeg('x'.repeat(5 * 1024 * 1024)), img)).resolves.toEqual({ status: 'unusable_image' });
    expect(send).not.toHaveBeenCalled();
  });

  it('never sends WebP or other unsupported formats to AWS', async () => {
    const send = jest.fn();
    await expect(provider(send).compare(webp, img)).resolves.toEqual({ status: 'unusable_image' });
    await expect(provider(send).compare(img, webp)).resolves.toEqual({ status: 'unusable_image' });
    await expect(provider(send).compare(Buffer.from('not an image'), img)).resolves.toEqual({ status: 'unusable_image' });
    expect(send).not.toHaveBeenCalled();
  });
});
