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
- **Validity.** Both observed cards were issued 30.01.2024 and expire 29.01.2029, i.e. five years. Whether this varies is unconfirmed.
- The card is printed in Albanian, Serbian (Cyrillic) and English.

## Driving licence

- **No MRZ**, so there are no check digits. Verification relies on reading the printed fields and cross-checking them against the ID.
- Fields follow the EU numbering: 1 surname, 2 given name, 3 date and place of birth, 4a issue date, 4b expiry date, 4c issuing authority, 4d personal number, 5 licence number (`DL` + digits), 9 categories.
- The personal number on the licence (4d) matched the personal number on the same person's ID card in every sample, which makes it a useful cross-document check.
- Observed validity is ten years.
- The back carries a QR code and a per-category table. The QR content has not been examined.

### How the service handles it (`src/documents/licence`)

A session created with `requireDrivingLicence: true` must also upload `LICENCE_FRONT` (and may upload `LICENCE_BACK`) next to `ID_FRONT`, `ID_BACK` and `SELFIE`. After submit the pipeline:

1. Reads the licence front with OCR in `text` mode (no MRZ alphabet restriction; set `TESSERACT_TEXT_LANG`, for example `eng+sqi`, once the Albanian traineddata is installed).
2. Extracts fields 1, 2, 3, 4a, 4b, 4d, 5 and 9 by their printed numbers. Labels may sit on separate lines or one line, in any order, with `.` or `)`; dates accept `.`, `-`, `/`; names go through `normalizeName` (`ë` becomes `E`). Look-alike characters (O/0, I/1, S/5, B/8) are repaired in dates and numbers, and any repair is reported as `LICENCE_OCR_REPAIRED` so a person still looks. A field it cannot read is simply "not found"; nothing is guessed. Fields 1, 2, 3, 4a, 4b, 4d and 5 must all be read for the licence to count as read; categories (9) are recorded but not required because OCR garbles them most often.
3. Checks the dates: not expired, issued in the past, expiry after issue, validity between six months and 15 years (the samples show ten), holder at least 15 on the issue date.
4. **Cross-checks against the ID card's MRZ**: personal number (field 4d against the ID's optional data 2), surname, given names (one may be the leading part of the other, so a licence printing only the first name still matches) and date of birth. If the ID could not be read there is nothing to compare, which is reported as `LICENCE_CROSSCHECK_UNAVAILABLE`, never as a match.

Only flags and field *numbers* are stored and returned (`verification.licence`: `found`, `fields`, `expired`, `datesValid`, `repaired`, `crossCheck.{personalNumber,surname,givenNames,birthDate}`). No value printed on the licence is stored, logged or sent in a webhook; the ID's values used for the comparison exist only in memory. Auto-approval requires the licence to be completely clean (nothing flagged, no repair, every cross-check a match). Anything else goes to review, where the reviewer sees the licence images and each result.

Issue codes: `LICENCE_FRONT_MISSING`, `LICENCE_NOT_READABLE`, `LICENCE_FIELDS_INCOMPLETE`, `LICENCE_OCR_REPAIRED`, `LICENCE_EXPIRED`, `LICENCE_DATES_IMPLAUSIBLE`, `LICENCE_CROSSCHECK_UNAVAILABLE`, `LICENCE_PERSONAL_NUMBER_MISMATCH`, `LICENCE_SURNAME_MISMATCH`, `LICENCE_GIVEN_NAMES_MISMATCH`, `LICENCE_BIRTH_DATE_MISMATCH` (plus `OCR_UNAVAILABLE` when no engine is installed).

**Provisional.** The parser is written from the field numbering and the layout notes above, and tested only on synthetic text for fictional people. It has not been run on real licence photos. Tesseract's accuracy on a real card (the Albanian and Serbian text, the holographic background) is unknown, so expect many sessions to need review until it has been tuned against local samples in `fixtures/private/`.

**Not done on purpose.** The QR code on the back is **not decoded** (its content is unknown and decoding real documents needs your go-ahead). The licence portrait is not compared with the selfie; the face match still uses the ID photo. Categories are read but not returned to tenants.

## Verification layers

1. Chip read over NFC (strongest; needs a mobile SDK and Kosovo's signing certificates, availability unconfirmed).
2. MRZ parse and check digits (`src/documents/mrz`), then cross-check against supplied name and date of birth.
3. Face match and liveness.
4. Visual forensics (risk score only for now).

## Test data

Never commit real documents. `fixtures/private/` is git-ignored for local samples. Tests use fictional cards from `src/documents/mrz/testing.ts`. To check a real card locally without exposing its data, run its OCR text through `pnpm check:mrz`, which prints only pass/fail results.
