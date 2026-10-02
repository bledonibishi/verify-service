/** Tests that write to object storage may only talk to a server on this machine, never a cloud account. */
export function assertLocalEndpoint(endpoint: string): void {
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    throw new Error('S3_TEST_ENDPOINT is not a valid URL');
  }
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) {
    throw new Error(`S3_TEST_ENDPOINT must be a local server (localhost or 127.0.0.1), not ${host}`);
  }
}
