describe('test environment', () => {
  it('cannot reach real services even if .env configures them', () => {
    expect(process.env.STORAGE_DRIVER).toBe('local');
    expect(process.env.STORAGE_KEY_PROVIDER).toBe('env');
    expect(process.env.KMS_KEY_ID).toBe('');
    expect(process.env.FACE_PROVIDER).toBe('none');
    expect(process.env.LIVENESS_PROVIDER).toBe('none');
    for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_ENDPOINT']) {
      expect(process.env[name]).toBe('');
    }
  });

  it('the app ignores .env files when running under jest', () => {
    expect(process.env.NODE_ENV).toBe('test');
  });
});
