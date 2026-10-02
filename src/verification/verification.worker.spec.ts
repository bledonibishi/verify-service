import { ConfigService } from '@nestjs/config';
import { VerificationWorker } from './verification.worker';

const make = (env: Record<string, string>) => {
  const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
  const config = { get: (k: string) => env[k] } as unknown as ConfigService;
  const worker = new VerificationWorker(prisma as never, {} as never, {} as never, config, { name: 'x', readText: jest.fn() }, { name: 'y', compare: jest.fn() });
  return { worker, prisma };
};

describe('VerificationWorker enablement', () => {
  it('never claims jobs when disabled, even if woken by a submit', async () => {
    const { worker, prisma } = make({ VERIFICATION_WORKER_ENABLED: 'false' });
    worker.onApplicationBootstrap();
    await worker.wake();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    await worker.onModuleDestroy();
  });

  it('claims jobs when enabled', async () => {
    const { worker, prisma } = make({ VERIFICATION_POLL_MS: '100000' });
    await worker.wake();
    expect(prisma.$queryRaw).toHaveBeenCalled();
    await worker.onModuleDestroy();
  });
});
