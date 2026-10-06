/**
 * Which database the tests use. Never the development database from .env: the e2e tests create,
 * change and delete rows, and a running copy of the service on the same database would pick up
 * the tests' jobs and webhook events (and act on them with its real providers).
 *
 * - TEST_DATABASE_URL if set;
 * - in CI (CI=true), the DATABASE_URL the workflow provides;
 * - otherwise a separate `verify_test` database on the local Postgres from docker-compose.
 */
export const DEFAULT_TEST_DATABASE_URL = 'postgresql://verify:verify@localhost:5434/verify_test';

export function testDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  if (env.TEST_DATABASE_URL) return env.TEST_DATABASE_URL;
  if (env.CI === 'true' && env.DATABASE_URL) return env.DATABASE_URL;
  return DEFAULT_TEST_DATABASE_URL;
}

/** Host, port and database name: enough to tell whether two URLs point at the same database. */
export function sameDatabase(a: string, b: string): boolean {
  const key = (u: string) => {
    try {
      const p = new URL(u);
      return `${p.hostname}:${p.port || '5432'}/${p.pathname.replace(/^\//, '')}`;
    } catch {
      return u;
    }
  };
  return key(a) === key(b);
}
