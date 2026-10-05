export { checkDigit } from './check-digit';
export { parseTd1 } from './td1';
export type { MrzCheck, MrzIssue, MrzIssueCode, Td1Data, Td1Result } from './td1';
export { extractTd1Lines, parseKosovoTd1, readKosovoMrz, repairKosovoTd1 } from './repair';
export { alignLine, extractApproximateTd1, cleanMrzText } from './align';
export type { LenientResult } from './repair';
export { compareIdentity, normalizeName } from './identity';
export type { ExpectedIdentity, FieldMatch, IdentityComparison } from './identity';
