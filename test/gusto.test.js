// Gusto Payroll Journal Report (flat layout). Fixture and variants are
// synthetic, built on the layout in research/2026-11-06-payroll-report-formats.md.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse, write, convert, detectSource } from '../index.js';
import { readFixture } from '../test-support/fixtures.js';

const HEADER = ['Last Name', 'First Name', 'Work Address', 'Employee Type', 'Payment', 'Regular (Hours)', 'Regular (Rate)', 'Regular (Amount)', 'Additional Earnings', 'Gross Earnings', 'Employee Taxes', 'Federal Income Tax (Employee)', 'Social Security (Employee)', 'Medicare (Employee)', 'Additional Medicare (Employee)', 'NC State Tax (Employee)', 'Employer Taxes', 'Social Security (Employer)', 'Medicare (Employer)', 'FUTA (Employer)', 'NC Unemployment Tax (Employer)', 'Net Pay', 'Reimbursements', 'Donations', 'Check Amount', 'Employer Cost'];
const q = (cells) => cells.map((c) => `"${c}"`).join(',');

// One employee row from the money that matters; tax splits are derived so
// the sub-columns add up unless a test overrides them.
function emp(last, o) {
  const g = o.gross; const ee = o.eeTax; const er = o.erTax;
  const r = { 'Last Name': last, 'First Name': 'Test', 'Work Address': '1 Sample St, Durham, NC 27701', 'Employee Type': 'Paid by the hour', Payment: 'Direct Deposit', 'Regular (Hours)': '10.00', 'Regular (Rate)': '10.00', 'Regular (Amount)': g, 'Additional Earnings': '0.00', 'Gross Earnings': g, 'Employee Taxes': ee, 'Federal Income Tax (Employee)': ee, 'Social Security (Employee)': '0.00', 'Medicare (Employee)': '0.00', 'Additional Medicare (Employee)': '0.00', 'NC State Tax (Employee)': '0.00', 'Employer Taxes': er, 'Social Security (Employer)': er, 'Medicare (Employer)': '0.00', 'FUTA (Employer)': '', 'NC Unemployment Tax (Employer)': '', 'Net Pay': o.net, Reimbursements: o.reimb || '0.00', Donations: o.don || '0.00', 'Check Amount': o.check, 'Employer Cost': o.cost };
  return { ...r, ...(o.extra || {}) };
}
function block(rows, totals, { schedule = 'Weekly Payroll', payDay = '04/03/2026', title = true } = {}) {
  const lines = [];
  if (title) lines.push('"Employee Earnings"');
  lines.push(q([`${schedule} payroll period`, ' 03/23/2026 - 03/29/2026']));
  if (payDay) lines.push(q(['Pay day', ` ${payDay}`]));
  lines.push(q(HEADER));
  for (const r of rows) lines.push(q(HEADER.map((h) => r[h])));
  if (totals) lines.push(q(HEADER.map((h) => (h === 'Last Name' ? 'Payroll Totals' : ['First Name', 'Work Address', 'Employee Type', 'Payment', 'Regular (Rate)'].includes(h) ? '' : totals[h]))));
  return lines.join('\n');
}
const PRE = '"Payroll Journal Report"\n\n"Sample Co"\n"1 Sample St"\n"Durham","NC","27701"\n\n';
const A = { gross: '1000.00', eeTax: '200.00', erTax: '80.00', net: '800.00', check: '800.00', cost: '1080.00' };
const tot = (o) => emp('Payroll Totals', o);
const file = (...blocks) => PRE + blocks.join('\n\n') + '\n';

function journal(text, opts = {}) {
  const p = parse('gusto-payroll', text);
  const j = write('qbo-journal', p.transactions, { sourceId: 'gusto-payroll', ...opts });
  const rows = j.content.trim().split(/\r?\n/).slice(1).map((l) => l.split(','));
  return { p, j, rows };
}
const line = (rows, account, desc) => rows.find((r) => r[2] === account && (!desc || r[5].includes(desc)));
function balanced(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = r[0];
    const c = by.get(k) || 0;
    by.set(k, c + Math.round(Number(r[3] || 0) * 100) - Math.round(Number(r[4] || 0) * 100));
  }
  for (const [k, v] of by) assert.equal(v, 0, `entry ${k} does not balance`);
}

