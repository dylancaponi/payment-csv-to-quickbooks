// Regression tests for round 1, one per finding id.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse, write, detectSource, summarizePayouts, EngineError } from '../index.js';
import { checkJournal, strictParse } from '../test-support/csv-checks.js';
import { readFixture } from '../test-support/fixtures.js';

const isEngineError = (code) => (e) => e instanceof EngineError && (!code || e.code === code) && e.message.length > 20;
const cents = (n) => Math.round(n * 100);
const journalRows = (content) => strictParse(content).slice(1).map((r) => ({ account: r[2], debit: r[3] ? cents(+r[3]) : 0, credit: r[4] ? cents(+r[4]) : 0, desc: r[5] }));
const sumAccount = (rows, account) => rows.filter((r) => r.account === account).reduce((s, r) => s + r.credit - r.debit, 0);

const SQ_H = 'Date,Time,Time Zone,Gross Sales,Net Sales,Gift Card Sales,Tax,Tip,Partial Refunds,Total Collected,Card,Cash,Square Gift Card,Other Tender,Fees,Net Total,Transaction ID,Payment ID,Description,Event Type,Deposit ID,Deposit Date,Transaction Status';
// Same shapes as
const SQ_TIP_GIFT = [SQ_H,
  '2024-08-24,15:20,Pacific,$40.00,$40.00,$0.00,$0.00,$8.00,$0.00,$48.00,$48.00,$0.00,$0.00,$0.00,-$1.30,$46.70,T1,P1,Dinner,Payment,D1,2024-08-25,Complete',
  '2024-08-24,16:20,Pacific,$0.00,$0.00,$50.00,$0.00,$0.00,$0.00,$50.00,$50.00,$0.00,$0.00,$0.00,-$1.45,$48.55,T2,P2,eGift Card,Payment,D1,2024-08-25,Complete',
  '2024-08-24,17:20,Pacific,$30.00,$30.00,$0.00,$0.00,$0.00,$0.00,$30.00,$0.00,$0.00,$30.00,$0.00,$0.00,$30.00,T3,P3,Lunch,Payment,,,Complete',
  '2024-08-24,18:20,Pacific,$12.00,$12.00,$0.00,$0.00,$0.00,$0.00,$12.00,$0.00,$12.00,$0.00,$0.00,$0.00,$12.00,T4,P4,Coffee,Payment,,,Complete',
].join('\n');

describe('N1 Square gift card redemptions are not new cash or income', () => {
  test('N1: the gift card warning says the money came in when the card was sold, and no warning tells the user to record it as cash', () => {
    const r = parse('square', SQ_TIP_GIFT);
    const gift = r.warnings.find((w) => /Square gift cards left out: 30\.00/.test(w));
    assert.ok(gift, r.warnings.join('\n'));
    assert.match(gift, /Do not record this as new cash or income/);
    assert.match(gift, /move that amount from your gift card liability account to sales/);
    assert.ok(!r.warnings.some((w) => /gift card/i.test(w) && /cash takings/.test(w)));
    assert.ok(r.warnings.some((w) => /Cash payments left out: 12\.00\. Cash never reaches a Square deposit; record it with your cash takings/.test(w)));
    assert.ok(!r.transactions.some((t) => t.id === 'P3' || t.id === 'P4'));
  });
});

