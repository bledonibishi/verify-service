# Kosovo identity documents

What the service knows about Kosovo documents and how each one is verified. This is based on public sources and a small number of real samples; it has not been checked against official specifications, so treat observed details as provisional.

## Identity card (letërnjoftim)

Biometric cards have been issued since 2013. The card carries a contactless chip (PACE-protected) and a three-line MRZ on the back in the ICAO 9303 **TD1** format (3 lines × 30 characters).

| Line | Positions | Field |
| --- | --- | --- |
| 1 | 1–2 | Document type (`ID`) |
| 1 | 3–5 | Issuing state, `RKS` |
| 1 | 6–14 | Card number (observed: 2 letters + 7 digits) |
| 1 | 15 | Check digit for the card number |
| 1 | 16–30 | Optional data, empty on observed cards |
| 2 | 1–6 / 7 | Birth date YYMMDD / check digit |
| 2 | 8 | Sex (`M`, `F`, `<`) |
| 2 | 9–14 / 15 | Expiry date YYMMDD / check digit |
| 2 | 16–18 | Nationality, `RKS` |
| 2 | 19–29 | Personal number (10 digits) + filler |
| 2 | 30 | Composite check digit |
| 3 | 1–30 | `SURNAME<<GIVEN<NAMES` + filler |

Check digits use the standard 7-3-1 weighting. The composite digit covers line 1 positions 6–30, and line 2 positions 1–7, 9–15 and 19–29.

### Gotchas

- **`RKS` is not an ISO 3166 code.** Parsers that validate the country against ISO reject Kosovo documents. This module accepts it explicitly.
- **Check digits can't catch junk in the optional field.** Fifteen identical characters always contribute a multiple of 5 to the composite sum, so `KKKKKKKKKKKKKKK` passes whenever `K` has an even value. The parser therefore flags non-empty optional data directly.
- **Albanian letters.** Names print as `ë`/`ç` on the card but appear as `E`/`C` in the MRZ. Compare after normalising (`normalizeName`).
- **Names have no check digit**, so one misread letter in a name passes every check. A provided name equal to the card's except for one letter in one word of four letters or more is reported as `near_match` (issue `SURNAME_NEAR_MATCH` / `GIVEN_NAMES_NEAR_MATCH`), not `mismatch`. It never approves automatically: the reviewer compares the name with the photo of the card. Upper or lower case, accents (`ë`, `ç`), hyphens and apostrophes never cause a difference.
- **Validity.** Both observed cards were issued 30.01.2024 and expire 29.01.2029, i.e. five years. Whether this varies is unconfirmed.
- The card is printed in Albanian, Serbian (Cyrillic) and English.

### OCR lines of the wrong length (`src/documents/mrz/align.ts`)

Tesseract reads the characters of an MRZ well but miscounts runs of `<`, so a line that should be 30 characters comes back as 27 or 31, often with a short junk line (a field label) next to it. `readKosovoMrz` first tries the exact reader; if that fails it aligns each line to the known layout of its line and repairs it. The repair is deliberately narrow:

- It only adds or removes `<` fillers (and treats a stray letter in a filler run as a look-alike). It never invents a digit or chooses which of two digits is extra, because the check digits would then confirm a wrong guess about one time in ten by chance.
- The result is accepted only if every check digit passes **and** the personal number is 10 digits, the document number is 2 letters + 7 digits and optional data 1 is empty (a `<` and a `0` weigh the same in a check digit, so a lost trailing zero would otherwise pass).
- A repaired read carries the `OCR_REPAIRED` warning so the decision logic and reviewers can see it.

Known limit, shared with the exact reader: check digits cannot catch every error (a letter and a digit can weigh the same, e.g. `R` read as `7`).

### Photos Tesseract cannot read as given (`src/ocr/mrz-image.ts`)

