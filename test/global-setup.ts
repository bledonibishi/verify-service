import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { sameDatabase, testDatabaseUrl } from './test-database';

/**
 * Runs once before the test files: prepares the test database (creates it if needed and applies
 * the migrations) and refuses to go on if it is the development database from .env.
 */
export default function globalSetup() {
  const url = testDatabaseUrl();
  if (existsSync('.env')) {
    const line = readFileSync('.env', 'utf8').split(/\r?\n/).find((l) => /^\s*DATABASE_URL\s*=/.test(l));
    const devUrl = line?.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
    if (devUrl && sameDatabase(url, devUrl)) {
      throw new Error('The tests would use the development database from .env. Set TEST_DATABASE_URL to a separate database (the default is verify_test).');
    }
  }
  const res = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    // Prisma's output names the database and the failing step, never data
    throw new Error(`Could not prepare the test database:\n${res.stdout}\n${res.stderr}`);
  }
}
