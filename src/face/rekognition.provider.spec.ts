import { CompareFacesCommand } from '@aws-sdk/client-rekognition';
import { FaceUnavailableError } from './face-provider';
import { RekognitionProvider } from './rekognition.provider';

// The AWS client is replaced by a stub: these tests never reach the network.
const provider = (send: jest.Mock) => new RekognitionProvider({ send } as never);
const img = Buffer.from('x');
const awsError = (name: string, message = '') => Object.assign(new Error(message), { name });

describe('RekognitionProvider', () => {
  it('sends ID as source and selfie as target, with no server-side threshold', async () => {
    const send = jest.fn().mockResolvedValue({ FaceMatches: [{ Similarity: 91.5 }] });
    await expect(provider(send).compare(Buffer.from('id'), Buffer.from('selfie'))).resolves.toEqual({ status: 'compared', similarity: 91.5 });
    const cmd = send.mock.calls[0][0] as CompareFacesCommand;
    expect(cmd.input.SourceImage?.Bytes).toEqual(Buffer.from('id'));
    expect(cmd.input.TargetImage?.Bytes).toEqual(Buffer.from('selfie'));
    expect(cmd.input.SimilarityThreshold).toBe(0);
  });

  it('takes the best of several matches and scores an unmatched face as 0', async () => {
    const best = provider(jest.fn().mockResolvedValue({ FaceMatches: [{ Similarity: 40 }, { Similarity: 88 }] }));
    await expect(best.compare(img, img)).resolves.toEqual({ status: 'compared', similarity: 88 });
    const none = provider(jest.fn().mockResolvedValue({ FaceMatches: [], UnmatchedFaces: [{}] }));
    await expect(none.compare(img, img)).resolves.toEqual({ status: 'compared', similarity: 0 });
  });

  it('reports no face when nothing was found in the target', async () => {
    await expect(provider(jest.fn().mockResolvedValue({})).compare(img, img)).resolves.toEqual({ status: 'no_face' });
  });

  it('maps AWS errors', async () => {
    const run = (e: Error) => provider(jest.fn().mockRejectedValue(e)).compare(img, img);
    await expect(run(awsError('InvalidParameterException', 'There are no faces in the image.'))).resolves.toEqual({ status: 'no_face' });
    await expect(run(awsError('InvalidParameterException', 'other'))).resolves.toEqual({ status: 'unusable_image' });
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
    await expect(provider(send).compare(Buffer.alloc(5 * 1024 * 1024 + 1), img)).resolves.toEqual({ status: 'unusable_image' });
    expect(send).not.toHaveBeenCalled();
  });
});