On a real photo (grey print, a security pattern, uneven light) Tesseract often keeps the large `<` fillers and loses the letters and digits. When the image as uploaded does not give an MRZ whose check digits pass, the OCR step now tries cleaned-up versions of it, one at a time, and stops at the first that does: bands of the photo: the bottom 35%, 50% and 25% (a close photo), two bands across the middle (a card photographed small in a big background), then all of it; a tight MRZ crop is used whole, enlarged to about 2200 px wide, contrast-equalised (CLAHE), and either left grey or hard-thresholded at two levels. At most 18 variants are tried, within 60 seconds in total for the whole read (first attempt included, so a read finishes well inside the worker's 2-minute job lease), and the enlarged crop is capped at about 25 megapixels whatever the shape of the upload; a photo that reads on the first try costs nothing extra. Uses the `sharp` library (prebuilt binaries, no system install), in memory only. Photos over 60 megapixels or that are not images get no variants.

**Sideways or upside-down photos.** If the photo as given does not read and its reading has few `<` (an MRZ read the right way up keeps its fillers even when the letters fail; text read sideways gives almost none), the photo is also read turned 90°, 270° and 180° (EXIF orientation applied first). A turned photo that reads is accepted at once; otherwise the turn whose reading has the most `<` gets the cleaned-up versions first, then the others, all within the same 60 seconds. Tesseract's own orientation detection (`--psm 0`) was tried and not used: it needs extra language data and has no answer for a card small in a big photo, where the `<` count has none either. In that case upright is cleaned up first, and a small sideways card may run out of time; the capture page's tip (fill the picture with the card) avoids it.

Limits: it finds the MRZ by cutting the bottom of the photo, not by detecting it, so a photo where the card sits in the middle of a large background may still fail; the next step would be locating the `<` runs first. Install the `ocrb` language data for better accuracy still.

## Driving licence

- **No MRZ**, so there are no check digits. Verification relies on reading the printed fields and cross-checking them against the ID.
- Fields follow the EU numbering: 1 surname, 2 given name, 3 date and place of birth, 4a issue date, 4b expiry date, 4c issuing authority, 4d personal number, 5 licence number (`DL` + digits), 9 categories.
- The personal number on the licence (4d) matched the personal number on the same person's ID card in every sample, which makes it a useful cross-document check.
- Observed validity is ten years.
- The back carries a QR code and a per-category table. The QR content has not been examined.

### How the service handles it (`src/documents/licence`)

A session created with `requireDrivingLicence: true` must also upload `LICENCE_FRONT` (and may upload `LICENCE_BACK`) next to `ID_FRONT`, `ID_BACK` and `SELFIE`. After submit the pipeline:

1. Reads the licence front with OCR in `text` mode (no MRZ alphabet restriction; set `TESSERACT_TEXT_LANG`, for example `eng+sqi`, once the Albanian traineddata is installed).
2. Extracts fields 1, 2, 3, 4a, 4b, 4d, 5 and 9 by their printed numbers. Fields are accepted whole or not at all: a name containing digits or stray punctuation, a personal number that is not exactly ten digits, a date embedded in a longer run of digits, or a licence number that is not `DL` plus digits counts as unreadable rather than being trimmed to fit. Labels may sit on separate lines or one line, in any order, with `.` or `)`; dates accept `.`, `-`, `/`; names go through `normalizeName` (`ë` becomes `E`). Look-alike characters (O/0, I/1, S/5, B/8) are repaired in dates and numbers, and any repair is reported as `LICENCE_OCR_REPAIRED` so a person still looks. A field it cannot read is simply "not found"; nothing is guessed. Fields 1, 2, 3, 4a, 4b, 4d and 5 must all be read for the licence to count as read; categories (9) are recorded but not required because OCR garbles them most often.
3. Checks the dates in **calendar** terms and in the local (Kosovo, CET) day: not expired (a licence expiring today is still valid), not issued in the future (no allowance), expiry after issue, validity from six months to exactly 15 calendar years (the samples show ten), and the holder at least 15 on the issue date (29 February birthdays count from 1 March in a common year).
4. **Cross-checks against the ID card's MRZ**: personal number (field 4d against the ID's optional data 2), surname, given names (the licence may omit later names that the ID has, so a licence printing only the first name still matches, but it may never print a name the ID lacks) and date of birth. If the ID could not be read there is nothing to compare, which is reported as `LICENCE_CROSSCHECK_UNAVAILABLE`, never as a match.

