import { HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Prisma, Reviewer } from '@prisma/client';
import { randomUUID } from 'crypto';
import { randomToken, sha256 } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { DUMMY_HASH, verifyPassword } from './password';

export const COOKIE_NAME = 'vr_session';
export const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const ABSOLUTE_MS = 8 * 3600_000;
const IDLE_MS = 60 * 60_000;
const CHALLENGE_MS = 5 * 60_000;

export type LoginResult =
  | { kind: 'session'; token: string; expiresAt: Date; reviewer: Reviewer; setupRequired: boolean }
  | { kind: 'challenge'; challenge: string };

export interface Authenticated {
  reviewer: Reviewer;
  sessionId: string;
  /** The tenant makes two-factor sign-in mandatory. */
  tenantRequires: boolean;
  /** Required, and this reviewer has not set it up yet: only the setup screens are open to them. */
  limited: boolean;
}

@Injectable()
export class ReviewAuthService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Checks the password. Every failure (unknown email, wrong password, disabled or locked account)
   * gives the same error, and a password check always runs, so neither the message nor the timing
   * says which accounts exist. With two-factor sign-in on, the answer is a short-lived challenge
   * that grants nothing by itself; otherwise it is a browser session.
   */
  async login(email: string, password: string): Promise<LoginResult> {
    const reviewer = await this.prisma.reviewer.findUnique({ where: { email: email.trim().toLowerCase() }, include: { tenant: true } });
    const ok = await verifyPassword(password, reviewer?.passwordHash ?? DUMMY_HASH);
    const locked = !!reviewer?.lockedUntil && reviewer.lockedUntil.getTime() > Date.now();

    if (!reviewer || reviewer.disabled || locked || !ok) {
      // Every failure path runs the same single statement before answering, against a random id
      // when there is nothing to count, so response time does not reveal which emails exist.
      const counts = !!reviewer && !reviewer.disabled && !locked && !ok;
      await this.recordFailure(counts ? reviewer.id : randomUUID());
      throw new UnauthorizedException('Invalid email or password');
    }

    if (reviewer.totpEnabledAt) {
      // The password alone is not enough. Do not reset the failure counter yet: it counts until the whole sign-in succeeds.
      const challenge = randomToken();
      await this.prisma.loginChallenge.create({
        data: { reviewerId: reviewer.id, tokenHash: sha256(challenge), expiresAt: new Date(Date.now() + CHALLENGE_MS) },
      });
      await this.prisma.loginChallenge.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      return { kind: 'challenge', challenge };
    }

    await this.prisma.reviewer.update({ where: { id: reviewer.id }, data: { failedLogins: 0, lockedUntil: null } });
    const session = await this.startSession(reviewer.id);
    return { kind: 'session', ...session, reviewer, setupRequired: reviewer.tenant.requireReviewerTwoFactor };
  }

  /** Opens a browser session. Always a new token, so nothing from before sign-in carries over. */
  async startSession(reviewerId: string) {
    const token = randomToken();
    const expiresAt = new Date(Date.now() + ABSOLUTE_MS);
    await this.prisma.reviewerSession.create({ data: { reviewerId, tokenHash: sha256(token), expiresAt } });
    // Housekeeping: expired browser sessions are useless
    await this.prisma.reviewerSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    return { token, expiresAt };
  }

  /**
   * Refuses a sensitive action while the account is locked. Guessing a password or code from inside
   * an existing session must stop at the same lockout as signing in, not carry on beside it.
   */
  async assertNotLocked(reviewerId: string): Promise<void> {
    const r = await this.prisma.reviewer.findUnique({ where: { id: reviewerId }, select: { lockedUntil: true } });
    if (r?.lockedUntil && r.lockedUntil.getTime() > Date.now()) {
      throw new HttpException({ statusCode: 429, error: 'Too Many Requests', message: 'Too many failed attempts. Try again later.' }, 429);
    }
  }

  /** Re-checks the password for a sensitive action. A wrong one counts toward the lockout like any other. */
  async confirmPassword(reviewer: Reviewer, password: string): Promise<void> {
    const ok = await verifyPassword(password, reviewer.passwordHash);
    if (!ok) {
      await this.recordFailure(reviewer.id);
      throw new UnauthorizedException('Invalid password');
    }
  }

  /** One atomic statement: count the failure and lock on the fifth, so parallel guesses can't slip under the limit. */
  async recordFailure(reviewerId: string) {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE reviewers
      SET failed_logins = CASE WHEN failed_logins + 1 >= ${MAX_FAILURES} THEN 0 ELSE failed_logins + 1 END,
          locked_until = CASE WHEN failed_logins + 1 >= ${MAX_FAILURES}
                              THEN now() + ${LOCK_MS} * interval '1 millisecond' ELSE locked_until END
      WHERE id = ${reviewerId}`);
  }

  /** Resolves a cookie token to an active reviewer, or null. Slides the idle timeout. */
  async authenticate(token: string): Promise<Authenticated | null> {
    const session = await this.prisma.reviewerSession.findUnique({
      where: { tokenHash: sha256(token) },
      include: { reviewer: { include: { tenant: { select: { requireReviewerTwoFactor: true } } } } },
    });
    if (!session) return null;
    const now = Date.now();
    if (session.expiresAt.getTime() <= now || session.lastSeenAt.getTime() + IDLE_MS <= now || session.reviewer.disabled) {
      await this.prisma.reviewerSession.deleteMany({ where: { id: session.id } });
      return null;
    }
    if (now - session.lastSeenAt.getTime() > 60_000) {
      await this.prisma.reviewerSession.updateMany({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
    }
    const { tenant, ...reviewer } = session.reviewer;
    return { reviewer, sessionId: session.id, tenantRequires: tenant.requireReviewerTwoFactor, limited: tenant.requireReviewerTwoFactor && !reviewer.totpEnabledAt };
  }

  async logout(token: string) {
    await this.prisma.reviewerSession.deleteMany({ where: { tokenHash: sha256(token) } });
  }

  /** Ends every other browser session of this reviewer (after a change to their sign-in security). */
  async endOtherSessions(reviewerId: string, keepSessionId: string) {
    await this.prisma.reviewerSession.deleteMany({ where: { reviewerId, id: { not: keepSessionId } } });
  }
}
