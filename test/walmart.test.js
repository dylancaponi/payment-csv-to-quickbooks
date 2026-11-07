// Walmart Marketplace Recon report (CSV). Fixture and variants are synthetic,
// built on the layout in research/2026-11-06-marketplace-payout-formats.md.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse, write, detectSource } from '../index.js';
import { readFixture } from '../test-support/fixtures.js';

const FX = readFixture('walmart-recon-report.csv');
const lines = FX.trim().split('\n');
const HEAD = lines[0];
const SUMMARY = lines[1];
const ITEMS = lines.slice(2);
const make = (summary, items) => [HEAD, summary, ...items].join('\n') + '\n';
function journal(text) {
  const p = parse('walmart-recon', text);
  const j = write('qbo-journal', p.transactions, { sourceId: 'walmart-recon' });
  const rows = j.content.trim().split(/\r?\n/).slice(1).map((l) => l.split(','));
  return { p, j, rows };
}
const find = (rows, desc) => rows.find((r) => r[5].startsWith(desc));
function balanced(rows) {
  let d = 0; let c = 0;
  for (const r of rows) { d += Math.round(Number(r[3] || 0) * 100); c += Math.round(Number(r[4] || 0) * 100); }
  assert.equal(d, c);
}

describe('Walmart Recon report: fixture', () => {
  const { p, j, rows } = journal(FX);
  test('detected', () => assert.equal(detectSource(FX).sourceId, 'walmart-recon'));
  test('reconciles to Total Payable, no WARNING', () => {
    assert.equal(p.meta.reconciled, true);
    assert.equal(p.meta.depositTotal, 65.84);
    assert.ok(!p.warnings.some((w) => /WARNING/.test(w)));
  });
  test('one balanced entry dated on the posted date, bank line is Total Payable', () => {
    balanced(rows);
    assert.equal(new Set(rows.map((r) => r[0])).size, 1);
    assert.equal(rows[0][1], '03/18/2026');
    assert.equal(rows.find((r) => r[2] === 'Checking')[3], '65.84');
    assert.ok(!rows.some((r) => r[2] === 'Uncategorized Asset'));
  });
  test('named lines', () => {
    assert.equal(find(rows, 'Product sales')[4], '88.99');
    assert.equal(find(rows, 'Shipping charged to buyers')[4], '5.99');
    assert.equal(find(rows, 'Walmart commission')[3], '12.75', 'refund commission given back reduces the fee');
    assert.equal(find(rows, 'Refunds: product')[3], '10.00');
    assert.equal(find(rows, 'Walmart shipping labels')[3], '6.39');
    assert.equal(find(rows, 'Sales tax charged to buyers')[4], '4.12');
    assert.equal(find(rows, 'Sales tax kept by Walmart')[3], '4.12');
  });
  test('bank-style files carry the separate clearing account notice', () => {
    for (const t of ['qbo', 'xero-csv', 'qbo-csv-3']) assert.match(write(t, p.transactions, { sourceId: 'walmart-recon' }).warnings[0], /separate Walmart clearing account/);
  });
  test('journal warnings do not repeat the bank notice', () => assert.ok(!j.warnings.some((w) => /separate Walmart clearing/.test(w))));
});

