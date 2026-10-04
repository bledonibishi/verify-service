import { emptyTotals, usageCsv } from './aggregate';
import { currentMonth, parseMonth } from './month';

describe('billing months', () => {
  it('are UTC calendar months', () => {
    const m = parseMonth('2026-10')!;
    expect(m.from.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(m.to.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(parseMonth('2026-12')!.to.toISOString()).toBe('2027-01-01T00:00:00.000Z'); // December rolls into the next year
    expect(parseMonth('2024-02')!.to.toISOString()).toBe('2024-03-01T00:00:00.000Z');
  });

  it.each(['2026-13', '2026-00', '2026-1', '26-10', '2026-10-01', '1999-12', '2101-01', '', ' 2026-10', '2026/10', 'abc'])('rejects %j', (raw) => {
    expect(parseMonth(raw)).toBeNull();
  });

  it('takes the current month from the UTC clock, not the local one', () => {
    expect(currentMonth(new Date('2026-10-31T23:59:59Z')).label).toBe('2026-10');
    expect(currentMonth(new Date('2026-11-01T00:00:00Z')).label).toBe('2026-11');
  });
});

describe('usageCsv', () => {
  const month = parseMonth('2026-10')!;
  const totals = { ...emptyTotals(), billable: 7, nonBillable: 1, adjustments: -2, net: 5, features: { face: 6, liveness: 4, licence: 2, autoDecided: 3 } };

  it('prints a header and one row per tenant', () => {
    expect(usageCsv(month, [{ tenantId: 't1', tenantName: 'Acme', totals }])).toBe(
      'month,tenant_id,tenant_name,billable,non_billable,adjustments,net_billable,face_matches,liveness_checks,licence_checks,auto_decided\n' +
        '2026-10,t1,Acme,7,1,-2,5,6,4,2,3\n',
    );
  });

  it('quotes fields that need it', () => {
    const csv = usageCsv(month, [{ tenantId: 't1', tenantName: 'Acme, "Bank"\nBranch', totals }]);
    expect(csv).toContain('"Acme, ""Bank""\nBranch"');
  });

  it('stops a tenant name from running as a spreadsheet formula', () => {
    for (const name of ['=HYPERLINK("http://evil")', '+1+1', '-1', '@SUM(A1)']) {
      const row = usageCsv(month, [{ tenantId: 't1', tenantName: name, totals }]).split('\n')[1];
      expect(row.split(',')[2].replace(/^"/, '')[0]).toBe("'");
    }
    // Negative numbers are numbers, not formulas, and stay as they are
    expect(usageCsv(month, [{ tenantId: 't1', tenantName: 'ok', totals }])).toContain(',-2,');
  });
});
