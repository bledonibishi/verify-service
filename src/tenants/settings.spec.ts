import { checkRetention, parseTenantFlags } from './settings';

describe('parseTenantFlags', () => {
  it('splits flags from positional arguments', () => {
    const r = parseTenantFlags(['Acme', 'https://x.test/hook', '--auto-approve', '--face-threshold=95', '--doc-retention-days=0']);
    expect(r.positional).toEqual(['Acme', 'https://x.test/hook']);
    expect(r.settings).toEqual({ autoApprove: true, faceMatchThreshold: 95, documentRetentionDays: 0 });
  });

  it('parses the monthly cap, including turning it off', () => {
    expect(parseTenantFlags(['--monthly-cap=500', '--soft-limit=90']).settings).toEqual({ monthlyVerificationCap: 500, softLimitPercent: 90 });
    expect(parseTenantFlags(['--monthly-cap=none']).settings).toEqual({ monthlyVerificationCap: null });
  });

  it('supports turning things off', () => {
    expect(parseTenantFlags(['--no-auto-approve', '--no-evidence-export']).settings).toEqual({ autoApprove: false, evidenceExport: false });
  });

  it.each([
    ['--face-threshold=0'],
    ['--face-threshold=101'],
    ['--face-threshold='],
    ['--liveness-threshold=abc'],
    ['--doc-retention-days=-1'],
    ['--doc-retention-days=1.5'],
    ['--record-retention-days=36501'],
    ['--record-retention-days='],
    ['--doc-retention-days= '],
    ['--doc-retention-days=1e2'],
    ['--record-retention-days'],
    ['--monthly-cap=0'],
    ['--monthly-cap='],
    ['--monthly-cap=-5'],
    ['--monthly-cap=1.5'],
    ['--monthly-cap=NONE'],
    ['--soft-limit=0'],
    ['--soft-limit=101'],
    ['--soft-limit='],
    ['--nope'],
  ])('rejects %s', (arg) => {
    expect(() => parseTenantFlags([arg])).toThrow();
  });

  it('refuses documents that would outlive the record', () => {
    expect(() => checkRetention({ documentRetentionDays: 400, recordRetentionDays: 30 })).toThrow();
    expect(() => checkRetention({ documentRetentionDays: 30, recordRetentionDays: 30 })).not.toThrow();
  });
});
