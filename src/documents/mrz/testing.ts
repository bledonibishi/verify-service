import { checkDigit } from './check-digit';

/** Builds synthetic TD1 MRZ lines with valid check digits. For tests only: never use real people. */
export interface Td1Fields {
  documentNumber: string;
  /** YYMMDD */
  birth: string;
  sex: 'M' | 'F' | '<';
  /** YYMMDD */
  expiry: string;
  personalNumber: string;
  surname: string;
  givenNames: string;
  issuer?: string;
  nationality?: string;
  documentType?: string;
}

const pad = (s: string, n: number) => s.padEnd(n, '<');

export function buildTd1(f: Td1Fields): string[] {
  const docNo = pad(f.documentNumber, 9);
  const line1 = pad(`${f.documentType ?? 'ID'}${f.issuer ?? 'RKS'}${docNo}${checkDigit(docNo)}`, 30);
  const optional2 = pad(f.personalNumber, 11);
  const body =
    `${f.birth}${checkDigit(f.birth)}${f.sex}${f.expiry}${checkDigit(f.expiry)}` +
    `${f.nationality ?? 'RKS'}${optional2}`;
  const composite = checkDigit(line1.slice(5, 30) + body.slice(0, 7) + body.slice(8, 15) + body.slice(18, 29));
  const line2 = body + composite;
  const names = `${f.surname.replace(/ /g, '<')}<<${f.givenNames.replace(/ /g, '<')}`;
  return [line1, line2, pad(names, 30)];
}

/** A fixed, obviously fictional card used across tests. */
export const SAMPLE: Td1Fields = {
  documentNumber: 'ID0000001',
  birth: '900515',
  sex: 'F',
  expiry: '290131',
  personalNumber: '1000000001',
  surname: 'TESTI',
  givenNames: 'DEMA',
};