describe('N2 Square tips and gift card sales are not booked as Sales', () => {
  test('N2: tips and gift card sales get their own journal lines; sales are only the sale; entries balance', () => {
    const r = parse('square', SQ_TIP_GIFT);
    const out = write('qbo-journal', r.transactions, { sourceId: 'square' });
    assert.deepEqual(checkJournal(out.content).errors, []);
    const rows = journalRows(out.content);
    assert.equal(sumAccount(rows, 'Sales of Product Income'), 4000);
    assert.equal(sumAccount(rows, 'Tips owed to staff'), 800);
    assert.equal(sumAccount(rows, 'Gift card liability'), 5000);
    assert.equal(-sumAccount(rows, 'Checking'), 4670 + 4855);
    assert.ok(out.warnings.some((w) => /"Tips owed to staff"/.test(w)));
    assert.ok(out.warnings.some((w) => /"Gift card liability"/.test(w)));
    assert.ok(r.warnings.some((w) => /8\.00 of tips and 50\.00 of gift card sales/.test(w)));
  });
  test('N2: the account names can be changed; bank files keep the full payment amounts', () => {
    const r = parse('square', SQ_TIP_GIFT);
    const rows = journalRows(write('qbo-journal', r.transactions, { sourceId: 'square', accounts: { tips: 'Tips payable', giftCards: 'Deferred revenue' } }).content);
    assert.equal(sumAccount(rows, 'Tips payable'), 800);
    assert.equal(sumAccount(rows, 'Deferred revenue'), 5000);
    assert.match(write('qbo-csv-3', r.transactions, {}).content, /46\.70/);
  });
});

const SP_H = 'Payout Date,Status,Charges,Refunds,Adjustments,Reserved Funds,Fees,Retried Amount,Total,Currency';
describe('N3 Shopify retried payouts are not income', () => {
  test('N3: a failed payout\'s sales and fees are booked; the retried amount comes out of clearing, never Uncategorized Income', () => {
    const text = [SP_H, '2024-03-02,paid,10.00,0.00,0.00,0.00,0.50,96.80,106.30,USD', '2024-03-01,failed,100.00,0.00,0.00,0.00,3.20,0.00,96.80,USD'].join('\n');
    const r = parse('shopify-payouts', text);
    const out = write('qbo-journal', r.transactions, { sourceId: 'shopify-payouts' });
    assert.deepEqual(checkJournal(out.content).errors, []);
    const rows = journalRows(out.content);
    assert.equal(sumAccount(rows, 'Uncategorized Income'), 0);
    assert.equal(sumAccount(rows, 'Sales of Product Income'), 11000);
    assert.equal(sumAccount(rows, 'Bank Charges & Fees'), -370);
    assert.equal(-sumAccount(rows, 'Checking'), 10630);
    assert.equal(sumAccount(rows, 'Uncategorized Asset'), 0);
    assert.ok(r.warnings.some((w) => /Retried Amount \(96\.80 on 2024-03-02\)/.test(w) && /not booked as income again/.test(w)));
    assert.ok(r.warnings.some((w) => /1 Shopify payout\(s\) failed/.test(w)));
  });
});

describe('N4 and N5 Wise has no journal target', () => {
  const r = parse('wise', readFixture('wise-statement.csv'));
  test('N4: conversions are never booked as expense, because the journal is refused for Wise with a plain error', () => {
    assert.throws(() => write('qbo-journal', r.transactions, { sourceId: 'wise' }), (e) => isEngineError('NOT_SUPPORTED')(e) && /Wise/.test(e.message) && /bank file instead/.test(e.message));
  });
  test('N5: incoming transfers are never booked as Gross sales: refused even when sourceId is not passed', () => {
    assert.throws(() => write('qbo-journal', r.transactions, {}), isEngineError('NOT_SUPPORTED'));
    for (const t of ['qbo', 'qfx', 'ofx', 'qbo-csv-3', 'qbo-csv-4', 'xero-csv']) assert.ok(write(t, r.transactions, {}).content.length > 0);
  });
});

