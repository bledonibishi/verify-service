import { assertLocalEndpoint } from './local-endpoint';

describe('assertLocalEndpoint', () => {
  it.each(['http://localhost:9100', 'http://127.0.0.1:9100', 'http://[::1]:9100'])('accepts %s', (url) => {
    expect(() => assertLocalEndpoint(url)).not.toThrow();
  });

  it.each([
    'https://s3.eu-central-1.amazonaws.com',
    'https://bucket.s3.amazonaws.com',
    'http://localhost.evil.example',
    'http://127.0.0.1.evil.example',
    'http://169.254.169.254',
    'http://10.0.0.5:9000',
    'not a url',
  ])('rejects %s', (url) => {
    expect(() => assertLocalEndpoint(url)).toThrow();
  });
});
