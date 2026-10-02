import { DUMMY_HASH, hashPassword, verifyPassword } from './password';

describe('password hashing', () => {
  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('scrypt$')).toBe(true);
    await expect(verifyPassword('correct horse battery', hash)).resolves.toBe(true);
    await expect(verifyPassword('correct horse batterz', hash)).resolves.toBe(false);
    await expect(verifyPassword('', hash)).resolves.toBe(false);
  });

  it('salts each hash', async () => {
    expect(await hashPassword('same password here')).not.toBe(await hashPassword('same password here'));
  });

  it('rejects malformed stored values instead of throwing', async () => {
    await expect(verifyPassword('x', 'plain')).resolves.toBe(false);
    await expect(verifyPassword('x', 'bcrypt$1$2$3$a$b')).resolves.toBe(false);
  });

  it('can verify against the dummy hash without matching', async () => {
    await expect(verifyPassword('anything', DUMMY_HASH)).resolves.toBe(false);
  });
});
