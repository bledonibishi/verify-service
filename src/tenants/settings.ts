/** Per-tenant settings that can be set from the command line (tenant:create / tenant:update). */
export interface TenantSettings {
  autoApprove: boolean;
  faceMatchThreshold: number;
  livenessMinConfidence: number;
  documentRetentionDays: number;
  recordRetentionDays: number;
  evidenceExport: boolean;
}

export const SETTINGS_USAGE =
  '[--auto-approve|--no-auto-approve] [--face-threshold=90] [--liveness-threshold=90] ' +
  '[--doc-retention-days=30] [--record-retention-days=1825] [--evidence-export|--no-evidence-export]';

const MAX_DAYS = 36_500;

function percent(flag: string, raw: string): number {
  const n = raw.trim() === '' ? NaN : Number(raw);
  if (!(n > 0 && n <= 100)) throw new Error(`--${flag} must be a number above 0 and up to 100`);
  return n;
}

function days(flag: string, raw: string): number {
  // Number('') is 0, which would mean "delete immediately": a blank value must never parse
  const n = /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > MAX_DAYS) throw new Error(`--${flag} must be a whole number of days from 0 to ${MAX_DAYS}`);
  return n;
}

/** Splits arguments into setting overrides and positional values. Throws a readable Error on bad input. */
export function parseTenantFlags(args: string[]): { settings: Partial<TenantSettings>; positional: string[] } {
  const settings: Partial<TenantSettings> = {};
  const positional: string[] = [];
  for (const arg of args) {
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [flag, value] = [arg.slice(2).split('=')[0], arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined];
    switch (flag) {
      case 'auto-approve': settings.autoApprove = true; break;
      case 'no-auto-approve': settings.autoApprove = false; break;
      case 'evidence-export': settings.evidenceExport = true; break;
      case 'no-evidence-export': settings.evidenceExport = false; break;
      case 'face-threshold': settings.faceMatchThreshold = percent(flag, value ?? ''); break;
      case 'liveness-threshold': settings.livenessMinConfidence = percent(flag, value ?? ''); break;
      case 'doc-retention-days': settings.documentRetentionDays = days(flag, value ?? ''); break;
      case 'record-retention-days': settings.recordRetentionDays = days(flag, value ?? ''); break;
      default: throw new Error(`Unknown option --${flag}`);
    }
  }
  return { settings, positional };
}

/** Documents must not outlive the record that describes them. */
export function checkRetention(s: Pick<TenantSettings, 'documentRetentionDays' | 'recordRetentionDays'>) {
  if (s.documentRetentionDays > s.recordRetentionDays) {
    throw new Error('Document retention cannot be longer than record retention');
  }
}

export const DEFAULT_SETTINGS: TenantSettings = {
  autoApprove: false,
  faceMatchThreshold: 90,
  livenessMinConfidence: 90,
  documentRetentionDays: 30,
  recordRetentionDays: 1825,
  evidenceExport: false,
};
