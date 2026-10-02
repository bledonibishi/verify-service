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

## Verification layers

1. Chip read over NFC (strongest; needs a mobile SDK and Kosovo's signing certificates, availability unconfirmed).
2. MRZ parse and check digits (`src/documents/mrz`), then cross-check against supplied name and date of birth.
3. Face match and liveness.
4. Visual forensics (risk score only for now).

## Test data

Never commit real documents. `fixtures/private/` is git-ignored for local samples. Tests use fictional cards from `src/documents/mrz/testing.ts`. To check a real card locally without exposing its data, run its OCR text through `pnpm check:mrz`, which prints only pass/fail results.
