import { Injectable, UnauthorizedException } from '@nestjs/common';
import { Prisma, Reviewer } from '@prisma/client';
import { randomUUID } from 'crypto';
import { randomToken, sha256 } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { DUMMY_HASH, verifyPassword } from './password';

export const COOKIE_NAME = 'vr_session';
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const ABSOLUTE_MS = 8 * 3600_000;
const IDLE_MS = 60 * 60_000;

@Injectable()
export class ReviewAuthService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Checks credentials and opens a browser session. Every failure (unknown email, wrong password,
   * disabled or locked account) gives the same error, and a password check always runs, so
   * neither the message nor the timing says which accounts exist.
   */
  async login(email: string, password: string): Promise<{ token: string; expiresAt: Date; reviewer: Reviewer }> {
    const reviewer = await this.prisma.reviewer.findUnique({ where: { email: email.trim().toLowerCase() } });
    const ok = await verifyPassword(password, reviewer?.passwordHash ?? DUMMY_HASH);
    const locked = !!reviewer?.lockedUntil && reviewer.lockedUntil.getTime() > Date.now();

    if (!reviewer || reviewer.disabled || locked || !ok) {
      // Every failure path runs the same single statement before answering, against a random id
      // when there is nothing to count, so response time does not reveal which emails exist.
      const counts = !!reviewer && !reviewer.disabled && !locked && !ok;
      await this.recordFailure(counts ? reviewer.id : randomUUID());
      throw new UnauthorizedException('Invalid email or password');
    }

    await this.prisma.reviewer.update({ where: { id: reviewer.id }, data: { failedLogins: 0, lockedUntil: null } });
    const token = randomToken();
    const expiresAt = new Date(Date.now() + ABSOLUTE_MS);
    await this.prisma.reviewerSession.create({ data: { reviewerId: reviewer.id, tokenHash: sha256(token), expiresAt } });
    // Housekeeping: expired browser sessions are useless
    await this.prisma.reviewerSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    return { token, expiresAt, reviewer };
  }

  /** One atomic statement: count the failure and lock on the fifth, so parallel guesses can't slip under the limit. */
  private async recordFailure(reviewerId: string) {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE reviewers
      SET failed_logins = CASE WHEN failed_logins + 1 >= ${MAX_FAILURES} THEN 0 ELSE failed_logins + 1 END,
          locked_until = CASE WHEN failed_logins + 1 >= ${MAX_FAILURES}
                              THEN now() + ${LOCK_MS} * interval '1 millisecond' ELSE locked_until END
      WHERE id = ${reviewerId}`);
  }

  /** Resolves a cookie token to an active reviewer, or null. Slides the idle timeout. */
  async authenticate(token: string): Promise<Reviewer | null> {
    const session = await this.prisma.reviewerSession.findUnique({
      where: { tokenHash: sha256(token) },
      include: { reviewer: true },
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
    return session.reviewer;
  }

  async logout(token: string) {
    await this.prisma.reviewerSession.deleteMany({ where: { tokenHash: sha256(token) } });
  }
}
