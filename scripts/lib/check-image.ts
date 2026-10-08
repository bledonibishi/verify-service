/**
 * Shared by check:photo (a file) and check:session (a stored case): reads an ID back the way the
 * service does and prints only pass/fail per check, issue codes and, on request, the OCR text's
 * shape (digits as 9, letters as A). Never names, numbers or dates.
 */
import { cleanMrzText, readKosovoMrz } from '../../src/documents/mrz';
import { mrzVariants } from '../../src/ocr/mrz-image';
import { TesseractProvider } from '../../src/ocr/tesseract.provider';
import { idBackJudge } from '../../src/verification/decision';
import { describeNameDiff } from './name-diff';

const shape = (t: string) => t.replace(/[0-9]/g, '9').replace(/[A-Za-z]/g, 'A');
const readable = (t: string) => readKosovoMrz(t)?.result.ok === true;

/** Reads an ID-back image the way the service does and prints only pass/fail, codes and shapes. Returns the exit code. */
export async function checkImage(image: Buffer, flags: string[], expected: { firstName?: string | null; lastName?: string | null; birthDate?: string | null } = {}): Promise<number> {
  const engine = new TesseractProvider();
  const asUploaded = await engine.readText(image);
  const direct = readable(asUploaded.text);
  // The same judgement as the service, including reading again for a name one letter off
  const judge = idBackJudge({ firstName: expected.firstName ?? undefined, lastName: expected.lastName ?? undefined, birthDate: expected.birthDate ?? undefined });
  const final = direct && judge.accept(asUploaded.text) ? asUploaded : await engine.readText(image, judge);
  const read = readKosovoMrz(final.text);
  console.log(`photo as uploaded: ${direct ? 'MRZ read' : 'MRZ not read'}`);
  if (!direct) console.log(`with cleaned-up variants: ${read?.result.ok ? 'MRZ read' : 'MRZ not read'}`);
  if (read) {
    console.log(`structure ${read.result.ok ? 'OK' : 'INVALID'}${read.repaired ? ' (needed OCR repair)' : ''}`);
    for (const c of read.result.checks) console.log(`  check digit ${c.field}: ${c.ok ? 'pass' : 'FAIL'}`);
    for (const i of read.result.issues) console.log(`  ${i.severity}: ${i.code}`);
    if (read.result.data) {
      console.log(`  document expired: ${read.result.data.expired ? 'yes' : 'no'}`);
      console.log(`  issuer RKS: ${read.result.data.issuingState === 'RKS' ? 'yes' : 'no'}`);
      // How the provided details differ from the card, without showing either
      if (expected.lastName) console.log(`  surname vs provided: ${describeNameDiff(expected.lastName, read.result.data.surname, flags.includes('--letters'))}`);
      if (expected.firstName) console.log(`  given names vs provided: ${describeNameDiff(expected.firstName, read.result.data.givenNames, flags.includes('--letters'))}`);
      if (expected.birthDate) console.log(`  birth date vs provided: ${expected.birthDate === read.result.data.birthDate ? 'same' : 'differs'}`);
    }
  }
  if (flags.includes('--variants')) {
    // For each way of reading the photo: the length and shape of every line that could be an MRZ line
    const describe = (label: string, text: string) => {
      const lines = text.split(/\r?\n/).map(cleanMrzText).filter((l) => l.length >= 20);
      // Only line 1 may show its first five characters (document type + RKS, the same on every
      // card, which is what a misread shows up in). A line counts as line 1 only if it is shaped like
      // it (letters, then 6-10 digits, then a run of fillers) AND has the R...K of RKS near its start;
      // otherwise nothing is shown. At most one line per reading is opened up.
      const line1 = lines.findIndex((l) => /^[A-Z]{5,8}[0-9]{6,10}<{6,}/.test(l) && /R.{0,2}K/.test(l.slice(0, 8)));
      console.log(`${label}: ${lines.length ? lines.map((l, i) => `${l.length}:${shape(l)}${i === line1 ? ` [starts ${l.slice(0, 5)}]` : ''}`).join('  |  ') : '(no long lines)'}`);
    };
    describe('as uploaded', asUploaded.text);
    let n = 0;
    for await (const v of mrzVariants(image)) describe(`variant ${n++}`, (await engine.readText(v)).text);
  }
  if (!read?.result.ok && flags.includes('--shape')) console.log('OCR shape (digits=9, letters=A):\n' + shape(final.text));
  return read?.result.ok ? 0 : 1;
}