const WISE_H = '"TransferWise ID",Date,Amount,Currency,Description,"Payment Reference","Running Balance","Exchange From","Exchange To","Exchange Rate","Payer Name","Payee Name","Payee Account Number",Merchant,"Card Last Four Digits","Card Holder Full Name",Attachment,Note,"Total fees"';
describe('N6 Wise blank currency', () => {
  test('N6: a blank currency takes the statement\'s own currency, with a warning', () => {
    const text = [WISE_H, 'TRANSFER-2,02-01-2025,-5.00,,"Sent money to A",,95.00,,,,,A,,,,,,,0.00', 'TRANSFER-1,01-01-2025,100.00,EUR,"Received money from B",,100.00,,,,B,,,,,,,,0.00'].join('\n');
    const r = parse('wise', text);
    assert.ok(r.transactions.every((t) => t.currency === 'EUR'));
    assert.ok(r.warnings.some((w) => /1 Wise row\(s\) have no currency; they are treated as EUR/.test(w)));
  });
  test('N6: no currency anywhere gives USD with a warning; a mixed-currency file warns', () => {
    const none = parse('wise', [WISE_H, 'TRANSFER-1,01-01-2025,100.00,,"Received money from B",,100.00,,,,B,,,,,,,,0.00'].join('\n'));
    assert.ok(none.warnings.some((w) => /treated as USD, because the file names no currency/.test(w)));
    const mixed = parse('wise', [WISE_H, 'TRANSFER-2,02-01-2025,-5.00,USD,"x",,95.00,,,,,A,,,,,,,0.00', 'TRANSFER-1,01-01-2025,100.00,EUR,"y",,100.00,,,,B,,,,,,,,0.00'].join('\n'));
    assert.ok(mixed.warnings.some((w) => /mixes currencies \(EUR, USD\)/.test(w)));
  });
});

describe('N7 Shopify payout fee credit', () => {
  test('N7: a negative Fees value that makes the row add up is booked as a fee credit, not dropped', () => {
    const r = parse('shopify-payouts', [SP_H, '2024-04-01,paid,10.00,0.00,0.00,0.00,-0.50,0.00,10.50,USD'].join('\n'));
    assert.equal(r.transactions.find((t) => t.type === 'fee').amount, 0.5);
    assert.equal(cents(summarizePayouts(r.transactions)[0].payoutAmount), 1050);
  });
  test('N7: a row that adds up neither way is left out with a warning naming both totals', () => {
    const r = parse('shopify-payouts', [SP_H, '2024-04-01,paid,10.00,0.00,0.00,0.00,1.00,0.00,50.00,USD', '2024-04-02,paid,5.00,0.00,0.00,0.00,0.00,0.00,5.00,USD'].join('\n'));
    assert.ok(r.warnings.some((w) => /add up to 9\.00 \(or 11\.00 if the fee is a credit\), not to its Total 50\.00/.test(w)));
  });
});

describe('N8 wrong Square and Shopify exports are refused', () => {
  // Headers from
  const FILES = {
    'Square item sales': ['Date,Time,Time Zone,Category,Item,Qty,Price Point Name,SKU,Modifiers Applied,Gross Sales,Discounts,Net Sales,Tax,Transaction ID,Payment ID,Device Name,Notes,Details,Event Type,Location\n2024-08-24,15:20:01,Pacific Time (US & Canada),Gifts,Brooch,1,Regular,,,$19.05,$0.00,$19.05,$0.95,TX1,P1,Reg,,,Payment,Shop\n', /Square item sales export/],
    'Shopify orders': ['Name,Email,Financial Status,Paid at,Fulfillment Status,Fulfilled at,Accepts Marketing,Currency,Subtotal,Shipping,Taxes,Total,Discount Code,Discount Amount,Shipping Method,Created at,Lineitem quantity,Lineitem name,Lineitem price\n#1001,a@b.c,paid,2024-01-02 10:00:00 -0500,fulfilled,,no,USD,10.00,0,0,10.00,,0,,2024-01-02 10:00:00 -0500,1,Mug,10.00\n', /Shopify orders export/],
    'Shopify products': ['Handle,Title,Body (HTML),Vendor,Type,Tags,Published,Option1 Name,Option1 Value,Variant SKU,Variant Price\nmug,Mug,,Me,,,true,Title,Default,M1,10.00\n', /Shopify products export/],
  };
  for (const [name, [text, re]] of Object.entries(FILES)) {
    test(`N8: ${name} export is refused by detection, auto parse and the bank parser, with the right export named`, () => {
      const d = detectSource(text);
      assert.equal(d.sourceId, null);
      assert.match(d.reason, re);
      assert.match(d.reason, /Transactions CSV|export the transactions/);
      assert.throws(() => parse('auto', text), (e) => isEngineError('UNRECOGNIZED')(e) && re.test(e.message));
      assert.throws(() => parse('generic-bank', text), (e) => isEngineError('WRONG_SOURCE')(e) && re.test(e.message));
    });
  }
  test('N8: an ordinary bank CSV is still accepted', () => {
    assert.equal(detectSource(readFixture('generic-bank-debit-credit.csv')).sourceId, 'generic-bank');
  });
});

