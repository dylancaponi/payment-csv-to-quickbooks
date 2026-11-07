// Amazon settlement report (Flat File V2). Expected values are worked out by
// hand from the fixture rows (see test-support/fixtures.js) and from the
// small files built inline below; formats are sourced in FORMATS.md.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse, write, convert, detectSource, summarizePayouts, EngineError } from '../index.js';
import { readFixture } from '../test-support/fixtures.js';
import { checkJournal } from '../test-support/csv-checks.js';
import { parseCSV } from '../src/csv.js';

const err = (code) => (e) => e instanceof EngineError && e.code === code;
const H = ['settlement-id', 'settlement-start-date', 'settlement-end-date', 'deposit-date', 'total-amount', 'currency', 'transaction-type', 'order-id', 'merchant-order-id', 'adjustment-id', 'shipment-id', 'marketplace-name', 'amount-type', 'amount-description', 'amount', 'fulfillment-id', 'posted-date', 'posted-date-time', 'order-item-code', 'merchant-order-item-id', 'merchant-adjustment-item-id', 'sku', 'quantity-purchased', 'promotion-id'];
const summary = (id, total, cur = 'USD', deposit = '2025-10-17 08:00:00 UTC') => [id, '2025-10-01 08:00:00 UTC', '2025-10-15 08:00:00 UTC', deposit, total, cur, ...Array(18).fill('')];
const line = (id, tt, at, desc, amt, extra = {}) => {
  const r = [id, '', '', '', '', '', tt, extra.order || '', '', '', '', extra.market || '', at, desc, amt, '', '2025-10-05', '2025-10-05 10:00:00 UTC', '', '', '', '', '', ''];
  if (extra.currency) r[5] = extra.currency;
  return r;
};
const file = (rows, header = H) => [header, ...rows].map((r) => r.join('\t')).join('\n') + '\n';

function journalTable(content) {
  const rows = parseCSV(content).slice(1);
  return rows.map((r) => ({ account: r[2], debit: r[3] ? Math.round(Number(r[3]) * 100) : 0, credit: r[4] ? Math.round(Number(r[4]) * 100) : 0, desc: r[5] }));
}
const bankDebit = (rows, bank = 'Checking') => rows.filter((r) => r.account === bank).reduce((s, r) => s + r.debit - r.credit, 0);

