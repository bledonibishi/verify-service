import { DEFAULT_TEST_DATABASE_URL, sameDatabase, testDatabaseUrl } from './test-database';

describe('test database', () => {
  const DEV = 'postgresql://verify:verify@localhost:5434/verify';

  it('never falls back to the developer database', () => {
    expect(testDatabaseUrl({})).toBe(DEFAULT_TEST_DATABASE_URL);
    expect(testDatabaseUrl({ DATABASE_URL: DEV })).toBe(DEFAULT_TEST_DATABASE_URL); // an exported dev URL is ignored locally
  });

  it('uses TEST_DATABASE_URL, or the CI database', () => {
    expect(testDatabaseUrl({ TEST_DATABASE_URL: 'postgresql://x@db:5432/t', DATABASE_URL: DEV })).toBe('postgresql://x@db:5432/t');
    expect(testDatabaseUrl({ CI: 'true', DATABASE_URL: 'postgresql://ci@localhost:5432/verify' })).toBe('postgresql://ci@localhost:5432/verify');
  });

  it('tells databases apart by host, port and name, not by credentials', () => {
    expect(sameDatabase(DEV, 'postgresql://other:pw@localhost:5434/verify')).toBe(true);
    expect(sameDatabase(DEV, DEFAULT_TEST_DATABASE_URL)).toBe(false);
    expect(sameDatabase(DEV, 'postgresql://verify:verify@localhost:5433/verify')).toBe(false);
    expect(sameDatabase('postgresql://a@h/db', 'postgresql://a@h:5432/db')).toBe(true);
  });

  it('is what the tests run against', () => {
    expect(sameDatabase(process.env.DATABASE_URL!, testDatabaseUrl())).toBe(true);
    expect(process.env.DATABASE_URL).not.toBe(DEV);
  });
});
