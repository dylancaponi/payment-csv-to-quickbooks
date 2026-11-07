// eBay transaction report. Expected values are worked out by hand from the
// fixture rows (see test-support/fixtures.js) and from the small files built
// below; formats are sourced in FORMATS.md Appendix E.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse, write, convert, detectSource, EngineError } from '../index.js';
import { readFixture } from '../test-support/fixtures.js';
import { checkJournal } from '../test-support/csv-checks.js';
import { parseCSV } from '../src/csv.js';

const err = (code) => (e) => e instanceof EngineError && e.code === code;
const H = ['Transaction creation date', 'Type', 'Order number', 'Legacy order ID', 'Buyer username', 'Buyer name', 'Ship to city', 'Ship to province/region/state', 'Ship to zip', 'Ship to country', 'Net amount', 'Payout currency', 'Payout date', 'Payout ID', 'Payout method', 'Payout status', 'Reason for hold', 'Item ID', 'Transaction ID', 'Item title', 'Custom label', 'Quantity', 'Item subtotal', 'Shipping and handling', 'Seller collected tax', 'eBay collected tax', 'Final Value Fee - fixed', 'Final Value Fee - variable', 'Regulatory operating fee', 'Very high "item not as described" fee', 'Below standard performance fee', 'International fee', 'Charity donation', 'Deposit processing fee', 'Gross transaction amount', 'Transaction currency', 'Exchange rate', 'Reference ID', 'Description'];
const I = Object.fromEntries(H.map((h, i) => [h, i]));
const q = (x) => `"${String(x).replace(/"/g, '""')}"`;
const PRE = ['--,--,--,--,--,--,--,--,--,--,--,--,--', '"Notes"', '"Transaction report"', '"Seller","synthetic_seller"', '"Start date","Oct-01-2025 00:00:00 AM PDT"', '"End date","Oct-31-2025 23:59:59 PM PDT"'];
function row(f) { const r = Array(H.length).fill('--'); for (const [k, x] of Object.entries(f)) { assert.ok(k in I, k); r[I[k]] = x; } return r; }
const paid = (id, cur = 'USD', date = 'Oct 10, 2025') => ({ 'Payout currency': cur, 'Payout date': date, 'Payout ID': id, 'Payout status': 'Funds sent' });
const payoutRow = (id, net, cur = 'USD', date = 'Oct 10, 2025') => row({ 'Transaction creation date': date, Type: 'Payout', 'Net amount': net, 'Payout ID': id, 'Payout currency': cur, 'Gross transaction amount': net, 'Transaction currency': cur, Description: 'Scheduled payout.' });
const order = (id, net, gross, extra = {}) => row({ 'Transaction creation date': 'Oct 3, 2025', Type: 'Order', 'Order number': extra.order || '09-00000-00001', 'Net amount': net, 'Gross transaction amount': gross, 'Transaction currency': 'USD', ...paid(id), ...extra.cols });
const file = (rows, header = H, pre = PRE) => '﻿' + [...pre, header.map(q).join(','), ...rows.map((r) => r.map(q).join(','))].join('\n') + '\n';

function journalTable(content) {
  return parseCSV(content).slice(1).map((r) => ({ no: r[0], account: r[2], debit: r[3] ? Math.round(Number(r[3]) * 100) : 0, credit: r[4] ? Math.round(Number(r[4]) * 100) : 0, desc: r[5] }));
}
const bankBy = (rows) => { const m = {}; for (const r of rows) if (r.account === 'Checking') m[r.desc.replace(/^.* - eBay payout /, '')] = (m[r.desc.replace(/^.* - eBay payout /, '')] || 0) + r.debit - r.credit; return m; };

