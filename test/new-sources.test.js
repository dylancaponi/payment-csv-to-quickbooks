// Square, Shopify Payments and Wise (added 2026-11-05). Header provenance in
// FORMATS.md; fixtures follow the confirmed headers with invented data.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse, write, detectSource, summarizePayouts, EngineError, parseCSV } from '../index.js';
import { CASES, readFixture, centsOf } from '../test-support/fixtures.js';
import { validateOfx } from '../test-support/ofx-validator.js';
import { checkQboCsv, checkXeroCsv, checkJournal, strictParse } from '../test-support/csv-checks.js';
import * as square from '../src/sources/square.js';
import * as shopify from '../src/sources/shopify.js';
import * as wise from '../src/sources/wise.js';
import * as venmo from '../src/sources/venmo.js';
import * as cashapp from '../src/sources/cashapp.js';
import * as paypal from '../src/sources/paypal.js';
import * as stripe from '../src/sources/stripe.js';
import * as etsy from '../src/sources/etsy.js';
import * as airbnb from '../src/sources/airbnb.js';
import * as gumroad from '../src/sources/gumroad.js';
import * as generic from '../src/sources/generic.js';

const isEngineError = (code) => (e) => e instanceof EngineError && (!code || e.code === code) && e.message.length > 20;
const cents = (n) => Math.round(n * 100);
const NEW = new Set(['square', 'shopify-transactions', 'shopify-payouts', 'wise']);

const DETECTORS = {
  venmo: (r) => venmo.detect(r), cashapp: (r) => cashapp.detect(r), paypal: (r) => paypal.detect(r),
  'stripe-balance': (r) => stripe.detect(r, 'stripe-balance'), 'stripe-payouts': (r) => stripe.detect(r, 'stripe-payouts'),
  etsy: (r) => etsy.detect(r), airbnb: (r) => airbnb.detect(r), gumroad: (r) => gumroad.detect(r), 'generic-bank': (r) => generic.detect(r),
  square: (r) => square.detect(r), 'shopify-transactions': (r) => shopify.detect(r, 'shopify-transactions'),
  'shopify-payouts': (r) => shopify.detect(r, 'shopify-payouts'), wise: (r) => wise.detect(r),
};

// Square header, with values filled by name.
const SQ_HEADER = 'Date,Time,Time Zone,Gross Sales,Discounts,Service Charges,Net Sales,Gift Card Sales,Tax,Tip,Partial Refunds,Total Collected,Source,Card,Card Entry Methods,Cash,Square Gift Card,Other Tender,Other Tender Type,Tender Note,Fees,Net Total,Transaction ID,Payment ID,Card Brand,PAN Suffix,Device Name,Staff Name,Staff ID,Details,Description,Event Type,Location,Dining Option,Customer ID,Customer Name,Customer Reference ID,Device Nickname,Third Party Fees,Deposit ID,Deposit Date,Deposit Details,Fee Percentage Rate,Fee Fixed Rate,Refund Reason,Discount Name,Transaction Status,Cash App,Order Reference ID,Fulfillment Note,Free Processing Applied,Channel,Unattributed Tips,Table Info'.split(',');
const q = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
function sqRow(f, header = SQ_HEADER) {
  return header.map((h) => q(f[h] ?? (/(Sales|Discounts|Charges|Tax|Tip|Refunds|Collected|^Card$|^Cash$|Gift Card$|Other Tender$|^Fees$|Net Total)/.test(h) ? '$0.00' : ''))).join(',');
}
const sqFile = (rows, header = SQ_HEADER) => [header.join(','), ...rows.map((r) => sqRow(r, header))].join('\n') + '\n';
const card = (o) => ({ Date: '2024-08-01', Time: '10:00:00', 'Event Type': 'Payment', 'Transaction Status': 'Complete', 'Transaction ID': 'T' + Math.random().toString(36).slice(2, 8), ...o });