describe('Gusto payroll journal: fixture', () => {
  const text = readFixture('gusto-payroll-journal.csv');
  test('detected as gusto-payroll', () => assert.equal(detectSource(text).sourceId, 'gusto-payroll'));
  const { p, j, rows } = journal(text);
  test('two payrolls, one entry each, balanced', () => {
    assert.equal(p.meta.payrolls, 2);
    assert.equal(new Set(rows.map((r) => r[0])).size, 2);
    balanced(rows);
  });
  test('weekly payroll lines are the report totals', () => {
    const w = rows.filter((r) => r[5].includes('Weekly Payroll'));
    assert.equal(line(w, 'Payroll Expenses:Wages')[3], '1300.00');
    assert.equal(line(w, 'Payroll Expenses:Taxes')[3], '115.25');
    assert.equal(line(w, 'Payroll Liabilities:Taxes', 'Employee taxes withheld')[4], '251.95');
    assert.equal(line(w, 'Payroll Liabilities:Taxes', 'Employer payroll taxes owed')[4], '115.25');
    assert.equal(line(w, 'Checking')[4], '1048.05');
    assert.equal(w.length, 5, 'no clearing, deduction or contribution line');
  });
  test('meta says both payrolls reconcile', () => {
    assert.equal(p.meta.reconciled, true);
    assert.deepEqual(p.meta.payrollChecks.map((c) => [c.key, c.checkAmount, c.reconciled]), [['2026-03-13 Weekly Payroll', 1048.05, true], ['2026-03-13 Biweekly Payroll', 1537, true]]);
  });
  test('no WARNING on a file that adds up', () => assert.ok(![...p.warnings, ...j.warnings].some((w) => /WARNING/.test(w))));
  test('employee names and addresses are not in the outputs', () => {
    for (const t of ['qbo-journal', 'spreadsheet-csv']) {
      const out = write(t, p.transactions, { sourceId: 'gusto-payroll' }).content;
      assert.ok(!/Example|Ana|Ben|Cleo|Testcase|Example Ave/.test(out), t);
    }
  });
  test('bank files are refused with a plain reason', () => {
    for (const t of ['qbo', 'qfx', 'ofx', 'qbo-csv-3', 'qbo-csv-4', 'xero-csv']) {
      assert.throws(() => write(t, p.transactions, {}), (e) => e.code === 'NOT_SUPPORTED' && /not a bank statement/.test(e.message), t);
      assert.throws(() => convert('auto', text, t), (e) => e.code === 'NOT_SUPPORTED', t);
    }
  });
  test('account names can be set', () => {
    const r = journal(text, { accounts: { wages: 'Wages', payrollTaxesPayable: 'Tax Liab', bank: 'Payroll Checking' } }).rows;
    assert.ok(line(r, 'Wages') && line(r, 'Tax Liab') && line(r, 'Payroll Checking'));
  });
});

describe('Gusto payroll journal: derived lines', () => {
  test('deductions: gross - employee taxes - net pay goes to the deductions liability, with a note', () => {
    const e = { ...A, net: '750.00', check: '750.00' };
    const { p, rows } = journal(file(block([emp('One', e)], tot(e))));
    balanced(rows);
    assert.equal(line(rows, 'Payroll Liabilities:Deductions')[4], '50.00');
    assert.equal(line(rows, 'Checking')[4], '750.00');
    assert.ok(p.warnings.some((w) => /worked out as Gross Earnings minus Employee Taxes minus Net Pay/.test(w) && /50\.00/.test(w)));
  });
  test('employer contributions: employer cost - gross - employer taxes, expense and liability', () => {
    const e = { ...A, cost: '1130.00' };
    const { p, rows } = journal(file(block([emp('One', e)], tot(e))));
    balanced(rows);
    assert.equal(line(rows, 'Payroll Expenses:Benefits')[3], '50.00');
    assert.equal(line(rows, 'Payroll Liabilities:Deductions', 'contributions owed')[4], '50.00');
    assert.ok(p.warnings.some((w) => /Employer Cost minus Gross Earnings minus Employer Taxes/.test(w)));
  });
  test('reimbursements: an expense line, paid with the check', () => {
    const e = { ...A, reimb: '25.00', check: '825.00' };
    const { p, rows } = journal(file(block([emp('One', e)], tot(e))));
    balanced(rows);
    assert.equal(line(rows, 'Employee Reimbursements')[3], '25.00');
    assert.equal(line(rows, 'Checking')[4], '825.00');
    assert.ok(!line(rows, 'Uncategorized Asset'));
  });
  test('donations are not booked and are named', () => {
    const e = { ...A, don: '10.00', check: '790.00' };
    const { p, rows } = journal(file(block([emp('One', e)], tot(e))));
    balanced(rows);
    assert.ok(p.warnings.some((w) => /Donations are not booked/.test(w)));
    assert.equal(line(rows, 'Uncategorized Asset')[3] || line(rows, 'Uncategorized Asset')[4], '10.00');
  });
});