describe('Amazon settlement: US fixture', () => {
  const text = readFixture('amazon-settlement-us.txt');
  const p = parse('amazon-settlement', text);

  test('summary facts and deposit check', () => {
    assert.equal(p.meta.settlementId, '90000000001');
    assert.equal(p.meta.depositDate, '2025-10-17');
    assert.equal(p.meta.depositTotal, 35.58);
    assert.equal(p.meta.rowsTotal, 35.58);
    assert.equal(p.meta.reconciled, true);
    assert.ok(!p.warnings.some((w) => /does not add up/.test(w)));
  });

  test('every line is dated on the deposit date and carries the settlement id', () => {
    for (const t of p.transactions) {
      assert.equal(t.date, '2025-10-17');
      assert.equal(t.payoutId, '90000000001');
    }
  });

  test('named lines hold the hand-computed amounts', () => {
    const by = Object.fromEntries(p.transactions.filter((t) => t.journalLine).map((t) => [t.journalLine, t.amount]));
    assert.equal(by['Product sales'], 64.98);
    assert.equal(by['Shipping charged to buyers'], 9.99);
    assert.equal(by['Sales tax or VAT charged to buyers'], 4.12);
    assert.equal(by['Sales tax or VAT kept by Amazon (marketplace facilitator)'], -4.12);
    assert.equal(by['Amazon selling fees (referral, refund admin, holdback)'], -8.1);
    assert.equal(by['FBA fulfillment fees'], -7.5);
    assert.equal(by['Promotional rebates'], -2);
    assert.equal(by['Refunds: product sales'], -19.99);
    assert.equal(by['Advertising (Cost of Advertising)'], -12.34);
    assert.equal(by['FBA storage fees'], -3.21);
    assert.equal(by['FBA inventory reimbursements'], 8.75);
    assert.equal(by['Reserve released from the previous settlement'], 50);
    assert.equal(by['Reserve held back by Amazon'], -40);
    const payout = p.transactions.find((t) => t.type === 'payout');
    assert.equal(payout.amount, -35.58);
  });

  test('journal: balanced, bank line equals total-amount, separate named lines', () => {
    const out = write('qbo-journal', p.transactions, { sourceId: 'amazon-settlement' });
    checkJournal(out.content);
    const rows = journalTable(out.content);
    const dr = rows.reduce((s, r) => s + r.debit, 0);
    const cr = rows.reduce((s, r) => s + r.credit, 0);
    assert.equal(dr, cr);
    assert.equal(bankDebit(rows), 3558);
    // Reserve goes to the clearing account, never income or expense.
    const reserve = rows.filter((r) => /Reserve/.test(r.desc));
    assert.equal(reserve.length, 2);
    for (const r of reserve) assert.equal(r.account, 'Uncategorized Asset');
    // Facilitator tax: two opposite lines that net to zero.
    const tax = rows.filter((r) => /Sales tax or VAT/.test(r.desc));
    assert.equal(tax.length, 2);
    assert.equal(tax.reduce((s, r) => s + r.credit - r.debit, 0), 0);
    assert.ok(rows.some((r) => /^Advertising/.test(r.desc)));
    assert.ok(rows.some((r) => /^FBA fulfillment fees/.test(r.desc)));
    assert.ok(!rows.some((r) => /^Fees -/.test(r.desc)), 'no unnamed fee line left over');
  });

  test('journal accounts for advertising, FBA fees and reserve can be set', () => {
    const out = write('qbo-journal', p.transactions, { sourceId: 'amazon-settlement', accounts: { advertising: 'Advertising', fulfillmentFees: 'FBA Fees', reserve: 'Amazon Reserve', fees: 'Amazon Fees' } });
    const rows = journalTable(out.content);
    assert.equal(rows.find((r) => /^Advertising/.test(r.desc)).account, 'Advertising');
    assert.equal(rows.find((r) => /^FBA fulfillment/.test(r.desc)).account, 'FBA Fees');
    assert.equal(rows.find((r) => /^FBA storage/.test(r.desc)).account, 'FBA Fees');
    assert.equal(rows.find((r) => /^Reserve held/.test(r.desc)).account, 'Amazon Reserve');
    assert.equal(rows.find((r) => /^Amazon selling fees/.test(r.desc)).account, 'Amazon Fees');
    assert.equal(rows.reduce((s, r) => s + r.debit - r.credit, 0), 0);
  });

  test('summarizePayouts gives one settlement whose payout is the deposit', () => {
    const rows = summarizePayouts(p.transactions, { groupBy: 'payout' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payoutAmount, 35.58);
    assert.equal(rows[0].difference, 0);
    assert.ok(Array.isArray(rows[0].details));
  });

  test('bank files: the Amazon balance nets to zero for the settlement', () => {
    for (const target of ['qbo-csv-3', 'xero-csv', 'qbo']) {
      const out = write(target, p.transactions, { sourceId: 'amazon-settlement' });
      assert.ok(out.content.length > 0);
    }
    assert.equal(p.transactions.reduce((s, t) => s + Math.round(t.amount * 100), 0), 0);
  });
});

describe('Amazon settlement: DE fixture (decimal comma, day-first dates)', () => {
  const p = parse('auto', readFixture('amazon-settlement-de.txt'));
  test('reads 25,95 EUR deposited 29.10.2025', () => {
    assert.equal(p.meta.sourceId, 'amazon-settlement');
    assert.equal(p.meta.currency, 'EUR');
    assert.equal(p.meta.depositDate, '2025-10-29');
    assert.equal(p.meta.depositTotal, 25.95);
    assert.equal(p.meta.reconciled, true);
  });
  test('VAT not kept by Amazon is named in a warning', () => {
    assert.ok(p.warnings.some((w) => /5\.70 of sales tax or VAT/.test(w)));
  });
  test('journal bank line is the deposit', () => {
    const rows = journalTable(write('qbo-journal', p.transactions, { sourceId: 'amazon-settlement' }).content);
    assert.equal(bankDebit(rows), 2595);
  });
});

describe('Amazon settlement: money safety', () => {
  test('rows that do not add up to total-amount give a loud warning; deposit stays total-amount', () => {
    const t = file([summary('1', '20.00'), line('1', 'Order', 'ItemPrice', 'Principal', '30.00'), line('1', 'Order', 'ItemFees', 'Commission', '-4.50')]);
    const p = parse('amazon-settlement', t);
    const w = p.warnings.find((x) => /^WARNING: Amazon settlement 1 does not add up/.test(x));
    assert.ok(w, p.warnings.join('\n'));
    assert.match(w, /rows total 25\.50 USD/);
    assert.match(w, /total-amount \(the deposit\) is 20\.00/);
    assert.match(w, /difference 5\.50/);
    assert.equal(p.meta.reconciled, false);
    const out = write('qbo-journal', p.transactions, { sourceId: 'amazon-settlement' });
    const rows = journalTable(out.content);
    assert.equal(bankDebit(rows), 2000);
    assert.ok(rows.some((r) => r.account === 'Uncategorized Asset' && r.debit === 550));
    assert.ok(out.warnings.some((x) => /do not equal the activity/.test(x)));
  });

  test('a zero total with rows that do not add up still shows the gap', () => {
    const p = parse('amazon-settlement', file([summary('2', '0.00'), line('2', 'Order', 'ItemPrice', 'Principal', '10.00')]));
    assert.ok(p.warnings.some((x) => /does not add up/.test(x)));
    const rows = journalTable(write('qbo-journal', p.transactions, { sourceId: 'amazon-settlement' }).content);
    assert.equal(bankDebit(rows), 0);
    assert.ok(rows.some((r) => r.account === 'Uncategorized Asset' && r.debit === 1000));
  });

  test('a zero total that adds up writes no deposit line', () => {
    const p = parse('amazon-settlement', file([summary('3', '0,00', 'EUR', '24.11.2024 08:59:52 UTC'), line('3', 'Order', 'ItemPrice', 'Principal', '22,80'), line('3', 'other-transaction', 'other-transaction', 'Current Reserve Amount', '-22,80')]));
    assert.equal(p.meta.reconciled, true);
    assert.ok(!p.transactions.some((t) => t.type === 'payout'));
    const rows = journalTable(write('qbo-journal', p.transactions, { sourceId: 'amazon-settlement' }).content);
    assert.equal(bankDebit(rows), 0);
  });

  test('unknown amount kinds are kept on named lines and listed in a warning', () => {
    const p = parse('amazon-settlement', file([summary('4', '7.00'), line('4', 'Order', 'ItemPrice', 'Principal', '10.00'), line('4', 'other-transaction', 'other-transaction', 'Subscription Fee', '-3.00')]));
    const t = p.transactions.find((x) => /Subscription Fee/.test(x.description));
    assert.ok(t);
    assert.equal(t.amount, -3);
    assert.ok(p.warnings.some((w) => /does not recognise yet: other-transaction \/ other-transaction \/ Subscription Fee \(1 row\(s\), -3\.00\)/.test(w)), p.warnings.join('\n'));
    const rows = journalTable(write('qbo-journal', p.transactions, { sourceId: 'amazon-settlement' }).content);
    assert.ok(rows.some((r) => r.account === 'Uncategorized Expense' && r.debit === 300 && /Subscription Fee/.test(r.desc)));
    assert.equal(bankDebit(rows), 700);
  });

  test('an unreadable amount is warned about and the total check catches it', () => {
    const p = parse('amazon-settlement', file([summary('5', '10.00'), line('5', 'Order', 'ItemPrice', 'Principal', '10.00'), line('5', 'Order', 'ItemFees', 'Commission', 'abc')]));
    assert.ok(p.warnings.some((w) => /amount we cannot read \("abc"\)/.test(w)));
    assert.equal(p.meta.rowsSkipped, 1);
  });

  test('several settlements: one per output, chooser, others named', () => {
    const t = file([summary('11', '5.00'), line('11', 'Order', 'ItemPrice', 'Principal', '5.00'), summary('12', '8.00'), line('12', 'Order', 'ItemPrice', 'Principal', '8.00')]);
    const a = parse('amazon-settlement', t);
    assert.equal(a.meta.settlementId, '11');
    assert.deepEqual(a.meta.accounts.map((x) => x.account), ['11', '12']);
    assert.ok(a.warnings.some((w) => /holds 2 Amazon settlements \(11, 12\)\. Only settlement 11 is converted/.test(w)));
    assert.ok(a.transactions.every((x) => x.payoutId === '11'));
    const b = parse('amazon-settlement', t, { account: '12 USD' });
    assert.equal(b.meta.settlementId, '12');
    assert.equal(b.meta.depositTotal, 8);
    assert.throws(() => parse('amazon-settlement', t, { account: '99' }), err('BAD_OPTION'));
  });

  test('the same settlement pasted twice is refused', () => {
    const one = [summary('21', '5.00'), line('21', 'Order', 'ItemPrice', 'Principal', '5.00')];
    assert.throws(() => parse('amazon-settlement', file([...one, ...one])), (e) => err('BAD_FILE')(e) && /appears 2 times/.test(e.message));
    // With the header repeated too (two downloads joined).
    const joined = file(one) + file(one);
    assert.throws(() => parse('amazon-settlement', joined), err('BAD_FILE'));
  });

  test('a settlement with no summary row is refused', () => {
    assert.throws(() => parse('amazon-settlement', file([line('31', 'Order', 'ItemPrice', 'Principal', '5.00')])), (e) => err('BAD_FILE')(e) && /no summary row/.test(e.message));
  });

  test('rows without a settlement id are warned about', () => {
    const p = parse('amazon-settlement', file([summary('41', '5.00'), line('41', 'Order', 'ItemPrice', 'Principal', '5.00'), line('', 'Order', 'ItemPrice', 'Principal', '3.00')]));
    assert.ok(p.warnings.some((w) => /^WARNING: 1 row\(s\) in this Amazon file have no settlement-id/.test(w)));
  });

  test('a row in another currency is refused', () => {
    assert.throws(() => parse('amazon-settlement', file([summary('51', '5.00'), line('51', 'Order', 'ItemPrice', 'Principal', '5.00', { currency: 'CAD' })])), (e) => err('BAD_FILE')(e) && /mixed-currency/.test(e.message));
  });

  test('a negative total is a charge, booked out of the bank with a note', () => {
    const p = parse('amazon-settlement', file([summary('61', '-14.10'), line('61', 'other-transaction', 'other-transaction', 'Storage Fee', '-14.10')]));
    assert.ok(p.warnings.some((w) => /negative total \(-14\.10\)/.test(w)));
    const rows = journalTable(write('qbo-journal', p.transactions, { sourceId: 'amazon-settlement' }).content);
    assert.equal(bankDebit(rows), -1410);
  });

  test('an unreadable deposit date is refused with the value', () => {
    assert.throws(() => parse('amazon-settlement', file([summary('71', '5.00', 'USD', '10/17/2025'), line('71', 'Order', 'ItemPrice', 'Principal', '5.00')])), (e) => err('BAD_FILE')(e) && /10\/17\/2025/.test(e.message));
  });

  test('older 23-column files without promotion-id are read', () => {
    const h = H.slice(0, 23);
    const t = file([summary('81', '5.00').slice(0, 23), line('81', 'Order', 'ItemPrice', 'Principal', '5.00').slice(0, 23)], h);
    assert.equal(parse('auto', t).meta.depositTotal, 5);
  });

  test('negative principal on an order is a sales correction, never a payment sent', () => {
    const p = parse('amazon-settlement', file([summary('91', '-1.00'), line('91', 'Order', 'ItemPrice', 'Principal', '-1.00')]));
    const out = write('qbo-journal', p.transactions, { sourceId: 'amazon-settlement' });
    assert.ok(!/Payments sent/.test(out.content));
  });
});

describe('Amazon: wrong files', () => {
  const dateRange = [
    '"Includes Amazon Marketplace, Fulfillment by Amazon (FBA), and Amazon Webstore transactions"',
    '"All amounts in USD, unless specified"',
    '"date/time","settlement id","type","order id","sku","description","quantity","marketplace","fulfillment","order city","order state","order postal","tax collection model","product sales","product sales tax","shipping credits","shipping credits tax","gift wrap credits","giftwrap credits tax","Regulatory Fee","Tax On Regulatory Fee","promotional rebates","promotional rebates tax","marketplace withheld tax","selling fees","fba fees","other transaction fees","other","total"',
    '"Oct 3, 2025 2:02:11 PM PDT","90000000001","Order","111-0000001-0000001","SKU-MUG-01","Synthetic mug","2","amazon.com","Amazon","Springfield","IL","62701","MarketplaceFacilitator","39.98","3.30","5.00","0","0","0","0","0","-2.00","0","-3.30","-6.00","-7.50","-5.00","0","24.48"',
  ].join('\n');
  test('the Date Range Transaction report is refused by name', () => {
    const d = detectSource(dateRange);
    assert.equal(d.sourceId, null);
    assert.match(d.reason, /Date Range "Transaction" report/);
    assert.throws(() => parse('amazon-settlement', dateRange), (e) => err('WRONG_SOURCE')(e) && /Flat File V2/.test(e.message));
    assert.throws(() => parse('generic-bank', dateRange), err('WRONG_SOURCE'));
  });
  test('another CSV is not taken for Amazon', () => {
    assert.throws(() => parse('amazon-settlement', readFixture('etsy-deposits.csv')), err('WRONG_SOURCE'));
  });
});

describe('journalLine / journalAccount validation', () => {
  const base = { date: '2025-01-01', amount: 5, currency: 'USD', type: 'fee', payoutId: 'x' };
  test('bad journalAccount is refused', () => {
    assert.throws(() => write('qbo-journal', [{ ...base, journalLine: 'X', journalAccount: 'bank' }]), err('BAD_TXN'));
    assert.throws(() => write('qbo-journal', [{ ...base, journalLine: 5 }]), err('BAD_TXN'));
  });
  test('convert passes the settlement through in one call', () => {
    const out = convert('auto', readFixture('amazon-settlement-us.txt'), 'qbo-journal');
    assert.equal(bankDebit(journalTable(out.content)), 3558);
  });
});

describe('Amazon review round 1 fixes', () => {
  test('finding 1: Promotion / TaxDiscount goes to the tax line (real UK pattern)', () => {
    // Order 206-5063377-4645141 in the real UK file 18.10.2024: free delivery cancels shipping and its VAT.
    const o = { order: '206-5063377-4645141', market: 'Amazon.co.uk' };
    const t = file([summary('101', '56.00', 'GBP', '20.10.2024 08:59:45 UTC'),
      line('101', 'Order', 'ItemPrice', 'Principal', '280.00', o), line('101', 'Order', 'ItemPrice', 'Tax', '56.00', o),
      line('101', 'Order', 'ItemPrice', 'Shipping', '1.66', o), line('101', 'Order', 'ItemPrice', 'ShippingTax', '0.33', o),
      line('101', 'Order', 'Promotion', 'Shipping', '-1.66', o), line('101', 'Order', 'Promotion', 'TaxDiscount', '-0.33', o),
      line('101', 'Order', 'ItemFees', 'Commission', '-280.00', o)]);
    const p = parse('amazon-settlement', t);
    const by = Object.fromEntries(p.transactions.filter((x) => x.journalLine).map((x) => [x.journalLine, x.amount]));
    assert.equal(by['Sales tax or VAT charged to buyers'], 56);
    assert.equal(by['Promotional rebates'], -1.66);
    assert.ok(p.warnings.some((w) => /56\.00 of sales tax or VAT/.test(w)));
  });

  test('finding 3: the V1 flat file is refused by name in detection and parse', () => {
    const v1 = ['settlement-id', 'settlement-start-date', 'settlement-end-date', 'deposit-date', 'total-amount', 'currency', 'transaction-type', 'order-id', 'merchant-order-id', 'adjustment-id', 'shipment-id', 'marketplace-name', 'shipment-fee-type', 'shipment-fee-amount', 'order-fee-type', 'order-fee-amount', 'fulfillment-id', 'posted-date', 'order-item-code', 'merchant-order-item-id', 'merchant-adjustment-item-id', 'sku', 'quantity-purchased', 'price-type', 'price-amount', 'item-related-fee-type', 'item-related-fee-amount', 'misc-fee-amount', 'other-fee-amount', 'other-fee-reason-description', 'promotion-id', 'promotion-type', 'promotion-amount', 'direct-payment-type', 'direct-payment-amount', 'other-amount'];
    const text = [v1, ['123', '2024-10-01 00:00:00 UTC', '2024-10-15 00:00:00 UTC', '2024-10-17 00:00:00 UTC', '50.00', 'USD', ...Array(30).fill('')], ['123', '', '', '', '', '', 'Order', '111-1', '', '', '', 'Amazon.com', '', '', '', '', 'AFN', '2024-10-05', '', '', '', 'SKU', '1', 'Principal', '60.00', 'Commission', '-10.00', '', '', '', '', '', '', '', '', '']].map((r) => r.join('\t')).join('\n') + '\n';
    const d = detectSource(text);
    assert.equal(d.sourceId, null);
    assert.match(d.reason, /Amazon's older settlement report/);
    assert.match(d.reason, /Reports, then Payments, then All Statements/);
    assert.match(d.reason, /Download Flat File V2/);
    assert.throws(() => parse('amazon-settlement', text), (e) => err('WRONG_SOURCE')(e) && /older settlement report/.test(e.message));
    assert.throws(() => parse('auto', text), (e) => err('UNRECOGNIZED')(e) && /Flat File V2/.test(e.message));
  });

  test('finding 3: the generic unrecognised message names Amazon', () => {
    assert.match(detectSource("a,b\n1,2\n").reason, /Gumroad, Amazon or eBay/);
  });

  test('finding 5: every bank-style target tells you to use a separate Amazon clearing account', () => {
    const p = parse('amazon-settlement', readFixture('amazon-settlement-us.txt'));
    for (const target of ['qbo', 'qfx', 'ofx', 'qbo-csv-3', 'qbo-csv-4', 'xero-csv']) {
      const out = write(target, p.transactions, { sourceId: 'amazon-settlement' });
      assert.match(out.warnings[0], /^Import this file into a separate Amazon clearing account/, target);
      // Also without sourceId (API callers), recognised from the rows.
      assert.ok(write(target, p.transactions).warnings.some((w) => /separate Amazon clearing account/.test(w)), target);
    }
    assert.ok(!write('qbo-journal', p.transactions, { sourceId: 'amazon-settlement' }).warnings.some((w) => /separate Amazon clearing account/.test(w)));
    assert.ok(!write('qbo', parse('etsy', readFixture('etsy-deposits.csv')).transactions, { sourceId: 'etsy' }).warnings.some((w) => /Amazon/.test(w)));
    const reserve = p.warnings.find((w) => /reserve/.test(w));
    assert.match(reserve, /never income or expense: it stays in your Amazon clearing account/);
  });

  test('finding 6: export steps name Reports > Payments > All Statements > Download Flat File V2', async () => {
    const { SOURCES } = await import('../index.js');
    const s = SOURCES.find((x) => x.id === 'amazon-settlement');
    const steps = s.howToExport.join(' ');
    assert.match(steps, /Reports, then Payments, then All Statements/);
    assert.match(steps, /Download Flat File V2/);
    assert.ok(!/Reports Repository/.test(steps + s.quirks.join(' ')));
    assert.throws(() => parse('amazon-settlement', readFixture('etsy-deposits.csv')), (e) => /Reports, then Payments, then All Statements/.test(e.message));
  });

  test('finding 9: tax Amazon did not withhold goes to Sales Tax / VAT Payable, never income', () => {
    const p = parse('amazon-settlement', readFixture('amazon-settlement-de.txt'));
    const rows = journalTable(write('qbo-journal', p.transactions, { sourceId: 'amazon-settlement' }).content);
    const tax = rows.find((r) => /^Sales tax or VAT charged/.test(r.desc));
    assert.equal(tax.account, 'Sales Tax / VAT Payable');
    assert.equal(tax.credit, 570);
    assert.ok(p.warnings.some((w) => /"Sales Tax \/ VAT Payable" \(a liability, not income\)/.test(w)));
    // The caller's taxes account or taxesPayable account wins.
    const r2 = journalTable(write('qbo-journal', p.transactions, { sourceId: 'amazon-settlement', accounts: { taxes: 'VAT Control' } }).content);
    assert.equal(r2.find((r) => /^Sales tax or VAT charged/.test(r.desc)).account, 'VAT Control');
    const r3 = journalTable(write('qbo-journal', p.transactions, { sourceId: 'amazon-settlement', accounts: { taxesPayable: 'UStVA' } }).content);
    assert.equal(r3.find((r) => /^Sales tax or VAT charged/.test(r.desc)).account, 'UStVA');
  });

  test('finding 9: fully withheld facilitator tax stays on the taxes account and nets to zero', () => {
    const p = parse('amazon-settlement', readFixture('amazon-settlement-us.txt'));
    const rows = journalTable(write('qbo-journal', p.transactions, { sourceId: 'amazon-settlement' }).content);
    assert.ok(!rows.some((r) => r.account === 'Sales Tax / VAT Payable'));
    assert.ok(!p.warnings.some((w) => /was not kept back/.test(w)));
  });

  test('finding 2: a negative settlement is "Charged by Amazon", not "Deposit"', () => {
    const p = parse('amazon-settlement', file([summary('970', '-5.25'), line('970', 'other-transaction', 'other-transaction', 'Storage Fee', '-5.25')]));
    const rows = journalTable(write('qbo-journal', p.transactions, { sourceId: 'amazon-settlement' }).content);
    const bank = rows.find((r) => r.account === 'Checking');
    assert.equal(bank.credit, 525);
    assert.match(bank.desc, /^Charged by Amazon/);
  });
});
