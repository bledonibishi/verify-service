import { spawn } from 'child_process';
import { OcrError, OcrOptions, OcrProvider, OcrResult, OcrUnavailableError } from './ocr-provider';

/**
 * Self-hosted OCR through the `tesseract` command line. The image goes in on stdin and the text
 * comes back on stdout, so nothing is written to disk in the clear. The character whitelist fits
 * the MRZ alphabet; install the `ocrb` traineddata and set TESSERACT_LANG=ocrb for best accuracy.
 */
export class TesseractProvider implements OcrProvider {
  readonly name = 'tesseract';

  constructor(
    private readonly binary = 'tesseract',
    private readonly lang = 'eng',
    private readonly timeoutMs = 30_000,
    /** Languages for printed text (licences); the MRZ uses `lang`. e.g. `eng+sqi` once the Albanian data is installed. */
    private readonly textLang = 'eng',
  ) {}

  readText(image: Buffer, options: OcrOptions = {}): Promise<OcrResult> {
    return new Promise((resolve, reject) => {
      // The MRZ alphabet whitelist would destroy a licence (lower case, ë, punctuation), so printed
      // text is read without one.
      const args =
        options.mode === 'text'
          ? ['stdin', 'stdout', '-l', this.textLang, '--psm', '4']
          : ['stdin', 'stdout', '-l', this.lang, '--psm', '6', '-c', 'tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<'];
      const child = spawn(this.binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done(() => reject(new OcrError('timeout')));
      }, this.timeoutMs);

      child.stdout.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 1_000_000) {
          child.kill('SIGKILL');
          done(() => reject(new OcrError('output_too_large')));
          return;
        }
        chunks.push(c);
      });
      // stderr is drained and discarded: it can echo recognised text.
      child.stderr.resume();
      child.stdin.on('error', () => undefined);
      child.on('error', (err: NodeJS.ErrnoException) =>
        done(() =>
          reject(err.code === 'ENOENT' ? new OcrUnavailableError('tesseract is not installed') : new OcrError('spawn')),
        ),
      );
      child.on('close', (code) =>
        done(() =>
          code === 0 ? resolve({ text: Buffer.concat(chunks).toString('utf8') }) : reject(new OcrError('exit')),
        ),
      );
      child.stdin.end(image);
    });
  }
}