describe('Gusto payroll journal: checks against the report totals', () => {
  test('Check Amount total that differs from the lines: WARNING, gap to clearing, bank is the Check Amount', () => {
    const e = { ...A };
    const t = { ...A, check: '790.00' };
    const { p, j, rows } = journal(file(block([emp('One', e)], tot(t))));
    balanced(rows);
    assert.equal(line(rows, 'Checking')[4], '790.00');
    assert.equal(line(rows, 'Uncategorized Asset')[4], '10.00');
    assert.ok(p.warnings.some((w) => /^WARNING: the Gusto payroll .* does not add up/.test(w) && /difference -10\.00|difference 10\.00/.test(w)));
    assert.ok(p.warnings.some((w) => /^WARNING: .* do not add up to the Payroll Totals row: Check Amount 800\.00 vs 790\.00/.test(w)));
    assert.ok(j.warnings.some((w) => /payroll\(s\) do not add up/.test(w)));
    assert.equal(p.meta.reconciled, false);
  });
  test('employee rows that do not add up to Payroll Totals: WARNING naming the column', () => {
    const t = { ...A, gross: '1100.00' };
    const { p } = journal(file(block([emp('One', A)], tot(t))));
    assert.ok(p.warnings.some((w) => /^WARNING/.test(w) && /Gross Earnings 1000\.00 vs 1100\.00/.test(w)));
  });
  test('employee tax columns that do not add up to Employee Taxes: WARNING', () => {
    const t = { ...A, extra: { 'Federal Income Tax (Employee)': '150.00' } };
    const { p } = journal(file(block([emp('One', A)], tot(t))));
    assert.ok(p.warnings.some((w) => /^WARNING/.test(w) && /employee tax columns add up to 150\.00/.test(w)));
  });
  test('employer tax columns that do not add up to Employer Taxes: WARNING', () => {
    const t = { ...A, extra: { 'FUTA (Employer)': '5.00' } };
    const { p } = journal(file(block([emp('One', A)], tot(t))));
    assert.ok(p.warnings.some((w) => /^WARNING/.test(w) && /employer tax columns add up to 85\.00/.test(w)));
  });
  test('two employees and two schedules keep separate entries', () => {
    const B = { gross: '500.00', eeTax: '50.00', erTax: '40.00', net: '450.00', check: '450.00', cost: '540.00' };
    const T = { gross: '1500.00', eeTax: '250.00', erTax: '120.00', net: '1250.00', check: '1250.00', cost: '1620.00' };
    const { rows } = journal(file(block([emp('One', A), emp('Two', B)], tot(T)), block([emp('Three', B)], tot(B), { schedule: 'Biweekly Payroll' })));
    balanced(rows);
    assert.equal(new Set(rows.map((r) => r[0])).size, 2);
    assert.equal(rows.filter((r) => r[2] === 'Checking').map((r) => r[4]).sort().join(' '), '1250.00 450.00');
  });
  test('blank cells are not applicable, not an error', () => {
    const e = { ...A, extra: { 'Regular (Hours)': '', 'Additional Medicare (Employee)': '' } };
    assert.doesNotThrow(() => journal(file(block([emp('One', e)], tot(A)))));
  });
});

