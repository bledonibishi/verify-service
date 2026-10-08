/**
 * Checks the ID back of a case already submitted, from its stored (encrypted) photo, the way the
 * service reads it, without ever writing the photo out:
 *
 *   pnpm check:session <sessionId> [--shape] [--variants] [--letters]
 *
 * Run it with the same storage settings as the service (for a local run: STORAGE_DRIVER=local
 * STORAGE_KEY_PROVIDER=env in front, as when starting the service). Prints only pass/fail per check,
 * issue codes, how the provided name and birth date differ from the card (word counts, look-alike
 * letters; never the names themselves, except with --letters: the differing letters only) and, with --shape / --variants, the OCR text's shape (digits as 9, letters as A):
 * safe to paste into a chat or issue. Needs tesseract.
 */
import { DocumentKind, PrismaClient } from '@prisma/client';
import { existsSync } from 'fs';
import { StorageService } from '../src/storage/storage.service';
import { checkImage } from './lib/check-image';

if (existsSync('.env')) {
  if (typeof process.loadEnvFile !== 'function') {
    console.error('This check needs Node 20.12 or newer to read .env');
    process.exit(1);
  }
  process.loadEnvFile('.env'); // settings given on the command line win
}

async function main() {
  const [sessionId, ...flags] = process.argv.slice(2);
  if (!sessionId || !/^[0-9a-f-]{36}$/.test(sessionId)) {
    console.log('usage: pnpm check:session <sessionId> [--shape] [--variants]');
    return 2;
  }
  const prisma = new PrismaClient();
  try {
    const doc = await prisma.document.findFirst({ where: { sessionId, kind: DocumentKind.ID_BACK }, select: { storageKey: true } });
    const expected = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { expectedFirstName: true, expectedLastName: true, expectedBirthDate: true },
    });
    if (!doc) {
      console.log('No ID back stored for that session (never uploaded, or already deleted by retention)');
      return 1;
    }
    const storage = new StorageService({ get: (k: string) => process.env[k] } as never);
    const image = await storage.get(doc.storageKey);
    return await checkImage(image, flags, {
      firstName: expected?.expectedFirstName,
      lastName: expected?.expectedLastName,
      birthDate: expected?.expectedBirthDate,
    });
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // Fixed messages only: errors can carry storage keys or recognised text
    const name = (err as Error)?.name;
    console.log(name === 'OcrUnavailableError' ? 'tesseract is not installed' : `could not check the photo (${name ?? 'error'}); run it with the same storage settings as the service`);
    process.exit(2);
  },
);
