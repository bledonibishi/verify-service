import { spawn } from 'child_process';
import { mrzVariants } from './mrz-image';
import { OcrError, OcrOptions, OcrProvider, OcrResult, OcrUnavailableError } from './ocr-provider';

/** Not worth starting another attempt with less time than this left. */
const MIN_ATTEMPT_MS = 2_000;

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
    /**
     * Total time one MRZ read may take, first attempt included. Kept well under the worker's job
     * lease so a photo that never reads cannot outlive it and be claimed twice.
     */
    private readonly mrzBudgetMs = 60_000,
  ) {}

  async readText(image: Buffer, options: OcrOptions = {}): Promise<OcrResult> {
    // The MRZ alphabet whitelist would destroy a licence (lower case, ë, punctuation), so printed
    // text is read without one.
    if (options.mode === 'text') return this.run(image, ['stdin', 'stdout', '-l', this.textLang, '--psm', '4']);
    const args = ['stdin', 'stdout', '-l', this.lang, '--psm', '6', '-c', 'tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<'];
    const deadline = Date.now() + this.mrzBudgetMs;
    const first = await this.run(image, args);
    if (!options.accept || options.accept(first.text)) return first;

    // The photo as given did not read. Try cleaned-up versions, within a time budget, and fall
    // back to the first reading (which the caller will report as unreadable) if none works.
    for await (const variant of mrzVariants(image)) {
      const remaining = deadline - Date.now();
      if (remaining < MIN_ATTEMPT_MS) break;
      try {
        // A run never goes past the budget either, so the total is bounded, not just the start
        const next = await this.run(variant, args, Math.min(this.timeoutMs, remaining));
        if (options.accept(next.text)) return next;
      } catch (err) {
        if (err instanceof OcrUnavailableError) throw err;
        break; // a hung or failing engine: stop here rather than stack up more waits
      }
    }
    return first;
  }

  private run(image: Buffer, args: string[], timeoutMs = this.timeoutMs): Promise<OcrResult> {
    return new Promise((resolve, reject) => {
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
      }, timeoutMs);

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
