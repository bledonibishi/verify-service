module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/hermetic-env.ts'],
  globalSetup: '<rootDir>/test/global-setup.ts',
  rootDir: '.',
  // The default 5 s is too tight for pipeline tests when the whole suite runs in parallel on a busy machine
  testTimeout: 30_000,
  testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/**/*.spec.ts', '<rootDir>/sdk/test/**/*.spec.ts'],
};