describe('eBay transaction report: US fixture', () => {
  const text = readFixture('ebay-transaction-report.csv');
  const p = parse('ebay', text);

  test('detects through the BOM and the notes above the header', () => {
    assert.equal(detectSource(text).sourceId, 'ebay');
  });

  test('two payouts, each checked against its Payout row', () => {
    assert.deepEqual(p.meta.payouts.map((x) => [x.payoutId, x.payout, x.reconciled]).sort(), [['6000000001', 81.23, true], ['6000000002', 1044.4, true]]);
    assert.equal(p.meta.reconciled, true);
    assert.ok(!p.warnings.some((w) => /does not add up/.test(w)));
  });

  test('multi-item order: fees from item rows, Net counted once', () => {
    const by = Object.fromEntries(p.transactions.filter((t) => t.payoutId === '6000000001' && t.journalLine).map((t) => [t.journalLine, t.amount]));
    assert.equal(by['Item sales'], 137.76); // 66 + 29.88 + 41.88
    assert.equal(by['Shipping charged to buyers'], 30.05); // 18.15 + 5.95 + 5.95
    assert.equal(by['eBay final value fees'], -13.88); // -0.4 -8.42 -0.4 -4.23 -4.23 +3.80
    assert.equal(by['eBay international fee'], -5.4);
    assert.equal(by['Refunds to buyers'], -30);
    assert.equal(by['Shipping labels bought on eBay'], -8.25);
    assert.equal(by['Promoted listings and ad fees'], -4.1);
    assert.equal(by['eBay Store subscription'], -4.95);
    assert.equal(by['Funds held by eBay (placed and released)'], -20);
  });

  test('rows with no payout yet are left out and counted', () => {
    assert.ok(p.warnings.some((w) => /^Left out 1 eBay row that is not part of a payout yet .* 25\.00 USD/.test(w)));
    assert.ok(!p.transactions.some((t) => !t.payoutId));
  });

  test('eBay collected tax is not booked and is named', () => {
    assert.ok(p.warnings.some((w) => /eBay collected and paid 109\.29/.test(w)));
    assert.ok(!p.transactions.some((t) => /tax/i.test(t.journalLine || '')));
  });

  test('journal: one balanced entry per payout, bank line = Payout row, named lines', () => {
    const out = write('qbo-journal', p.transactions, { sourceId: 'ebay' });
    checkJournal(out.content);
    const rows = journalTable(out.content);
    for (const no of new Set(rows.map((r) => r.no))) {
      const e = rows.filter((r) => r.no === no);
      assert.equal(e.reduce((s, r) => s + r.debit, 0), e.reduce((s, r) => s + r.credit, 0));
    }
    assert.deepEqual(bankBy(rows), { 6000000001: 8123, 6000000002: 104440 });
    assert.equal(rows.find((r) => /^Funds held/.test(r.desc)).account, 'Uncategorized Asset');
    const ads = write('qbo-journal', p.transactions, { sourceId: 'ebay', accounts: { advertising: 'Advertising', reserve: 'eBay Holds' } });
    const ar = journalTable(ads.content);
    assert.equal(ar.find((r) => /^Promoted/.test(r.desc)).account, 'Advertising');
    assert.equal(ar.find((r) => /^Funds held/.test(r.desc)).account, 'eBay Holds');
  });

  test('bank-style targets carry the eBay clearing account notice; the journal does not', () => {
    for (const t of ['qbo', 'qfx', 'ofx', 'qbo-csv-3', 'qbo-csv-4', 'xero-csv']) {
      assert.match(write(t, p.transactions, { sourceId: 'ebay' }).warnings[0], /^Import this file into a separate eBay clearing account/, t);
      assert.match(write(t, p.transactions).warnings[0], /separate eBay clearing account/, t);
    }
    assert.ok(!write('qbo-journal', p.transactions, { sourceId: 'ebay' }).warnings.some((w) => /clearing account \(a bank/.test(w)));
    assert.ok(!write('qbo', parse('amazon-settlement', readFixture('amazon-settlement-us.txt')).transactions).warnings.some((w) => /eBay/.test(w)));
  });

  test('convert in one call', () => {
    assert.deepEqual(bankBy(journalTable(convert('auto', text, 'qbo-journal').content)), { 6000000001: 8123, 6000000002: 104440 });
  });
});

describe('eBay: money safety', () => {
  test('a payout whose rows do not add up gives a loud WARNING and the gap goes to clearing', () => {
    const t = file([payoutRow('7001', '-50'), order('7001', '40', '45', { cols: { 'Final Value Fee - variable': '-5' } })]);
    const p = parse('ebay', t);
    const w = p.warnings.find((x) => /^WARNING: eBay payout 7001 does not add up/.test(x));
    assert.ok(w, p.warnings.join('\n'));
    assert.match(w, /total 40\.00 USD, but the Payout row says 50\.00 \(difference -10\.00\)/);
    const rows = journalTable(write('qbo-journal', p.transactions, { sourceId: 'ebay' }).content);
    assert.equal(bankBy(rows)[7001], 5000);
    assert.ok(rows.some((r) => r.account === 'Uncategorized Asset' && r.credit === 1000));
  });

  test('rows of a payout whose Payout row is not in the file: unchecked WARNING', () => {
    const p = parse('ebay', file([order('7002', '40', '45', { cols: { 'Final Value Fee - variable': '-5' } })]));
    assert.ok(p.warnings.some((w) => /^WARNING: 1 eBay payout has sales or fees in this file but no Payout row/.test(w)));
    assert.equal(p.transactions.find((t) => t.type === 'payout').amount, -40);
  });

  test('an order in another currency is booked at its Net only, never added across currencies', () => {
    const p = parse('ebay', file([payoutRow('7003', '-192.32', 'EUR'), row({ 'Transaction creation date': 'Oct 3, 2025', Type: 'Order', 'Order number': '09-1', 'Net amount': '192.32', 'Gross transaction amount': '259.9', 'Final Value Fee - fixed': '-0.4', 'Final Value Fee - variable': '-29.89', 'International fee': '-4.16', 'Transaction currency': 'USD', 'Exchange rate': '0.85305', ...paid('7003', 'EUR') })]));
    assert.equal(p.meta.currency, 'EUR');
    const fx = p.transactions.find((t) => /another currency/.test(t.journalLine || ''));
    assert.equal(fx.amount, 192.32);
    assert.ok(!p.transactions.some((t) => t.amount === 259.9 || t.amount === -29.89));
    assert.ok(p.warnings.some((w) => /1 eBay order or refund was in another currency/.test(w)));
    assert.ok(p.transactions.every((t) => t.currency === 'EUR'));
  });

  test('payouts in two currencies: one currency per output, the other named', () => {
    const p = parse('ebay', file([payoutRow('7004', '-10'), order('7004', '10', '10'), payoutRow('7005', '-8', 'GBP'), row({ 'Transaction creation date': 'Oct 3, 2025', Type: 'Order', 'Order number': '09-2', 'Net amount': '8', 'Gross transaction amount': '8', 'Transaction currency': 'GBP', ...paid('7005', 'GBP') })]));
    assert.deepEqual(p.meta.currencies, ['GBP', 'USD']);
    const out = write('qbo-journal', p.transactions, { sourceId: 'ebay', currency: 'GBP' });
    assert.ok(out.warnings.some((w) => /Left out 1 entr\(ies\) in other currencies/.test(w)));
    assert.deepEqual(bankBy(journalTable(out.content)), { 7005: 800 });
  });

  test('one payout listing two payout currencies is refused', () => {
    assert.throws(() => parse('ebay', file([payoutRow('7006', '-18'), order('7006', '10', '10'), row({ 'Transaction creation date': 'Oct 3, 2025', Type: 'Order', 'Order number': '09-3', 'Net amount': '8', 'Gross transaction amount': '8', 'Transaction currency': 'GBP', ...paid('7006', 'GBP') })])), (e) => err('BAD_FILE')(e) && /more than one payout currency/.test(e.message));
  });

  test('the same report pasted twice is refused', () => {
    const rows = [payoutRow('7007', '-10'), order('7007', '10', '10')];
    assert.throws(() => parse('ebay', file([...rows, ...rows])), (e) => err('BAD_FILE')(e) && /2 Payout rows/.test(e.message));
  });

  test('unknown types are kept on a named line and listed', () => {
    const p = parse('ebay', file([payoutRow('7008', '-7'), order('7008', '10', '10'), row({ 'Transaction creation date': 'Oct 4, 2025', Type: 'Adjustment', 'Net amount': '-3', 'Gross transaction amount': '-3', 'Transaction currency': 'USD', ...paid('7008') })]));
    assert.ok(p.warnings.some((w) => /type this converter does not recognise yet: Adjustment \(1 row, -3\.00 USD\)/.test(w)));
    const rows = journalTable(write('qbo-journal', p.transactions, { sourceId: 'ebay' }).content);
    assert.ok(rows.some((r) => r.account === 'Uncategorized Expense' && r.debit === 300 && /Adjustment/.test(r.desc)));
  });

  test('Net different from Gross plus fees: the difference is its own line with a warning', () => {
    const p = parse('ebay', file([payoutRow('7009', '-8'), order('7009', '8', '10', { cols: { 'Final Value Fee - variable': '-1', 'Charity donation': '-1' } })]));
    assert.ok(p.warnings.some((w) => /1 eBay order or refund has a Net amount that is not Gross plus the fee columns/.test(w)));
    assert.equal(p.transactions.find((t) => /^Other amounts on orders/.test(t.journalLine || '')).amount, -1);
  });

  test('seller collected tax inside gross goes to Sales Tax / VAT Payable', () => {
    const p = parse('ebay', file([payoutRow('7010', '-107'), order('7010', '107', '108', { cols: { 'Item subtotal': '100', 'Shipping and handling': '0', 'Seller collected tax': '8', 'Final Value Fee - variable': '-1' } })]));
    const rows = journalTable(write('qbo-journal', p.transactions, { sourceId: 'ebay' }).content);
    assert.equal(rows.find((r) => /^Sales tax or VAT you collected/.test(r.desc)).account, 'Sales Tax / VAT Payable');
    assert.equal(rows.find((r) => /^Item sales/.test(r.desc)).credit, 10000);
    assert.equal(bankBy(rows)[7010], 10700);
  });

  test('a Charge (money taken from your bank) is a transfer, never income', () => {
    const p = parse('ebay', file([payoutRow('7011', '0.00'), row({ 'Transaction creation date': 'Oct 4, 2025', Type: 'Refund', 'Order number': '09-4', 'Net amount': '-20', 'Gross transaction amount': '-20', 'Transaction currency': 'USD', ...paid('7011') }), row({ 'Transaction creation date': 'Oct 5, 2025', Type: 'Charge', 'Net amount': '20', 'Gross transaction amount': '20', 'Transaction currency': 'USD', Description: 'Charge for refund cost from Synthetic Bank ending in 0001', ...paid('7011') })]));
    const t = p.transactions.find((x) => x.type === 'transfer');
    assert.equal(t.amount, 20);
    const rows = journalTable(write('qbo-journal', p.transactions, { sourceId: 'ebay' }).content);
    assert.ok(!rows.some((r) => /Income/.test(r.account) && r.credit === 2000));
    assert.equal(rows.reduce((s, r) => s + r.debit - r.credit, 0), 0);
  });

  test('a negative payout is worded as a charge', () => {
    const p = parse('ebay', file([payoutRow('7012', '5'), row({ 'Transaction creation date': 'Oct 4, 2025', Type: 'Other fee', 'Net amount': '-5', 'Gross transaction amount': '-5', 'Transaction currency': 'USD', Description: 'Bold Listing Fee ', ...paid('7012') })]));
    assert.ok(p.warnings.some((w) => /1 eBay payout is negative/.test(w)));
    const rows = journalTable(write('qbo-journal', p.transactions, { sourceId: 'ebay' }).content);
    const bank = rows.find((r) => r.account === 'Checking');
    assert.equal(bank.credit, 500);
    assert.match(bank.desc, /^Charged by eBay/);
  });

  test('an unreadable Net amount is warned about and the check catches it', () => {
    const p = parse('ebay', file([payoutRow('7013', '-10'), order('7013', 'abc', '10')]));
    assert.ok(p.warnings.some((w) => /Net amount we cannot read \("abc"\)/.test(w)));
    assert.ok(p.warnings.some((w) => /does not add up/.test(w)));
  });

  test('UK-site layout (Post to, Postage and packaging, en dash fee names, 24 Sept 2026 dates) is read', () => {
    const uk = H.filter((x) => x !== 'Charity donation' && x !== 'Deposit processing fee').map((x) => x.replace('Ship to zip', 'Post to postcode').replace(/^Ship to/, 'Post to').replace('Shipping and handling', 'Postage and packaging').replace('Final Value Fee - ', 'Final value fee – ').replace('Very high "item not as described" fee', "Very high 'item not as described' fee"));
    const idx = Object.fromEntries(uk.map((x, i) => [x, i]));
    const r = (f) => { const a = Array(uk.length).fill('--'); for (const [k, x] of Object.entries(f)) a[idx[k]] = x; return a; };
    const p = parse('auto', file([
      r({ 'Transaction creation date': '24 Sept 2026', Type: 'Payout', 'Net amount': '-9', 'Payout ID': '7014', 'Payout currency': 'GBP', 'Gross transaction amount': '-9', 'Transaction currency': 'GBP' }),
      r({ 'Transaction creation date': '23 Sept 2026', Type: 'Order', 'Order number': '09-5', 'Net amount': '9', 'Payout ID': '7014', 'Payout currency': 'GBP', 'Payout date': '24 Sept 2026', 'Item subtotal': '8', 'Postage and packaging': '2', 'Final value fee – variable': '-1', 'Gross transaction amount': '10', 'Transaction currency': 'GBP' }),
    ], uk));
    assert.equal(p.meta.sourceId, 'ebay');
    assert.equal(p.transactions[0].date, '2026-09-24');
    const by = Object.fromEntries(p.transactions.filter((t) => t.journalLine).map((t) => [t.journalLine, t.amount]));
    assert.equal(by['Shipping charged to buyers'], 2);
    assert.equal(by['eBay final value fees'], -1);
  });
});

describe('eBay: wrong files refused by name', () => {
  test('German eBay.de report', () => {
    const de = ['--,--,--', '"Seller";"x"', '"Datum der Transaktionserstellung";"Typ";"Bestellnummer";"Betrag abzügl. Kosten"', '"23. Sept. 2026";"Bestellung";"09-6";"52,17"'].join('\n');
    const d = detectSource(de);
    assert.equal(d.sourceId, null);
    assert.match(d.reason, /German column names/);
    assert.match(d.reason, /Payments tab, select Reports/);
    assert.throws(() => parse('ebay', de), (e) => err('WRONG_SOURCE')(e) && /German/.test(e.message));
  });
  test('eBay payout report', () => {
    const pr = ['"Payout date","Payout ID","Status","Payout method","Amount","Currency","Payout type","Memo"', '"Jan 5, 2022","5123456789","Funds sent","Bank *1234","10.45","GBP","Scheduled payout","--"'].join('\n');
    const d = detectSource(pr);
    assert.equal(d.sourceId, null);
    assert.match(d.reason, /eBay payout report/);
    assert.match(d.reason, /Transaction report in the download section/);
    assert.throws(() => parse('ebay', pr), (e) => err('WRONG_SOURCE')(e) && /payout report/.test(e.message));
    assert.throws(() => parse('generic-bank', pr), err('WRONG_SOURCE'));
  });
  test('another CSV is not taken for eBay', () => {
    assert.throws(() => parse('ebay', readFixture('etsy-deposits.csv')), (e) => err('WRONG_SOURCE')(e) && /Seller Hub open the Payments tab/.test(e.message));
  });
});

describe('eBay review round 1 fixes', () => {
  const express = (id, net, desc) => row({ 'Transaction creation date': 'Oct 10, 2025', Type: 'Payout', 'Net amount': net, 'Payout ID': id, 'Payout currency': 'USD', 'Gross transaction amount': net, 'Transaction currency': 'USD', Description: desc });
  test('finding 1: express payout fee on its own line, bank line is the amount sent (real usav shape)', () => {
    const p = parse('ebay', file([express('7420714403', '-142.35', 'Scheduled express payout Express payout fee $2.0 deducted,$140.35 sent. Usually arrive within 30 min.'), order('7420714403', '142.35', '150', { cols: { 'Final Value Fee - variable': '-7.65' } })]));
    assert.equal(p.meta.payouts[0].reconciled, true);
    assert.equal(p.transactions.find((t) => t.journalLine === 'eBay express payout fee').amount, -2);
    assert.equal(p.transactions.find((t) => t.type === 'payout').amount, -140.35);
    assert.ok(p.warnings.some((w) => /1 eBay payout was an express payout/.test(w)));
    const rows = journalTable(write('qbo-journal', p.transactions, { sourceId: 'ebay' }).content);
    assert.equal(bankBy(rows)[7420714403], 14035);
    assert.ok(rows.some((r) => /^eBay express payout fee/.test(r.desc) && r.debit === 200));
    assert.ok(!rows.some((r) => r.account === 'Uncategorized Asset'));
  });
  test('finding 1: 33 express payouts in one report, every fee booked', () => {
    const rows = [];
    for (let i = 0; i < 33; i++) {
      const id = String(7420700000 + i);
      const pre = 10000 + i * 100;
      rows.push(express(id, `-${(pre / 100).toFixed(2)}`, `Scheduled express payout Express payout fee $2.0 deducted,$${((pre - 200) / 100).toFixed(2)} sent. Usually arrive within 30 min.`));
      rows.push(order(id, (pre / 100).toFixed(2), (pre / 100).toFixed(2), { order: `09-${i}` }));
    }
    const p = parse('ebay', file(rows));
    assert.equal(p.transactions.filter((t) => t.journalLine === 'eBay express payout fee').length, 33);
    assert.ok(p.warnings.some((w) => /33 eBay payouts were express payouts/.test(w)));
    const j = journalTable(write('qbo-journal', p.transactions, { sourceId: 'ebay' }).content);
    assert.equal(j.filter((r) => /^eBay express payout fee/.test(r.desc)).reduce((s, r) => s + r.debit, 0), 6600);
  });
  test('finding 1: a fee mentioned but unreadable is a WARNING naming the payout', () => {
    const p = parse('ebay', file([express('7015', '-50', 'Scheduled express payout Express payout fee deducted, amount sent'), order('7015', '50', '50')]));
    assert.ok(p.warnings.some((w) => /^WARNING: eBay payout 7015 says a fee was deducted/.test(w)));
  });
  test('finding 3: a file whose dates were all rewritten by a spreadsheet is refused once', () => {
    const r = order('7016', '10', '10'); r[I['Transaction creation date']] = '10/03/2025';
    const r2 = payoutRow('7016', '-10'); r2[I['Transaction creation date']] = '10/10/2025';
    assert.throws(() => parse('ebay', file([r2, r])), (e) => err('BAD_FILE')(e) && /saved again in a spreadsheet/.test(e.message));
  });
  test('spreadsheet output carries no clearing account notice (eBay and Amazon)', () => {
    const p = parse('ebay', readFixture('ebay-transaction-report.csv'));
    assert.ok(!write('spreadsheet-csv', p.transactions, { sourceId: 'ebay' }).warnings.some((w) => /clearing account \(a bank/.test(w)));
    const a = parse('amazon-settlement', readFixture('amazon-settlement-us.txt'));
    assert.ok(!write('spreadsheet-csv', a.transactions, { sourceId: 'amazon-settlement' }).warnings.some((w) => /clearing account \(a bank/.test(w)));
  });
});