describe('Gusto payroll journal: refusals', () => {
  test('the job / pay type layout is refused by name, in detection and in parse', () => {
    const text = 'Payroll Journal Report\nSample Co\n\nRegular\nPay period, 03/23/2026 - 03/29/2026\nPay day, 04/03/2026\nLast Name,First Name,Work Address,Employee Type,Payment,Employee Taxes,Employer Taxes,Net Pay,Check Amount,Employer Cost,Job,Pay Type,Hours,Rate,Amount\nOne,Test,"1 Sample St",Paid by the hour,Check,1.00,1.00,9.00,9.00,11.00,Baker,Regular,1.000,10.00,10.00\n';
    const d = detectSource(text);
    assert.equal(d.sourceId, null);
    assert.match(d.reason, /one line per job and pay type/);
    assert.throws(() => parse('gusto-payroll', text), (e) => e.code === 'WRONG_SOURCE' && /Job, Pay Type/.test(e.message));
    assert.throws(() => parse('auto', text), (e) => /one line per job and pay type/.test(e.message));
  });
  test('no Payroll Totals row: refused (nothing to check against)', () => {
    assert.throws(() => parse('gusto-payroll', file(block([emp('One', A)], null))), (e) => e.code === 'BAD_FILE' && /no "Payroll Totals" row/.test(e.message));
  });
  test('no Pay day line: refused', () => {
    assert.throws(() => parse('gusto-payroll', file(block([emp('One', A)], tot(A), { payDay: null }))), (e) => e.code === 'BAD_FILE' && /Pay day/.test(e.message));
  });
  test('an amount that is not a number: refused with line and column', () => {
    const e = { ...A, gross: 'abc' };
    assert.throws(() => parse('gusto-payroll', file(block([emp('One', e)], tot(A)))), (x) => x.code === 'BAD_FILE' && /Gross Earnings/.test(x.message) && /Line 11/.test(x.message));
  });
  test('missing columns: refused', () => {
    assert.throws(() => parse('gusto-payroll', 'Date,Amount\n2026-01-01,5\n'), (e) => e.code === 'MISSING_COLUMNS' && /Gusto Payroll Journal Report/.test(e.message));
  });
  test('the same payroll twice: refused', () => {
    const b = block([emp('One', A)], tot(A));
    assert.throws(() => parse('gusto-payroll', file(b, b)), (e) => e.code === 'BAD_FILE' && /appears twice/.test(e.message));
  });
  test('two different payrolls with the same pay day and schedule are kept apart with a note', () => {
    const B = { ...A, gross: '900.00', net: '700.00', check: '700.00', cost: '980.00' };
    const { p, rows } = journal(file(block([emp('One', A)], tot(A)), block([emp('One', B)], tot(B))));
    balanced(rows);
    assert.equal(new Set(rows.map((r) => r[0])).size, 2);
    assert.ok(p.warnings.some((w) => /more than one Gusto payroll/.test(w)));
  });
  test('rows after a block that belong to no block are counted, not read', () => {
    const { p } = journal(file(block([emp('One', A)], tot(A))) + '"Employer Tax Breakdown"\n"Something","1.00"\n');
    assert.ok(p.warnings.some((w) => /2 row\(s\) after the first payroll block/.test(w)));
  });
});