describe('detection never misfires across sources', () => {
  for (const c of CASES) {
    test(`${c.file}: only ${c.source} claims it with a top score`, () => {
      const rows = parseCSV(readFixture(c.file).slice(0, 200000), { maxRows: 60 });
      const scores = Object.fromEntries(Object.entries(DETECTORS).map(([id, d]) => [id, (d(rows) || {}).score || 0]));
      for (const id of NEW) if (id !== c.source) assert.equal(scores[id], 0, `${id} detector fired on ${c.file}`);
      if (NEW.has(c.source)) {
        for (const [id, s] of Object.entries(scores)) if (id !== c.source) assert.ok(s < scores[c.source], `${id} scored ${s} on ${c.file}`);
      }
      assert.equal(detectSource(readFixture(c.file)).sourceId, c.source);
    });
  }
  test('each new parser refuses the other sources\' fixtures', () => {
    for (const c of CASES) for (const id of NEW) if (id !== c.source) assert.throws(() => parse(id, readFixture(c.file), c.options), isEngineError('WRONG_SOURCE'), `${id} accepted ${c.file}`);
  });
});

describe('Square', () => {
  const r = parse('square', readFixture('square-transactions.csv'));
  test('cash sale left out, mixed tender keeps only the card part, zero row left out', () => {
    assert.ok(!r.transactions.some((t) => t.id === 'PAYSQ0002'));
    const lamp = r.transactions.find((t) => t.id === 'PAYSQ0003');
    assert.deepEqual([lamp.gross, lamp.fee, lamp.amount], [30, 0.8, 29.2]);
    assert.ok(r.warnings.some((w) => /Cash payments left out: 35\.00\. Cash never reaches a Square deposit/.test(w)));
    assert.ok(r.warnings.some((w) => /keeps only its card part/.test(w)));
    assert.equal(r.meta.rowsSkipped, 2);
  });
  test('refund is a sale-side refund with a negative amount; fees split so gross - fee = net', () => {
    const ref = r.transactions.find((t) => t.id === 'PAYSQ0004');
    assert.deepEqual([ref.type, ref.refundSide, ref.amount], ['refund', 'sale', -35]);
    const big = r.transactions.find((t) => t.id === 'PAYSQ0005');
    assert.deepEqual([big.gross, big.fee, big.amount], [1234.56, 32.72, 1201.84]);
  });
  test('deposit id groups rows into payouts; undeposited rows go to clearing; journal balances to the cent', () => {
    const rows = summarizePayouts(r.transactions, { groupBy: 'payout' });
    const dep1 = rows.find((x) => x.key === 'DEPSQ1');
    assert.equal(cents(dep1.payoutAmount), 3000 - 3500 - 80);
    assert.equal(dep1.date, '2024-08-24');
    const out = write('qbo-journal', r.transactions, { sourceId: 'square' });
    const v = checkJournal(out.content);
    assert.deepEqual(v.errors, []);
    assert.match(out.content, /Square payout DEPSQ0/);
  });
  test('tax collected is reported, not hidden', () => {
    assert.ok(r.warnings.some((w) => /0\.95 of sales tax/.test(w)));
  });
  test('formula text is guarded in Xero CSV and stripped of = in QuickBooks CSV', () => {
    const x = write('xero-csv', r.transactions, {});
    assert.ok(strictParse(x.content).slice(1).every((row) => row.every((c) => !/^[=+@]/.test(c) && !/^-[^\d]/.test(c))));
    assert.ok(!/(^|,)"?=/m.test(write('qbo-csv-3', r.transactions, {}).content));
  });
  test('Excel re-saved file: ($20.00), M/D/YYYY dates, trailing spaces, BOM', () => {
    const text = '﻿' + sqFile([
      card({ Date: '12/11/2025', 'Gross Sales': '$20.00 ', 'Total Collected': '$20.00 ', Card: '$20.00 ', Fees: '($0.58)', 'Net Total': '$19.42 ', 'Payment ID': 'P1' }),
      card({ Date: '12/13/2025', 'Gross Sales': '($20.00)', 'Total Collected': '($20.00)', Card: '($20.00)', 'Net Total': '($20.00)', 'Event Type': 'Refund', 'Payment ID': 'P2' }),
    ]);
    const p = parse('auto', text);
    assert.equal(p.meta.sourceId, 'square');
    assert.deepEqual(p.transactions.map((t) => [t.date, cents(t.amount)]), [['2025-12-11', 1942], ['2025-12-13', -2000]]);
  });
  test('rows not Complete are left out; pounds give GBP; dollars warn about the assumed currency', () => {
    const p = parse('square', sqFile([card({ 'Total Collected': '£10.00', Card: '£10.00', 'Net Total': '£10.00' }), card({ 'Transaction Status': 'Pending', 'Total Collected': '£5.00', Card: '£5.00', 'Net Total': '£5.00' })]));
    assert.equal(p.transactions.length, 1);
    assert.equal(p.transactions[0].currency, 'GBP');
    assert.ok(p.warnings.some((w) => /not Complete/.test(w)));
    assert.ok(r.warnings.some((w) => /treated as US dollars/.test(w)));
  });
  test('Total Collected + Fees that disagree with Net Total: Net Total wins, with a warning', () => {
    const p = parse('square', sqFile([card({ 'Total Collected': '$10.00', Card: '$10.00', Fees: '-$1.00', 'Net Total': '$8.50' })]));
    assert.equal(cents(p.transactions[0].amount), 850);
    assert.ok(p.warnings.some((w) => /do not add up/.test(w)));
  });
  test('identical-looking rows stay separate with distinct FITIDs', () => {
    const row = card({ 'Total Collected': '$5.00', Card: '$5.00', 'Net Total': '$5.00', 'Transaction ID': 'SAME', 'Payment ID': '' });
    const p = parse('square', sqFile([row, row]));
    assert.equal(p.transactions.length, 2);
    const v = validateOfx(write('qbo', p.transactions, {}).content, { intuBid: '3000', sumCents: 1000, currency: 'USD', kind: 'bank' });
    assert.deepEqual(v.errors, []);
    assert.equal(new Set(v.stmttrns.map((s) => s.FITID || s.fitid)).size, 2);
  });
  test('older 2020 layout (44 columns, no Transaction Status or Cash App) still parses', () => {
    const old = SQ_HEADER.filter((h) => !['Service Charges', 'Third Party Fees', 'Transaction Status', 'Cash App', 'Order Reference ID', 'Fulfillment Note', 'Free Processing Applied', 'Channel', 'Unattributed Tips', 'Table Info'].includes(h));
    const p = parse('auto', sqFile([card({ 'Total Collected': '$7.00', Card: '$7.00', 'Net Total': '$7.00' })], old));
    assert.equal(p.meta.sourceId, 'square');
    assert.equal(cents(p.transactions[0].amount), 700);
  });
});

describe('Shopify Payments transactions', () => {
  const r = parse('shopify-transactions', readFixture('shopify-transactions.csv'));
  test('store-local date is kept even near midnight with an offset', () => {
    assert.ok(r.transactions.some((t) => t.date === '2023-10-13' && cents(t.amount) === -1200));
  });
  test('pending rows have no payout id; paid rows are grouped by payout date and currency', () => {
    const pend = r.transactions.find((t) => cents(t.amount) === 252916);
    assert.equal(pend.payoutId, undefined);
    const rows = summarizePayouts(r.transactions, { groupBy: 'payout' });
    const nov = rows.find((x) => x.key === 'shopify-2023-11-01-CZK');
    assert.equal(cents(nov.payoutAmount), 95950 - 73851 - 1200);
    assert.deepEqual(checkJournal(write('qbo-journal', r.transactions, { sourceId: 'shopify-transactions' }).content).errors, []);
  });
  test('charge: gross - fee = net; refund is sale side', () => {
    const ch = r.transactions.find((t) => cents(t.amount) === 95950);
    assert.deepEqual([ch.gross, ch.fee, ch.type], [1000, 40.5, 'payment']);
    const rf = r.transactions.find((t) => t.type === 'refund');
    assert.equal(rf.refundSide, 'sale');
  });
  const H = 'Transaction Date,Type,Order,Card Brand,Card Source,Payout Status,Payout Date,Payout ID,Available On,Amount,Fee,Net';
  test('Payout ID column is used when present; unknown types warn; mismatched fee is not split; no Currency column warns', () => {
    const text = [H,
      '2026-01-02 10:00:00 -0500,charge,"#1,001",visa,online,paid,2026-01-05,P-77,2026-01-04,100.00,3.20,96.80',
      '2026-01-02 11:00:00 -0500,mystery_type,,,,paid,2026-01-05,P-77,2026-01-04,-1.00,0.00,-1.00',
      '2026-01-03 11:00:00 -0500,charge,#1002,visa,online,paid,2026-01-05,P-77,2026-01-04,50.00,-1.50,48.50'].join('\n');
    const p = parse('auto', text);
    assert.equal(p.meta.sourceId, 'shopify-transactions');
    assert.ok(p.transactions.every((t) => t.payoutId === 'P-77'));
    assert.ok(p.warnings.some((w) => /do not recognise/.test(w)));
    assert.ok(p.warnings.some((w) => /Amount minus Fee different from Net/.test(w)));
    assert.ok(p.warnings.some((w) => /no Currency column/.test(w)));
    assert.equal(p.transactions.find((t) => cents(t.amount) === 4850).gross, undefined);
    assert.equal(centsOf(p.transactions), 9680 - 100 + 4850);
  });
  test('two identical charges are both kept (no row-unique id in this export)', () => {
    const line = '2026-01-02 10:00:00 -0500,charge,#9,visa,online,paid,2026-01-05,,2026-01-04,10.00,0.50,9.50';
    const p = parse('shopify-transactions', [H, line, line].join('\n'));
    assert.equal(p.transactions.length, 2);
  });
  test('re-saved spreadsheet dates: evidence decides, ambiguous ones are marked as assumed', () => {
    const p = parse('shopify-transactions', [H, '10/13/2023 23:59,charge,#1,visa,online,paid,10/16/2023,,10/14/2023,5.00,0.20,4.80'].join('\n'), { dateOrder: 'dmy' });
    assert.equal(p.transactions[0].date, '2023-10-13');
    assert.equal(p.transactions[0].payoutDate, '2023-10-16');
    const amb = parse('shopify-transactions', [H, '3/4/2023 10:00,charge,#1,visa,online,paid,3/5/2023,,3/5/2023,5.00,0.20,4.80'].join('\n'), {});
    assert.equal(amb.transactions[0].date, '2023-03-04');
    assert.ok(amb.warnings.some((w) => /month\/day/.test(w)));
  });
  test('the payouts file is refused with a pointer to the right source', () => {
    assert.throws(() => parse('shopify-transactions', readFixture('shopify-payouts.csv')), (e) => isEngineError('WRONG_SOURCE')(e) && /payouts export/.test(e.message));
  });
});

describe('Shopify Payments payouts', () => {
  const r = parse('shopify-payouts', readFixture('shopify-payouts.csv'));
  test('every paid payout nets to zero and the deposit equals Total; failed payout activity stays in clearing', () => {
    const rows = summarizePayouts(r.transactions, { groupBy: 'payout' });
    assert.deepEqual(rows.map((x) => [x.key, cents(x.payoutAmount), cents(x.difference)]), [
      ['shopify-payout-2022-11-20-USD', 116490, 0], ['(not yet paid out)', 0, -17954], ['shopify-payout-2023-04-27-USD', 8205, 0], ['shopify-payout-2023-05-30-USD', 4351, 0]]);
    assert.ok(r.warnings.some((w) => /payout\(s\) failed/.test(w)));
    const j = checkJournal(write('qbo-journal', r.transactions, { sourceId: 'shopify-payouts' }).content);
    assert.deepEqual(j.errors, []);
    assert.equal(j.entries.size, 4);
  });
  const H = 'Payout Date,Status,Charges,Refunds,Adjustments,Reserved Funds,Fees,Retried Amount,Total,Currency';
  test('negative fee variant is read by the sign that adds up; rows that do not add up are left out; same-day payouts stay apart', () => {
    const p = parse('auto', [H, '2026-02-01,paid,100.00,-0.00,0.00,0.00,-3.00,0.00,97.00,EUR', '2026-02-01,paid,10.00,0.00,0.00,0.00,1.00,0.00,9.00,EUR', '2026-02-02,paid,10.00,0.00,0.00,0.00,1.00,0.00,50.00,EUR'].join('\n'));
    assert.equal(p.meta.sourceId, 'shopify-payouts');
    const rows = summarizePayouts(p.transactions, { groupBy: 'payout' });
    assert.deepEqual(rows.map((x) => cents(x.payoutAmount)).sort((a, b) => a - b), [900, 9700]);
    assert.ok(p.warnings.some((w) => /do not add up/.test(w)));
    assert.equal(p.transactions[0].currency, 'EUR');
  });
  test('the transactions file is refused with a pointer to the right source', () => {
    assert.throws(() => parse('shopify-payouts', readFixture('shopify-transactions.csv')), isEngineError('WRONG_SOURCE'));
  });
});

describe('Wise', () => {
  const r = parse('wise', readFixture('wise-statement.csv'));
  test('BOM handled, fee row counted once, running balance reconciles', () => {
    assert.equal(r.meta.reconciled, true);
    assert.equal(r.meta.openingBalance, 1000);
    assert.equal(r.meta.closingBalance, 1996.17);
    assert.equal(r.transactions.filter((t) => t.type === 'fee').length, 1);
    assert.ok(!r.transactions.some((t) => t.fee !== undefined));
  });
  test('main row and fee row share an id but get different FITIDs; quoted comma in merchant', () => {
    const v = validateOfx(write('qbo', r.transactions, {}).content, { intuBid: '3000', sumCents: 99617, currency: 'USD', kind: 'bank' });
    assert.deepEqual(v.errors, []);
    assert.equal(v.stmttrns.length, 6);
    assert.ok(r.transactions.some((t) => t.counterparty === 'Coffee, Inc'));
  });
  test('oldest first after parsing; conversion is not a payment; card refund is a purchase-side refund', () => {
    assert.deepEqual(r.transactions.map((t) => t.date), [...r.transactions.map((t) => t.date)].sort());
    assert.equal(r.transactions.find((t) => t.id === 'BALANCE-300').type, 'other');
    assert.equal(r.transactions.find((t) => t.id === 'CARD-201').refundSide, 'purchase');
  });
  test('layout C (Date Time, Transaction Type) parses; a balance break warns', () => {
    const H = '"TransferWise ID",Date,"Date Time",Amount,Currency,Description,"Payment Reference","Running Balance","Exchange From","Exchange To","Exchange Rate","Payer Name","Payee Name","Payee Account Number",Merchant,"Card Last Four Digits","Card Holder Full Name",Attachment,Note,"Total fees","Exchange To Amount","Transaction Type","Transaction Details Type"';
    const text = [H,
      'TRANSFER-2,24-08-2020,"24-08-2020 13:43:54.496",-50.00,EUR,"Sent money to A",,900.00,,,,,A,,,,,,,0.00,,DEBIT,TRANSFER',
      'TRANSFER-1,23-08-2020,"23-08-2020 13:43:54.496",-50.00,EUR,"Sent money to B",,1000.00,,,,,B,,,,,,,0.00,,DEBIT,TRANSFER'].join('\n');
    const p = parse('auto', text);
    assert.equal(p.meta.sourceId, 'wise');
    assert.equal(p.transactions[0].currency, 'EUR');
    assert.equal(p.meta.reconciled, false);
    assert.ok(p.warnings.some((w) => /Running Balance column does not follow/.test(w)));
  });
  test('native DD-MM-YYYY dates stay day-first even when the browser locale says month/day (option never overrides the format)', () => {
    const p = parse('wise', readFixture('wise-statement.csv'), { dateOrder: 'mdy', decimal: '.' });
    assert.ok(p.transactions.some((t) => t.id === 'TRANSFER-101' && t.date === '2024-08-05'));
  });
  test('bank-feed targets validate', () => {
    assert.deepEqual(checkQboCsv(write('qbo-csv-3', r.transactions, {}).content).errors, []);
    assert.deepEqual(checkXeroCsv(write('xero-csv', r.transactions, {}).content).errors, []);
  });
});
