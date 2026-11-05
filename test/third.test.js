// Regression tests for the third review pass ("Third check" in
//
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse, write, EngineError } from '../index.js';
import { fundingKind } from '../src/util.js';
import { strictParse } from '../test-support/csv-checks.js';

const err = (code) => (e) => e instanceof EngineError && e.code === code;

describe('B1: options only break genuine ties; the data wins', () => {
  test('decimal "," on a US file: "1,234.56" stays 1234.56 and "-6.00" stays -6.00', () => {
    const r = parse('generic-bank', 'Date,Description,Amount\n2025-04-15,A,"1,234.56"\n2025-04-16,B,-6.00\n', { decimal: ',' });
    assert.deepEqual(r.transactions.map((t) => t.amount), [1234.56, -6]);
    assert.notEqual(r.meta.decimalAssumed, true);
    assert.ok(r.warnings.some((w) => /ignored the setting/.test(w)));
  });
  test('decimal "." on a European file: "12,5" and "1.234,56" read comma-decimal', () => {
    const r = parse('generic-bank', 'Date;Description;Amount\n15.04.2025;A;1.234,56\n16.04.2025;B;-12,5\n', { decimal: '.' });
    assert.deepEqual(r.transactions.map((t) => t.amount), [1234.56, -12.5]);
  });
  test('dateOrder "dmy" on a file containing 04/15/2025 reads every date month first, no row dropped', () => {
    const r = parse('generic-bank', 'Date,Description,Amount\n04/15/2025,A,-5.00\n04/02/2025,B,-6.00\n', { dateOrder: 'dmy' });
    assert.deepEqual(r.transactions.map((t) => t.date), ['2025-04-02', '2025-04-15']);
    assert.equal(r.meta.rowsRead, 2);
    assert.notEqual(r.meta.dateOrderAssumed, true);
    assert.ok(r.warnings.some((w) => /ignored the setting/.test(w)));
  });
  test('the same holds for PayPal and Airbnb (every source using the option)', () => {
    const PH = '"Date","Time","TimeZone","Name","Type","Status","Currency","Gross","Fee","Net","Transaction ID","Balance Impact"\n';
    const pp = parse('paypal', PH + '"04/15/2025","10:00:00","PST","A","Website Payment","Completed","USD","1,234.56","-6.00","1,228.56","T1","Credit"\n"04/02/2025","10:00:00","PST","B","Website Payment","Completed","USD","10.00","-0.50","9.50","T2","Credit"\n', { dateOrder: 'dmy', decimal: ',' });
    assert.deepEqual(pp.transactions.map((t) => [t.date, t.amount]), [['2025-04-02', 9.5], ['2025-04-15', 1228.56]]);
  });
  test('a date-shaped value that is not a real date raises an error naming the line', () => {
    assert.throws(() => parse('generic-bank', 'Date,Description,Amount\n04/15/2025,A,-5.00\n02/30/2025,B,-6.00\n'), (e) => err('UNREADABLE_DATE')(e) && /Line 3/.test(e.message) && e.details.line === 3);
  });
  test('contradictory dates throw MIXED_DATE_FORMATS with both sample rows, even with an option', () => {
    for (const o of [{}, { dateOrder: 'mdy' }]) {
      assert.throws(() => parse('generic-bank', 'Date,Description,Amount\n04/15/2025,A,-5.00\n15/04/2025,B,-6.00\n', o), (e) => err('MIXED_DATE_FORMATS')(e)
        && e.details.samples[0].value === '04/15/2025' && e.details.samples[1].value === '15/04/2025');
    }
  });
  test('only a genuine tie uses the option, with the assumed flag and sample', () => {
    const r = parse('generic-bank', 'Date,Description,Amount\n04/01/2025,A,-5.00\n04/02/2025,B,-6.00\n', { dateOrder: 'dmy' });
    assert.deepEqual(r.transactions.map((t) => t.date), ['2025-01-04', '2025-02-04']);
    assert.equal(r.meta.dateOrderAssumed, true);
  });
});