describe('Walmart Recon report: checks and refusals', () => {
  test('rows that do not add up to Total Payable: WARNING, gap to clearing, bank is Total Payable', () => {
    const { p, rows } = journal(make(SUMMARY.replace(',65.84,', ',70.84,'), ITEMS));
    balanced(rows);
    assert.equal(rows.find((r) => r[2] === 'Checking')[3], '70.84');
    assert.equal(rows.find((r) => r[2] === 'Uncategorized Asset')[4], '5.00');
    assert.ok(p.warnings.some((w) => /^WARNING: the Walmart Recon report .* does not add up/.test(w) && /difference -5\.00/.test(w)));
    assert.equal(p.meta.reconciled, false);
  });
  test('a missing row shows up in the total check', () => {
    const { p } = journal(make(SUMMARY, ITEMS.slice(1)));
    assert.ok(p.warnings.some((w) => /^WARNING/.test(w) && /difference -49\.99/.test(w)));
  });
  test('unknown adjustment and amount type: own line, named in a warning, still balanced', () => {
    const extra = ITEMS[ITEMS.length - 1].replace('Walmart Shipping Label Service Charge', 'Something New').replace('-6.39', '-1.00');
    const { p, rows } = journal(make(SUMMARY.replace(',65.84,', ',64.84,'), [...ITEMS, extra]));
    balanced(rows);
    assert.ok(find(rows, 'Other Walmart amounts: Adjustment / Fee/Reimbursement (money out)'));
    assert.ok(p.warnings.some((w) => /does not recognise yet: Adjustment \/ Fee\/Reimbursement \(money out\) \(1 row, -1\.00: "Something New" -1\.00\)/.test(w)));
    assert.equal(p.meta.reconciled, true);
  });
  test('tax not withheld by Walmart goes to Sales Tax / VAT Payable with a warning', () => {
    const items = ITEMS.filter((l) => !/Product tax withheld/.test(l));
    const { p, rows } = journal(make(SUMMARY.replace(',65.84,', ',69.96,'), items));
    balanced(rows);
    assert.equal(rows.find((r) => r[2] === 'Sales Tax / VAT Payable')[4], '4.12');
    assert.ok(p.warnings.some((w) => /4\.12 of sales tax charged to buyers was not kept back by Walmart/.test(w)));
  });
  test('an unreadable amount is a WARNING and left out', () => {
    const { p } = journal(make(SUMMARY, [ITEMS[0].replace(',49.99,', ',abc,'), ...ITEMS.slice(1)]));
    assert.ok(p.warnings.some((w) => /^WARNING: 1 Walmart row has/.test(w) && /"abc"/.test(w)));
    assert.equal(p.meta.reconciled, false);
  });
  test('no PaymentSummary row: refused', () => {
    assert.throws(() => parse('walmart-recon', make(ITEMS[0], ITEMS.slice(1))), (e) => e.code === 'BAD_FILE' && /no PaymentSummary row/.test(e.message));
  });
  test('two PaymentSummary rows (reports pasted together): refused', () => {
    assert.throws(() => parse('walmart-recon', make(SUMMARY, [...ITEMS, SUMMARY])), (e) => e.code === 'BAD_FILE' && /2 PaymentSummary rows/.test(e.message));
  });
  test('unreadable Total Payable or date: refused', () => {
    assert.throws(() => parse('walmart-recon', make(SUMMARY.replace(',65.84,', ',x,'), ITEMS)), (e) => e.code === 'BAD_FILE' && /Total Payable/.test(e.message));
    assert.throws(() => parse('walmart-recon', make(SUMMARY.replace('03/01/2026,03/14/2026', ',').replace(',03/18/2026,', ',,'), ITEMS)), (e) => e.code === 'BAD_FILE' && /dated/.test(e.message));
  });
  test('the JSON form of the report is refused by name', () => {
    const json = '{"reportData":[{"Period Start Date":"03/01/2026","Transaction Type":"PaymentSummary","Total Payable":"1.00"}]}';
    assert.equal(detectSource(json).sourceId, null);
    assert.match(detectSource(json).reason, /JSON form of the Walmart Recon report/);
    assert.throws(() => parse('walmart-recon', json), (e) => e.code === 'WRONG_SOURCE' && /JSON form/.test(e.message));
  });
  test('missing columns: refused', () => {
    assert.throws(() => parse('walmart-recon', 'Date,Amount\n2026-01-01,5\n'), (e) => e.code === 'MISSING_COLUMNS' && /Walmart Recon report/.test(e.message));
  });
  test('a negative payout is booked as money out of the bank with a note', () => {
    const items = [ITEMS[ITEMS.length - 1]];
    const { p, rows } = journal(make(SUMMARY.replace(',65.84,', ',-6.39,'), items));
    balanced(rows);
    assert.equal(rows.find((r) => r[2] === 'Checking')[4], '6.39');
    assert.ok(p.warnings.some((w) => /is negative/.test(w)));
  });
});

