/**
 * Manage reviewer accounts (the tenant's own staff who approve or reject sessions).
 *
 *   pnpm reviewer create <tenantId> <email> [name]   prints a one-time password
 *   pnpm reviewer reset <email>                      new one-time password, signs the person out
 *   pnpm reviewer disable <email>                    blocks login and ends their sessions
 *   pnpm reviewer enable <email>
 *   pnpm reviewer reset-2fa <email>                  turns off their two-factor sign-in (lost phone), ends their sessions
 *
 * A password can be supplied with REVIEWER_PASSWORD (min 12 characters) instead of generating one.
 */
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import { MIN_PASSWORD_LENGTH, hashPassword } from '../src/review/password';

const usage = () => {
  console.error('Usage: pnpm reviewer create <tenantId> <email> [name] | reset <email> | disable <email> | enable <email> | reset-2fa <email>');
  process.exit(1);
};

function choosePassword(): { password: string; generated: boolean } {
  const given = process.env.REVIEWER_PASSWORD;
  if (!given) return { password: randomBytes(18).toString('base64url'), generated: true };
  if (given.length < MIN_PASSWORD_LENGTH) {
    console.error(`REVIEWER_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
    process.exit(1);
  }
  return { password: given, generated: false };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const prisma = new PrismaClient();
  try {
    if (command === 'create') {
      const [tenantId, rawEmail, name] = args;
      if (!tenantId || !rawEmail?.includes('@')) usage();
      const email = rawEmail.trim().toLowerCase();
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) {
        console.error('No such tenant');
        process.exit(1);
      }
      const { password, generated } = choosePassword();
      const reviewer = await prisma.reviewer.create({
        data: { tenantId, email, name: name ?? null, passwordHash: await hashPassword(password) },
      });
      console.log(`Reviewer: ${reviewer.email} (tenant ${tenant.name})`);
      if (generated) console.log(`Password: ${password}`);
      console.log('Share it over a private channel; it cannot be shown again. Use "pnpm reviewer reset" to issue a new one.');
    } else if (command === 'reset') {
      const [rawEmail] = args;
      if (!rawEmail) usage();
      const { password, generated } = choosePassword();
      const reviewer = await prisma.reviewer.update({
        where: { email: rawEmail.trim().toLowerCase() },
        data: { passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null },
      });
      await prisma.reviewerSession.deleteMany({ where: { reviewerId: reviewer.id } });
      console.log(`Password reset for ${reviewer.email}; existing sign-ins ended.`);
      if (generated) console.log(`Password: ${password}`);
    } else if (command === 'reset-2fa') {
      const [rawEmail] = args;
      if (!rawEmail) usage();
      const reviewer = await prisma.reviewer.update({
        where: { email: rawEmail.trim().toLowerCase() },
        data: { totpSecretSealed: null, totpEnabledAt: null, totpLastStep: null, failedLogins: 0, lockedUntil: null },
      });
      await prisma.recoveryCode.deleteMany({ where: { reviewerId: reviewer.id } });
      await prisma.loginChallenge.deleteMany({ where: { reviewerId: reviewer.id } });
      await prisma.reviewerSession.deleteMany({ where: { reviewerId: reviewer.id } });
      console.log(`Two-factor sign-in turned off for ${reviewer.email}; their sessions ended. If their organisation requires it, they must set it up again at the next sign-in.`);
    } else if (command === 'disable' || command === 'enable') {
      const [rawEmail] = args;
      if (!rawEmail) usage();
      const reviewer = await prisma.reviewer.update({
        where: { email: rawEmail.trim().toLowerCase() },
        data: { disabled: command === 'disable' },
      });
      if (command === 'disable') await prisma.reviewerSession.deleteMany({ where: { reviewerId: reviewer.id } });
      console.log(`${reviewer.email} ${command}d`);
    } else {
      usage();
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err.code === 'P2002' ? 'That email is already in use' : err.code === 'P2025' ? 'No such reviewer' : 'Failed');
  process.exit(1);
});
