import { PrismaClient } from '@prisma/client';
import { randomToken, sha256 } from '../common/crypto';

/** A replaced key may keep working for at most a week, so "rotate" cannot quietly become "add a second key". */
export const MAX_GRACE_HOURS = 168;

export interface RotationResult {
  apiKey: string;
  webhookSecret?: string;
  /** When the replaced key stops working; null if it stopped at once. */
  oldKeyValidUntil: Date | null;
}

export class RotationError extends Error {}

/**
 * Replaces a tenant's API key (and optionally its webhook secret). With no grace period the old key
 * stops working at once, which is what to do after a leak. With a grace period it keeps working
 * until then, so the tenant can deploy the new key without downtime. Rotating again during a grace
 * period ends the earlier key at once: at most one old key is ever valid.
 *
 * Overlapping rotations never both succeed. The update only applies if the key it replaces is still
 * the current one (two calls that read the same key: one wins), and a call that started before
 * another rotation was committed is refused even if it only read afterwards, so no command ever
 * prints a key that a rotation running at the same time has already replaced. A rotation that
 * starts after the previous one finished is a new rotation and replaces its key, as rotating does.
 */
export async function rotateTenantKey(
  prisma: Pick<PrismaClient, 'tenant'>,
  tenantId: string,
  opts: { graceHours?: number; rotateWebhookSecret?: boolean; now?: Date } = {},
): Promise<RotationResult> {
  const grace = opts.graceHours ?? 0;
  if (!Number.isFinite(grace) || grace < 0 || grace > MAX_GRACE_HOURS) {
    throw new RotationError(`Grace period must be between 0 and ${MAX_GRACE_HOURS} hours`);
  }
  const now = opts.now ?? new Date();
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { apiKeyHash: true, apiKeyRotatedAt: true } });
  if (!tenant) throw new RotationError('No such tenant');
  if (tenant.apiKeyRotatedAt && tenant.apiKeyRotatedAt > now) {
    throw new RotationError('The key was rotated by someone else while this command was starting; run it again');
  }

  const apiKey = `vk_${randomToken()}`;
  const webhookSecret = opts.rotateWebhookSecret ? `whsec_${randomToken()}` : undefined;
  const until = grace > 0 ? new Date(now.getTime() + grace * 3_600_000) : null;
  const changed = await prisma.tenant.updateMany({
    where: { id: tenantId, apiKeyHash: tenant.apiKeyHash },
    data: {
      apiKeyHash: sha256(apiKey),
      previousApiKeyHash: until ? tenant.apiKeyHash : null,
      previousApiKeyExpiresAt: until,
      apiKeyRotatedAt: now,
      ...(webhookSecret ? { webhookSecret } : {}),
    },
  });
  if (changed.count === 0) throw new RotationError('The key was changed by someone else at the same time; run the command again');
  return { apiKey, webhookSecret, oldKeyValidUntil: until };
}