describe('Walmart Recon report: review fixes (WALMART-REVIEW.md)', () => {
  test('finding 1: an unreadable posted timestamp falls back to the period end with a WARNING naming both', () => {
    const { p, rows } = journal(make(SUMMARY.replace(',03/18/2026,', ',2026-03-18T10:00:00Z,'), ITEMS));
    assert.equal(rows[0][1], '03/14/2026');
    assert.ok(p.warnings.some((w) => /^WARNING: .*Transaction Posted Timestamp \("2026-03-18T10:00:00Z"\).*Period End Date, 2026-03-14/.test(w)));
    const blank = journal(make(SUMMARY.replace(',03/18/2026,', ',,'), ITEMS));
    assert.ok(blank.p.warnings.some((w) => /^WARNING: .*Transaction Posted Timestamp \(""\)/.test(w)));
  });
  test('finding 2: many distinct unknown descriptions make one line, the warning lists five and counts the rest', () => {
    const base = ITEMS[ITEMS.length - 1];
    const extra = Array.from({ length: 1500 }, (_, i) => base.replace('Walmart Shipping Label Service Charge', `Odd charge ${i}`).replace('-6.39', '-0.01'));
    const { p, j, rows } = journal(make(SUMMARY.replace(',65.84,', ',50.84,'), [...ITEMS, ...extra]));
    balanced(rows);
    assert.ok(rows.length < 20);
    const other = rows.filter((r) => r[5].startsWith('Other Walmart amounts'));
    assert.equal(other.length, 1);
    assert.equal(other[0][3], '15.00');
    const w = p.warnings.find((x) => /does not recognise yet/.test(x));
    assert.ok(/Adjustment \/ Fee\/Reimbursement \(money out\) \(1500 rows, -15\.00: "Odd charge 0" -0\.01/.test(w) && /and 1495 more descriptions/.test(w) && w.length < 1000);
    assert.ok(!j.warnings.some((x) => /1 files/.test(x)));
  });
  test('finding 2: a journal entry over 1,000 lines gets a WARNING, not "1 files"', () => {
    const txns = [];
    for (let i = 0; i < 1100; i++) txns.push({ date: '2026-03-18', amount: 1, currency: 'USD', type: 'other', payoutId: 'P1', journalLine: `Line ${i}`, description: `x${i}` });
    txns.push({ date: '2026-03-18', amount: -1100, currency: 'USD', type: 'payout', payoutId: 'P1', description: 'payout' });
    const j = write('qbo-journal', txns, {});
    assert.ok(j.warnings.some((w) => /^WARNING: journal entry .* has 1101 lines/.test(w)));
    assert.ok(!j.warnings.some((w) => /1 files/.test(w)));
    assert.equal(j.parts, undefined);
  });
  test('finding 4: a posted date outside the period gets a note', () => {
    const { p } = journal(make(SUMMARY.replace(',03/18/2026,', ',01/02/2025,'), ITEMS));
    assert.ok(p.warnings.some((w) => /dated 2025-01-02, which is before the end of its period/.test(w)));
    assert.ok(!journal(FX).p.warnings.some((w) => /its period/.test(w)));
  });
});

describe('Walmart Recon report: review round 2', () => {
  test('finding 6: mixed-sign unknown amounts keep a money-in and a money-out line', () => {
    const base = ITEMS[ITEMS.length - 1];
    const fee = base.replace('Walmart Shipping Label Service Charge', 'WFS Fulfillment fee').replace('-6.39', '-20.00');
    const back = base.replace('Walmart Shipping Label Service Charge', 'WFS reimbursement').replace('-6.39', '20.00');
    const { p, rows } = journal(make(SUMMARY, [...ITEMS, fee, back]));
    balanced(rows);
    assert.equal(find(rows, 'Other Walmart amounts: Adjustment / Fee/Reimbursement (money out)')[3], '20.00');
    assert.equal(find(rows, 'Other Walmart amounts: Adjustment / Fee/Reimbursement (money in)')[4], '20.00');
    assert.ok(p.warnings.some((w) => /money in and money out separately/.test(w) && !/each on its own line/.test(w)));
  });
});
