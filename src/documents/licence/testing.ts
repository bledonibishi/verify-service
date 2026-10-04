/** Builds synthetic licence text for tests. Fictional people only: never paste a real licence here. */
export interface LicenceText {
  surname: string;
  givenNames: string;
  /** dd.mm.yyyy */
  birth: string;
  issue: string;
  expiry: string;
  personalNumber: string;
  licenceNumber?: string;
  categories?: string;
  place?: string;
}

export function buildLicenceText(f: LicenceText): string {
  return [
    `1. ${f.surname}`,
    `2. ${f.givenNames}`,
    `3. ${f.birth} ${f.place ?? 'PRISHTINE'}`,
    `4a. ${f.issue} 4b. ${f.expiry}`,
    '4c. FICTIONAL AUTHORITY',
    `4d. ${f.personalNumber}`,
    `5. ${f.licenceNumber ?? 'DL1234567'}`,
    `9. ${f.categories ?? 'AM B'}`,
  ].join('\n');
}

/** Matches SAMPLE in ../mrz/testing.ts (a fictional person), valid until 2032. */
export const SAMPLE_LICENCE: LicenceText = {
  surname: 'TESTI',
  givenNames: 'DEMA',
  birth: '15.05.1990',
  issue: '12.03.2022',
  expiry: '12.03.2032',
  personalNumber: '1000000001',
};
