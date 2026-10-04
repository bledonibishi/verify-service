import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Reviewer } from '@prisma/client';
import { sha256 } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { KeyUnavailableError, StorageService } from '../storage/storage.service';
import { MAX_FAILURES, ReviewAuthService } from './auth.service';
import { base32Encode, generateRecoveryCode, generateSecret, normalizeRecoveryCode, otpauthUri, verifyCode } from './totp';

const RECOVERY_CODES = 10;
const BAD_CODE = 'Invalid or expired code';

/** Second-factor sign-in for reviewers: authenticator-app codes, single-use recovery codes, enrolment. */
@Injectable()
export class TwoFactorService {
  private readonly logger = new Logger(TwoFactorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: ReviewAuthService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}

  private issuer(): string {
    return this.config.get<string>('REVIEW_TOTP_ISSUER') || 'verify-service';
  }

  async status(reviewer: Reviewer, tenantRequires: boolean) {
    const left = reviewer.totpEnabledAt ? await this.prisma.recoveryCode.count({ where: { reviewerId: reviewer.id, usedAt: null } }) : 0;
    return { enabled: !!reviewer.totpEnabledAt, recoveryCodesLeft: left, required: tenantRequires };
  }

  /** Starts enrolment: a new secret, shown once, not active until a code made from it is confirmed. Needs the password again. */
  async setup(reviewer: Reviewer, password: string) {
    await this.auth.assertNotLocked(reviewer.id);
    await this.auth.confirmPassword(reviewer, password);
    if (reviewer.totpEnabledAt) throw new ConflictException('Two-factor sign-in is already on');
    const secret = generateSecret();
    const sealed = await this.storage.sealSecret(secret, reviewer.id);
    // Only while still not enabled, so a concurrent enable cannot be overwritten with a new secret
    const updated = await this.prisma.reviewer.updateMany({
      where: { id: reviewer.id, totpEnabledAt: null },
      data: { totpSecretSealed: sealed, totpLastStep: null },
    });
    if (updated.count === 0) throw new ConflictException('Two-factor sign-in is already on');
    return { secret: base32Encode(secret), otpauthUri: otpauthUri(this.issuer(), reviewer.email, secret) };
  }

  /** Confirms enrolment with a code from the app, turns it on and returns the recovery codes (shown once). */
  async enable(reviewer: Reviewer, sessionId: string, code: string) {
    if (!reviewer.totpSecretSealed || reviewer.totpEnabledAt) throw new BadRequestException('Start two-factor setup first');
    await this.auth.assertNotLocked(reviewer.id);
    const secret = await this.openSecretOf(reviewer);
    if (!secret) throw new BadRequestException('Start two-factor setup again');
    const v = verifyCode(secret, code, Date.now(), null);
    if (!v.ok) {
      await this.auth.recordFailure(reviewer.id);
      throw new UnauthorizedException(BAD_CODE);
    }
    const codes = Array.from({ length: RECOVERY_CODES }, generateRecoveryCode);
    const enabled = await this.prisma.$transaction(async (tx) => {
      // Single winner: only the call that finds it still pending turns it on
      const r = await tx.reviewer.updateMany({
        where: { id: reviewer.id, totpEnabledAt: null, totpSecretSealed: reviewer.totpSecretSealed },
        data: { totpEnabledAt: new Date(), totpLastStep: v.step },
      });
      if (r.count === 0) return false;
      await tx.recoveryCode.deleteMany({ where: { reviewerId: reviewer.id } });
      await tx.recoveryCode.createMany({ data: codes.map((c) => ({ reviewerId: reviewer.id, codeHash: sha256(c) })) });
      return true;
    });
    if (!enabled) throw new ConflictException('Two-factor sign-in is already on');
    // Anyone else signed in as this reviewer (a stolen session) is signed out; this browser stays
    await this.auth.endOtherSessions(reviewer.id, sessionId);
    return { recoveryCodes: codes };
  }

  /** Turns it off. Needs the password and a current code; refused where the tenant requires it. */
  async disable(reviewer: Reviewer, sessionId: string, tenantRequires: boolean, password: string, code: string) {
    if (tenantRequires) throw new ForbiddenException('Your organisation requires two-factor sign-in');
    if (!reviewer.totpEnabledAt) throw new BadRequestException('Two-factor sign-in is not on');
    await this.auth.assertNotLocked(reviewer.id);
    await this.auth.confirmPassword(reviewer, password);
    await this.requireSecondFactor(reviewer, code);
    await this.prisma.$transaction([
      this.prisma.reviewer.update({ where: { id: reviewer.id }, data: { totpSecretSealed: null, totpEnabledAt: null, totpLastStep: null } }),
      this.prisma.recoveryCode.deleteMany({ where: { reviewerId: reviewer.id } }),
    ]);
    await this.auth.endOtherSessions(reviewer.id, sessionId);
  }