Only flags and field *numbers* are stored and returned (`verification.licence`: `found`, `fields`, `expired`, `datesValid`, `repaired`, `crossCheck.{personalNumber,surname,givenNames,birthDate}`). No value printed on the licence is stored, logged or sent in a webhook; the ID's values used for the comparison exist only in memory. Auto-approval requires the licence to be completely clean (nothing flagged, no repair, every cross-check a match). Anything else goes to review, where the reviewer sees the licence images and each result.

Issue codes: `LICENCE_FRONT_MISSING`, `LICENCE_NOT_READABLE`, `LICENCE_FIELDS_INCOMPLETE`, `LICENCE_OCR_REPAIRED`, `LICENCE_EXPIRED`, `LICENCE_DATES_IMPLAUSIBLE`, `LICENCE_CROSSCHECK_UNAVAILABLE`, `LICENCE_PERSONAL_NUMBER_MISMATCH`, `LICENCE_SURNAME_MISMATCH`, `LICENCE_GIVEN_NAMES_MISMATCH`, `LICENCE_BIRTH_DATE_MISMATCH` `LICENCE_NOT_CHECKED` (a licence was required but the pipeline gave up before reading it), plus `OCR_UNAVAILABLE` when no engine is installed.

**Provisional.** The parser is written from the field numbering and the layout notes above, and tested only on synthetic text for fictional people. It has not been run on real licence photos. Tesseract's accuracy on a real card (the Albanian and Serbian text, the holographic background) is unknown, so expect many sessions to need review until it has been tuned against local samples in `fixtures/private/`.

**Data minimisation.** `LICENCE_FRONT` and `LICENCE_BACK` are accepted only for sessions created with `requireDrivingLicence`; for any other session the upload is refused (`400`) and nothing is stored, so a second government document is never collected unasked. `GET /v1/sessions/:id` shows `requireDrivingLicence`, and a session that required a licence always carries a `verification.licence` object (with `found: false` when it could not be checked), never `null`.

**Not done on purpose.** The QR code on the back is **not decoded** (its content is unknown and decoding real documents needs your go-ahead). The licence portrait is not compared with the selfie; the face match still uses the ID photo. Categories are read but not returned to tenants.

## Verification layers

1. Chip read over NFC (strongest; needs a mobile SDK and Kosovo's signing certificates, availability unconfirmed).
2. MRZ parse and check digits (`src/documents/mrz`), then cross-check against supplied name and date of birth.
3. Face match and liveness.
4. Visual forensics (risk score only for now).

## Test data

Never commit real documents. `fixtures/private/` is git-ignored for local samples. Tests use fictional cards from `src/documents/mrz/testing.ts`. To check a real card locally without exposing its data, run its OCR text through `pnpm check:mrz`, which prints only pass/fail results. To test a whole photo end to end the way the service reads it (including the cleaned-up variants), run `pnpm check:photo fixtures/private/<photo> [--shape]`; it needs `tesseract` installed and prints only pass/fail per check, plus with `--shape` the OCR text with digits shown as 9 and letters as A; `--variants` also prints the length and shape of every MRZ-like line each cleaned-up variant produces. For a case already submitted through the capture page (no file at hand), `pnpm check:session <sessionId> [--shape] [--variants]` does the same from the stored, encrypted photo, in memory only; run it with the same storage settings as the service.

To try the real face match once, with your own photos: `pnpm check:face fixtures/private/<id-front> fixtures/private/<selfie> --send-to-aws`. It sends both images to AWS Rekognition in `AWS_REGION` (using the credentials in `.env`), refuses to run without the flag, and prints only the outcome and similarity score. The IAM user needs `rekognition:CompareFaces`.