const ST_H = 'Transaction Date,Type,Order,Card Brand,Card Source,Payout Status,Payout Date,Available On,Amount,Fee,Net,Currency';
describe('N9 Shopify payouts grouped by date', () => {
  test('N9: without a Payout ID column, a warning says payouts on the same day are combined', () => {
    const r = parse('shopify-transactions', [ST_H, '2024-01-02 10:00:00 -0500,charge,#1,visa,online,paid,2024-01-05,2024-01-04,100.00,3.20,96.80,USD', '2024-01-02 11:00:00 -0500,charge,#2,visa,online,paid,2024-01-05,2024-01-04,50.00,1.75,48.25,USD'].join('\n'));
    assert.ok(r.warnings.some((w) => /no Payout ID column/.test(w) && /combined into one deposit/.test(w)));
  });
});

describe('N10 Square partial refunds', () => {
  test('N10: any non-zero Partial Refunds cell gives a plain warning saying what to check', () => {
    const r = parse('square', [SQ_H, '2024-08-24,15:20,Pacific,$50.00,$50.00,$0.00,$0.00,$0.00,-$10.00,$40.00,$40.00,$0.00,$0.00,$0.00,-$1.45,$38.55,T1,P1,Dinner,Payment,D1,2024-08-25,Complete'].join('\n'));
    const w = r.warnings.find((x) => /Partial Refunds column \(total -10\.00\)/.test(x));
    assert.ok(w, r.warnings.join('\n'));
    assert.match(w, /may also appear as its own Refund row/);
    assert.match(w, /comparing the converted total with the matching Square deposit/);
  });
});

describe('N11 re-saved dates with a decimal comma', () => {
  test('N11: Shopify slash dates that cannot decide the order in a decimal-comma file are asked about, not defaulted', () => {
    const text = [ST_H, '03/01/2024 10:00,charge,#1,visa,online,paid,04/01/2024,04/01/2024,"1.000,00","30,00","970,00",EUR'].join('\n');
    assert.throws(() => parse('shopify-transactions', text), isEngineError('AMBIGUOUS_DATE_ORDER'));
    const r = parse('shopify-transactions', text, { dateOrder: 'dmy' });
    assert.equal(r.transactions[0].date, '2024-01-03');
    assert.equal(r.meta.dateOrderAssumed, true);
  });
  test('N11: Square behaves the same way', () => {
    const text = [SQ_H, '03/01/2024,15:20,Paris,"10,00 €","10,00 €","0,00 €","0,00 €","0,00 €","0,00 €","10,00 €","10,00 €","0,00 €","0,00 €","0,00 €","-0,30 €","9,70 €",T1,P1,Cafe,Payment,,,Complete'].join('\n');
    assert.throws(() => parse('square', text), isEngineError('AMBIGUOUS_DATE_ORDER'));
  });
});

describe('N13 Shopify adjustments name their accounts', () => {
  test('N13: the warning names Uncategorized Income and Uncategorized Expense in plain words', () => {
    const r = parse('shopify-transactions', readFixture('shopify-transactions.csv'));
    assert.ok(r.warnings.some((w) => /adjustments and reserved funds total 12\.00/.test(w) && /"Uncategorized Income" \(money added\) or "Uncategorized Expense" \(money taken\)/.test(w)));
    const p = parse('shopify-payouts', readFixture('shopify-payouts.csv'));
    assert.ok(p.warnings.some((w) => /"Uncategorized Income"/.test(w)));
  });
});