  /** Replaces all recovery codes with new ones. Needs the password and a current code. */
  async regenerateRecoveryCodes(reviewer: Reviewer, password: string, code: string) {
    if (!reviewer.totpEnabledAt) throw new BadRequestException('Two-factor sign-in is not on');
    await this.auth.assertNotLocked(reviewer.id);
    await this.auth.confirmPassword(reviewer, password);
    await this.requireSecondFactor(reviewer, code);
    const codes = Array.from({ length: RECOVERY_CODES }, generateRecoveryCode);
    await this.prisma.$transaction([
      this.prisma.recoveryCode.deleteMany({ where: { reviewerId: reviewer.id } }),
      this.prisma.recoveryCode.createMany({ data: codes.map((c) => ({ reviewerId: reviewer.id, codeHash: sha256(c) })) }),
    ]);
    return { recoveryCodes: codes };
  }

  /** Second step of signing in: the challenge from the password step, plus a code or a recovery code. */
  async completeLogin(challenge: string, code: string) {
    const tokenHash = sha256(challenge);
    // A challenge allows a handful of guesses. They are counted in one statement that also checks the
    // challenge still exists and has not expired, so parallel tries cannot exceed the limit and a
    // challenge deleted by another request is a refusal, not a database error.
    const counted = await this.prisma.$queryRaw<{ id: string; reviewer_id: string; attempts: number }[]>(Prisma.sql`
      UPDATE login_challenges SET attempts = attempts + 1
      WHERE token_hash = ${tokenHash} AND expires_at > now()
      RETURNING id, reviewer_id, attempts`);
    if (counted.length === 0) throw new UnauthorizedException(BAD_CODE);
    const { id: challengeId, reviewer_id: reviewerId, attempts } = counted[0];

    const reviewer = await this.prisma.reviewer.findUnique({ where: { id: reviewerId } });
    const locked = !!reviewer?.lockedUntil && reviewer.lockedUntil.getTime() > Date.now();
    if (!reviewer || attempts > MAX_FAILURES || reviewer.disabled || locked || !reviewer.totpEnabledAt) {
      await this.prisma.loginChallenge.deleteMany({ where: { id: challengeId } });
      throw new UnauthorizedException(BAD_CODE);
    }
    if (!(await this.checkSecondFactor(reviewer, code))) {
      await this.auth.recordFailure(reviewer.id);
      throw new UnauthorizedException(BAD_CODE);
    }
    // The challenge is spent exactly once, and only while it is still valid: verification can take
    // time (a slow key service), and a challenge that expired meanwhile must not open a session
    const spent = await this.prisma.loginChallenge.deleteMany({ where: { id: challengeId, expiresAt: { gt: new Date() } } });
    if (spent.count === 0) throw new UnauthorizedException(BAD_CODE);
    await this.prisma.reviewer.update({ where: { id: reviewer.id }, data: { failedLogins: 0, lockedUntil: null } });
    return { ...(await this.auth.startSession(reviewer.id)), reviewer };
  }

  /**
   * The reviewer's authenticator secret, or null if it cannot be read (damaged, or sealed for someone
   * else): that is a failed sign-in, never a server error. A key service that is down is different:
   * say so, so the person tries again instead of thinking their code was wrong.
   */
  private async openSecretOf(reviewer: Reviewer): Promise<Buffer | null> {
    try {
      return await this.storage.openSecret(reviewer.totpSecretSealed as string, reviewer.id);
    } catch (err) {
      if (err instanceof KeyUnavailableError) throw new ServiceUnavailableException('Sign-in is temporarily unavailable');
      this.logger.error(`Could not read the two-factor secret of reviewer ${reviewer.id}: ${(err as Error).name}`);
      return null;
    }
  }

  private async requireSecondFactor(reviewer: Reviewer, code: string) {
    if (!(await this.checkSecondFactor(reviewer, code))) {
      await this.auth.recordFailure(reviewer.id);
      throw new UnauthorizedException(BAD_CODE);
    }
  }

  /** A six-digit code from the app, or a recovery code. Each is accepted once. */
  private async checkSecondFactor(reviewer: Reviewer, input: string): Promise<boolean> {
    if (!reviewer.totpSecretSealed) return false;
    const recovery = normalizeRecoveryCode(input);
    if (recovery) {
      // Single use, decided by the database: two parallel attempts with the same code cannot both succeed
      const r = await this.prisma.recoveryCode.updateMany({ where: { reviewerId: reviewer.id, codeHash: sha256(recovery), usedAt: null }, data: { usedAt: new Date() } });
      return r.count === 1;
    }
    const secret = await this.openSecretOf(reviewer);
    if (!secret) return false;
    const v = verifyCode(secret, input, Date.now(), reviewer.totpLastStep);
    if (!v.ok) return false;
    // The step is claimed atomically: a second request with the same code finds it already used
    const claimed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE reviewers SET totp_last_step = ${v.step}
      WHERE id = ${reviewer.id} AND (totp_last_step IS NULL OR totp_last_step < ${v.step})`);
    return claimed === 1;
  }
}
