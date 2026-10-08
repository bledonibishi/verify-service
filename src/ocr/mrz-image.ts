import sharp from 'sharp';

/**
 * Cleaned-up versions of a photo for reading the MRZ. Tesseract decides black from white by
 * itself, and on a real card (grey print, a security pattern behind it, uneven light) it often
 * keeps the large `<` fillers and loses the letters and digits. These variants raise the local
 * contrast, enlarge the text and force hard black and white, on the bottom of the photo where the
 * MRZ is. They are tried one by one, only after the unmodified image failed, and are produced
 * lazily so a photo that reads on the first try costs nothing extra.
 *
 * Everything stays in memory; a corrupt or hostile image just yields no variants.
 */
const MAX_INPUT_PIXELS = 60_000_000;
const TARGET_WIDTH = 2200;
/** The enlarged crop never exceeds this many pixels, whatever the shape of the upload (a tall, narrow image would otherwise grow enormous). */
const MAX_WORK_PIXELS = 25_000_000;
const BORDER = 60;

/**
 * Bands of the photo to try, as [top, height] fractions of its height, most likely first. The MRZ is
 * at the bottom of the card, which is at the bottom of a close photo (the first three) but in the
 * middle of a photo taken from further away, with the card small in a big background (the next
 * two). The whole photo comes last.
 */
const BANDS: [number, number][] = [[0.65, 0.35], [0.5, 0.5], [0.75, 0.25], [0.45, 0.4], [0.3, 0.4], [0, 1]];
const THRESHOLDS: (number | null)[] = [null, 125, 155];

export interface MrzVariantOptions {
  /** Upper bound on how many variants are produced. */
  max?: number;
}

export async function* mrzVariants(image: Buffer, opts: MrzVariantOptions = {}): AsyncGenerator<Buffer> {
  const max = opts.max ?? 18;
  let width: number;
  let height: number;
  try {
    const meta = await sharp(image, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().metadata();
    // metadata() reports the stored size; an EXIF rotation of 5-8 swaps the sides
    const swapped = (meta.orientation ?? 1) >= 5;
    width = swapped ? meta.height ?? 0 : meta.width ?? 0;
    height = swapped ? meta.width ?? 0 : meta.height ?? 0;
  } catch {
    return;
  }
  if (width < 50 || height < 20) return;

  // A tight crop of the MRZ (very wide) is already the region; a whole photo needs cutting down
  const bands: [number, number][] = width / height >= 3.5 ? [[0, 1]] : BANDS;
  let produced = 0;
  for (const [topShare, heightShare] of bands) {
    const top = Math.round(height * topShare);
    const cropHeight = Math.min(height - top, Math.max(1, Math.round(height * heightShare)));
    if (produced >= max) return;
    // Enlarge to about TARGET_WIDTH, but never past the pixel budget
    let targetWidth = Math.max(width, TARGET_WIDTH);
    if (targetWidth * Math.ceil((cropHeight * targetWidth) / width) > MAX_WORK_PIXELS) {
      targetWidth = Math.max(1, Math.floor(Math.sqrt((MAX_WORK_PIXELS * width) / cropHeight)));
    }
    // The expensive part depends only on the crop, so it is done once and shared by the thresholds.
    // Two passes: sharp applies its operations in a fixed internal order, not the order they are
    // chained, and the threshold must come after the contrast work.
    let enhanced: Buffer;
    try {
      enhanced = await sharp(image, { limitInputPixels: MAX_INPUT_PIXELS })
        .rotate()
        .extract({ left: 0, top, width, height: cropHeight })
        .greyscale()
        .resize({ width: targetWidth })
        .normalise()
        .clahe({ width: 48, height: 48, maxSlope: 3 })
        .png()
        .toBuffer();
    } catch {
      continue; // this crop could not be made; the next may
    }
    for (const level of THRESHOLDS) {
      if (produced >= max) return;
      try {
        let pipe = sharp(enhanced);
        if (level !== null) pipe = pipe.threshold(level);
        // Mirrored edges, not a white frame: a frame turns a grey background into a dark box
        const out = await pipe.extend({ top: BORDER, bottom: BORDER, left: BORDER, right: BORDER, extendWith: 'mirror' }).png().toBuffer();
        produced++;
        yield out;
      } catch {
        // This variant could not be made; the next one may
      }
    }
  }
}