describe('Round 2', () => {
  test('R2-1: refunding a tipped Square sale takes the tip back out of "Tips owed to staff", not out of sales', () => {
    const text = [SQ_H,
      '2024-08-24,15:20,Pacific,$40.00,$40.00,$0.00,$0.00,$8.00,$0.00,$48.00,$48.00,$0.00,$0.00,$0.00,-$1.30,$46.70,T1,P1,Dinner,Payment,D1,2024-08-25,Complete',
      '2024-08-24,19:20,Pacific,-$40.00,-$40.00,$0.00,$0.00,-$8.00,$0.00,-$48.00,-$48.00,$0.00,$0.00,$0.00,$0.00,-$48.00,T1,P1,Dinner,Refund,D1,2024-08-25,Complete',
      '2024-08-24,20:20,Pacific,$0.00,$0.00,-$50.00,$0.00,$0.00,$0.00,-$50.00,-$50.00,$0.00,$0.00,$0.00,$0.00,-$50.00,T2,P2,eGift Card,Refund,D1,2024-08-25,Complete',
    ].join('\n');
    const r = parse('square', text);
    const out = write('qbo-journal', r.transactions, { sourceId: 'square' });
    assert.deepEqual(checkJournal(out.content).errors, []);
    const rows = journalRows(out.content);
    assert.equal(sumAccount(rows, 'Tips owed to staff'), 0);
    assert.equal(sumAccount(rows, 'Gift card liability'), -5000);
    assert.equal(sumAccount(rows, 'Sales of Product Income'), 0);
    assert.equal(-sumAccount(rows, 'Checking'), 4670 - 4800 - 5000);
    assert.ok(r.warnings.some((w) => /Refunds in this file give back 8\.00 of tips and 50\.00 of gift card sales/.test(w)));
  });
  test('R2-2: the wrong-export check finds a Square items header below several preamble lines, like the bank parser does', () => {
    const pre = 'Report,,\nShop,,\nFrom,2024-08-01,\nTo,2024-08-31,\nGenerated,2024-09-01,\n,,\n';
    const text = pre + 'Date,Time,Time Zone,Category,Item,Qty,Price Point Name,SKU,Gross Sales,Net Sales,Tax,Transaction ID,Payment ID\n2024-08-24,15:20:01,Pacific,Gifts,Brooch,1,Regular,,$19.05,$19.05,$0.95,TX1,P1\n';
    assert.equal(detectSource(text).sourceId, null);
    assert.throws(() => parse('generic-bank', text), (e) => isEngineError('WRONG_SOURCE')(e) && /Square item sales export/.test(e.message));
  });
  test('R2-N7: a Shopify fee credit is booked with a plain warning', () => {
    const r = parse('shopify-payouts', [SP_H, '2024-04-01,paid,10.00,0.00,0.00,0.00,-0.50,0.00,10.50,USD'].join('\n'));
    assert.ok(r.warnings.some((w) => /fees as a credit to you \(0\.50 on 2024-04-01\)/.test(w)));
    const paid = parse('shopify-payouts', [SP_H, '2024-04-01,paid,10.00,0.00,0.00,0.00,-0.50,0.00,9.50,USD'].join('\n'));
    assert.ok(!paid.warnings.some((w) => /as a credit/.test(w)));
  });
  test('R2-4: a failed payout that took money out of the balance reads "Taken from Shopify balance"', () => {
    const j = write('qbo-journal', parse('shopify-payouts', readFixture('shopify-payouts.csv')).transactions, { sourceId: 'shopify-payouts' }).content;
    assert.match(j, /Taken from Shopify balance - Shopify activity not yet paid out/);
    assert.doesNotMatch(j, /Paid from earlier Shopify balance - Shopify activity not yet paid out/);
  });
});
