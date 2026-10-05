import { ConfigService } from '@nestjs/config';
import { Tenant } from '@prisma/client';
import { SessionsService } from './sessions.service';

function make(ttl: string | undefined) {
  const create = jest.fn(async ({ data }) => ({ id: 's1', status: 'PENDING', expiresAt: data.expiresAt }));
  const tx = { session: { create } };
  const prisma = { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) } as any;
  const usage = { assertWithinCap: async () => ({}), logWarning: () => undefined } as any;
  const config = { get: (k: string) => (k === 'SESSION_TTL_MINUTES' ? ttl : 'http://x') } as unknown as ConfigService;
  return { service: new SessionsService(prisma, config, usage), create };
}

describe('SessionsService TTL', () => {
  it.each([['blank', ''], ['non-numeric', 'abc'], ['zero', '0'], ['negative', '-5'], ['unset', undefined]])(
    'falls back to 60 minutes when the setting is %s',
    async (_label, value) => {
      const { service, create } = make(value);
      const before = Date.now();
      await service.create({ id: 't' } as Tenant, { externalRef: 'u' });
      const ms = create.mock.calls[0][0].data.expiresAt.getTime() - before;
      expect(ms).toBeGreaterThan(59 * 60_000);
      expect(ms).toBeLessThan(61 * 60_000);
    },
  );

  it('honours a valid setting', async () => {
    const { service, create } = make('15');
    const before = Date.now();
    await service.create({ id: 't' } as Tenant, { externalRef: 'u' });
    const ms = create.mock.calls[0][0].data.expiresAt.getTime() - before;
    expect(ms).toBeGreaterThan(14 * 60_000);
    expect(ms).toBeLessThan(16 * 60_000);
  });
});