describe('Gusto payroll journal: review fixes (GUSTO-REVIEW.md)', () => {
  test('finding 1: the same payroll twice with a different payment method is refused as a duplicate', () => {
    const b1 = block([emp('One', A)], tot(A));
    const b2 = block([emp('One', { ...A, extra: { Payment: 'Check' } })], tot(A));
    assert.throws(() => parse('gusto-payroll', file(b1, b2)), (e) => e.code === 'BAD_FILE' && /appears twice/.test(e.message));
  });
  test('finding 2: negative derived deduction goes to clearing with a WARNING, not to the deductions liability', () => {
    const e = { ...A, net: '850.00', check: '850.00' };
    const { p, rows } = journal(file(block([emp('One', e)], tot(e))));
    balanced(rows);
    assert.ok(!line(rows, 'Payroll Liabilities:Deductions'));
    assert.equal(line(rows, 'Uncategorized Asset')[3], '50.00');
    assert.ok(p.warnings.some((w) => /^WARNING: .*cannot be read as deductions: line 11/.test(w) && /50\.00 is booked to the clearing account/.test(w)));
    assert.equal(p.meta.reconciled, false);
  });
  test('finding 2: Net Pay with the opposite sign to Gross Earnings goes to clearing with a WARNING', () => {
    const e = { ...A, net: '(800.00)', check: '(800.00)' };
    const { p, rows } = journal(file(block([emp('One', e)], tot(e))));
    balanced(rows);
    assert.ok(!line(rows, 'Payroll Liabilities:Deductions'));
    assert.equal(line(rows, 'Uncategorized Asset')[4], '1600.00');
    assert.ok(p.warnings.some((w) => /^WARNING: .*line 11 \(Net Pay has the opposite sign to Gross Earnings\)/.test(w)));
  });
  test('finding 2: negative derived contribution is not booked as a benefit, with a WARNING', () => {
    const e = { ...A, cost: '1000.00' };
    const { p, rows } = journal(file(block([emp('One', e)], tot(e))));
    balanced(rows);
    assert.ok(!line(rows, 'Payroll Expenses:Benefits'));
    assert.ok(!line(rows, 'Payroll Liabilities:Deductions'));
    assert.ok(p.warnings.some((w) => /^WARNING: .*cannot be a benefit contribution/.test(w) && /80\.00/.test(w)));
    assert.equal(p.meta.reconciled, false);
  });
  test('finding 3: Employer Cost higher by exactly the reimbursements books no phantom benefit', () => {
    const e = { ...A, reimb: '25.00', check: '825.00', cost: '1105.00' };
    const { p, rows } = journal(file(block([emp('One', e)], tot(e))));
    balanced(rows);
    assert.equal(line(rows, 'Employee Reimbursements')[3], '25.00');
    assert.ok(!line(rows, 'Payroll Expenses:Benefits'));
    assert.ok(p.warnings.some((w) => /read as including them/.test(w)));
  });
  test('finding 3: reimbursements plus a different contribution amount is a WARNING', () => {
    const e = { ...A, reimb: '25.00', check: '825.00', cost: '1140.00' };
    const { p, rows } = journal(file(block([emp('One', e)], tot(e))));
    balanced(rows);
    assert.equal(line(rows, 'Payroll Expenses:Benefits')[3], '60.00');
    assert.ok(p.warnings.some((w) => /^WARNING: .*not confirmed whether Employer Cost includes reimbursements/.test(w)));
  });
  test('finding 6: a header without its own Pay day line does not borrow the previous block\'s pay day', () => {
    const b1 = block([emp('One', A)], tot(A));
    const lines2 = [q(HEADER), q(HEADER.map((h) => emp('Two', A)[h])), q(HEADER.map((h) => (h === 'Last Name' ? 'Payroll Totals' : tot(A)[h] ?? '')))].join('\n');
    assert.throws(() => parse('gusto-payroll', PRE + b1 + '\n' + lines2 + '\n'), (e) => e.code === 'BAD_FILE' && /Pay day/.test(e.message));
  });
});

describe('Gusto payroll journal: review round 2 fixes', () => {
  const B = { gross: '900.00', eeTax: '100.00', erTax: '70.00', net: '700.00', check: '700.00', cost: '970.00' };
  const T = { gross: '1900.00', eeTax: '300.00', erTax: '150.00', net: '1500.00', check: '1500.00', cost: '2050.00' };
  test('finding 10: the same payroll with its employee rows in another order is refused as a duplicate', () => {
    const b1 = block([emp('One', A), emp('Two', B)], tot(T));
    const b2 = block([emp('Two', B), emp('One', A)], tot(T));
    assert.throws(() => parse('gusto-payroll', file(b1, b2)), (e) => e.code === 'BAD_FILE' && /appears twice/.test(e.message));
  });
  test('finding 11: an impossible row is named and does not cancel a real deduction on another row', () => {
    const e1 = { ...A, net: '850.00', check: '850.00' }; // 50.00 more than gross - taxes
    const e2 = { ...B, net: '650.00', check: '650.00' }; // a real 150.00 deduction (900 - 100 - 650)
    const t = { ...T, net: '1500.00', check: '1500.00' };
    const { p, rows } = journal(file(block([emp('One', e1), emp('Two', e2)], tot(t))));
    balanced(rows);
    assert.equal(line(rows, 'Payroll Liabilities:Deductions')[4], '150.00');
    assert.equal(line(rows, 'Uncategorized Asset')[3], '50.00');
    assert.ok(p.warnings.some((w) => /^WARNING: .*1 employee row cannot be read as deductions: line 11/.test(w)));
    assert.equal(p.meta.reconciled, false);
  });
});
