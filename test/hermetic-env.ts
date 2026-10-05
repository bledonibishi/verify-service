// Loaded before every test file (see jest.config.js). Tests must never reach real services, whatever
// a developer has in their own .env: that file is full of real AWS settings and keys.
//
// Variables are set to '' rather than deleted on purpose: Prisma loads .env on start-up and fills in
// anything that is *undefined*, which would bring the real values back.
for (const name of [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_ENDPOINT',
  'S3_KMS_KEY_ID',
  'S3_KEY_PREFIX',
  'TESSERACT_BIN',
  'KMS_KEY_ID',
  'KMS_ACCESS_KEY_ID',
  'KMS_SECRET_ACCESS_KEY',
  'KMS_REGION',
]) {
  process.env[name] = '';
}
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_KEY_PROVIDER = 'env';
process.env.FACE_PROVIDER = 'none';
process.env.LIVENESS_PROVIDER = 'none';
process.env.OCR_PROVIDER = 'tesseract';
process.env.S3_REGION = 'eu-central-1';
