import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookDispatcher } from './dispatcher';
import { WebhooksService } from './webhooks.service';

const make = (env: Record<string, string>, prisma: object) =>
  new WebhookDispatcher(prisma as never, new WebhooksService(), { get: (k: string) => env[k] } as unknown as ConfigService);

describe('WebhookDispatcher', () => {
  it('keeps a request shorter than its lease, however long the configured timeout', () => {
    const d = make({ WEBHOOK_TIMEOUT_MS: '600000' }, {});
    expect((d as unknown as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(45_000);
    expect((make({}, {}) as unknown as { timeoutMs: number }).timeoutMs).toBe(10_000);
  });

  it('logs the cause when bookkeeping fails, not just the error class', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'evt-1', attempts: 1, claims: 1 }]),
      webhookEvent: { findUnique: jest.fn().mockRejectedValue(Object.assign(new Error('Invalid `x` invocation\nrelation "webhook_events" does not exist'), { name: 'PrismaClientKnownRequestError' })) },
    };
    const err = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    await make({}, prisma).tick();
    const line = String(err.mock.calls[0][0]);
    expect(line).toContain('evt-1');
    expect(line).toContain('PrismaClientKnownRequestError');
    expect(line).toContain('does not exist');
    err.mockRestore();
  });
});
