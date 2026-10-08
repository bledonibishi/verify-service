import { spawn } from 'child_process';
import { mrzVariants, rotateImage } from './mrz-image';
import { OcrError, OcrOptions, OcrProvider, OcrResult, OcrUnavailableError } from './ocr-provider';

/** Not worth starting another attempt with less time than this left. */
const MIN_ATTEMPT_MS = 2_000;
/**
 * A reading with at least this many `<` saw an MRZ the right way up, even if it misread the rest:
 * the fillers survive where letters and digits do not. Text read sideways gives none or one.
 */
const MRZ_FILLER_SIGNAL = 8;
const fillers = (text: string) => (text.match(/</g) ?? []).length;

/** Clockwise turns of the photo, after upright: sideways both ways, then upside down. */
type Turn = 90 | 180 | 270;
const TURNS: Turn[] = [90, 270, 180];

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
    const accept = options.accept;
    if (!accept || accept(first.text)) return first;
    // What is handed back if nothing is accepted: the first reading worth keeping, else the first
    let kept: OcrResult | null = options.fallback?.(first.text) ? first : null;
    const keep = (r: OcrResult) => {
      if (!kept && options.fallback?.(r.text)) kept = r;
    };

    // The photo as given did not read. Try cleaned-up versions, and the photo turned a quarter at
    // a time (a card photographed sideways or upside down), within a time budget, and fall back to
    // the kept or first reading (which the caller may report as unreadable) if none works.
    let stopped = false;
    const attempt = async (candidate: Buffer): Promise<{ result: OcrResult; accepted: boolean } | null> => {
      const remaining = deadline - Date.now();
      if (remaining < MIN_ATTEMPT_MS) {
        stopped = true;
        return null;
      }
      try {
        // A run never goes past the budget either, so the total is bounded, not just the start
        const result = await this.run(candidate, args, Math.min(this.timeoutMs, remaining));
        const accepted = accept(result.text);
        if (!accepted) keep(result);
        return { result, accepted };
      } catch (err) {
        if (err instanceof OcrUnavailableError) throw err;
        stopped = true; // a hung or failing engine: stop rather than stack up more waits
        return null;
      }
    };

    // Which way up is the card? A first reading full of `<` saw the MRZ upright. Otherwise the
    // photo is read once at each turn, and the turn whose reading has the most `<` gets the
    // cleaned-up versions first. A card small in a big photo gives no sign either way; then
    // upright comes first.
    const turned = new Map<Turn, Buffer | null>();
    const turn = async (t: Turn) => {
      if (!turned.has(t)) turned.set(t, await rotateImage(image, t));
      return turned.get(t) ?? null;
    };
    let best: 0 | Turn = 0;
    if (fillers(first.text) < MRZ_FILLER_SIGNAL) {
      let most = fillers(first.text);
      for (const t of TURNS) {
        const photo = await turn(t);
        if (!photo) continue;
        const read = await attempt(photo);
        if (read?.accepted) return read.result;
        if (stopped) return kept ?? first;
        const n = fillers(read?.result.text ?? '');
        if (n >= MRZ_FILLER_SIGNAL && n > most) [best, most] = [t, n];
      }
    }

    for (const t of [best, ...([0, ...TURNS] as const).filter((x) => x !== best)]) {
      const photo = t === 0 ? image : await turn(t);
      if (!photo) continue;
      for await (const variant of mrzVariants(photo)) {
        const read = await attempt(variant);
        if (read?.accepted) return read.result;
        if (stopped) return kept ?? first;
      }
    }
    return kept ?? first;
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