describe('B2: funding labels', () => {
  test('bank words win, card only on clear card evidence, unclear defaults to bank', () => {
    const cases = {
      'Navy Federal Credit Union Checking *1234': 'bank', 'Discover Bank Savings *9': 'bank', 'Wells Fargo *0000': 'bank', 'Chime *1234': 'bank',
      'Visa Debit *4242': 'card', 'American Express Card *1': 'card', 'Amex *2': 'card', 'First Financial Credit Card *2': 'card', 'Discover *3': 'card', 'Chase debit card *1': 'card',
      'BANK OF AMERICA, N.A. *1': 'bank', 'Capital One 360 Checking': 'bank', '': 'bank',
    };
    for (const [label, kind] of Object.entries(cases)) assert.equal(fundingKind(label), kind, label);
    const u = new Set();
    fundingKind('Wells Fargo *0000', u); fundingKind('Navy Federal Credit Union Checking *1234', u); fundingKind('', u);
    assert.deepEqual([...u], ['Wells Fargo *0000', '(blank)']);
  });
  test('Venmo: "Wells Fargo *0000" funding books to the bank with a warning naming it; Venmo balance stays internal', () => {
    const H = 'Account Statement - (@Pat) ,,,,,,,,,,,,,,,,,,,,,\nAccount Activity,,,,,,,,,,,,,,,,,,,,,\n,ID,Datetime,Type,Status,Note,From,To,Amount (total),Amount (tip),Amount (tax),Amount (fee),Tax Rate,Tax Exempt,Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,Terminal Location,Year to Date Venmo Fees,Disclaimer\n';
    const row = (id, fund) => `,${id},2025-03-06T18:00:00,Payment,Complete,Shoes,Pat,Shop,- $90.00,,0,,0,,${fund},,,,,Venmo,,`;
    const r = parse('venmo', H + [row(1, 'Wells Fargo *0000'), row(2, 'Venmo balance'), row(3, 'Navy Federal Credit Union Checking *1234'), row(4, 'Discover Bank Savings *9'), row(5, '')].join('\n') + '\n', { timeZone: 'UTC' });
    const funded = r.transactions.filter((t) => t.type === 'transfer');
    assert.equal(funded.length, 3);
    assert.ok(funded.every((t) => t.transferAccount === 'bank'));
    assert.ok(r.warnings.some((w) => /"Wells Fargo \*0000"/.test(w) && /booked to your bank account/.test(w)));
    const rows = strictParse(write('qbo-journal', r.transactions).content).slice(1);
    assert.ok(!rows.some((x) => x[2] === 'Credit card or other funding source'));
  });
});

describe('B3: re-saved Stripe dates read by assumption are flagged', () => {
  test('ambiguous local dates set dateOrderAssumed and a sample', () => {
    const r = parse('stripe-balance', 'balance_transaction_id,created,currency,gross,fee,net,reporting_category\ntxn_1AAAAAAAA,03/04/2025 10:00,usd,10.00,0.59,9.41,charge\n');
    assert.equal(r.transactions[0].date, '2025-03-04');
    assert.equal(r.meta.dateOrderAssumed, true);
    assert.equal(r.meta.assumptionSamples[0].sample, '03/04/2025 10:00');
  });
  test('re-saved created_utc dates too', () => {
    const r = parse('stripe-balance', 'id,Type,Source,Amount,Fee,Net,Currency,Created (UTC),Available On (UTC),Description\ntxn_1AAAAAAAAAA,charge,ch_1AAAAAAAA,10.00,0.59,9.41,usd,7/1/2025 2:12,7/3/2025 0:00,x\n', { timeZone: 'America/Los_Angeles' });
    assert.equal(r.meta.dateOrderAssumed, true);
  });
});

describe('fourth check', () => {
  test('a lone three-decimal amount is reported per row, never rounded silently', () => {
    const r = parse('generic-bank', 'Date,Description,Amount\n01/15/2025,Fuel,1.234\n01/16/2025,X,2.50\n');
    assert.equal(r.transactions[0].amount, 1.23);
    assert.ok(r.warnings.some((w) => /2025-01-15 \(Fuel\).*"1\.234".*1\.23/.test(w)));
  });
  test('"card" alone and common card products are card evidence; bank words still win', () => {
    for (const l of ['Apple Card *9', 'Capital One Quicksilver *1', 'Citi Double Cash *2', 'Chase Sapphire *3']) assert.equal(fundingKind(l), 'card', l);
    for (const l of ['Chase Freedom Checking *4', 'Card Union Bank *5', 'Wells Fargo *0000']) assert.equal(fundingKind(l), 'bank', l);
  });
});
