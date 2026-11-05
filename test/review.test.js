// Regression tests from an independent review of the engine.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse, write, detectSource, convert, summarizePayouts, EngineError } from '../index.js';
import { parseCSV, sniffDelimiter } from '../src/csv.js';
import { readFixture } from '../test-support/fixtures.js';
import { validateOfx } from '../test-support/ofx-validator.js';
import { checkJournal, strictParse } from '../test-support/csv-checks.js';

const fitids = (c) => [...c.matchAll(/<FITID>([^<]+)<\/FITID>[\s\S]*?<NAME>([^<]+)/g)].map((m) => [m[2], m[1]]);
const journalRows = (c) => strictParse(c).slice(1).map((r) => ({ no: r[0], account: r[2], dr: r[3], cr: r[4], desc: r[5] }));
const err = (code) => (e) => e instanceof EngineError && e.code === code;

describe('bug 1: journal books transfers as transfers and sent payments on their own line', () => {
  test('PayPal: the $1,000 General Withdrawal is a bank transfer, not an expense', () => {
    const out = write('qbo-journal', parse('paypal', readFixture('paypal-us.csv')).transactions, { sourceId: 'paypal' });
    const rows = journalRows(out.content);
    assert.deepEqual(checkJournal(out.content).errors, []);
    assert.ok(!rows.some((r) => r.account === 'Uncategorized Expense'));
    assert.ok(rows.some((r) => r.account === 'Checking' && r.dr === '1000.00' && /Transfer from PayPal to bank/.test(r.desc)));
    assert.ok(rows.some((r) => r.account === 'Uncategorized Asset' && r.cr === '1000.00' && /Transfer from PayPal to bank/.test(r.desc)));
    assert.equal(rows.find((r) => /Gross sales/.test(r.desc)).cr, '1300.00');
    assert.equal(rows.find((r) => r.account === 'Payments sent (uncategorized expense)').dr, '21.84');
  });
  test('Venmo: $1,000 rent sent does not reduce sales; $500 Standard Transfer goes to the bank', () => {
    const out = write('qbo-journal', parse('venmo', readFixture('venmo-2025.csv')).transactions, { sourceId: 'venmo' });
    const rows = journalRows(out.content);
    assert.deepEqual(checkJournal(out.content).errors, []);
    assert.equal(rows.find((r) => /Gross sales/.test(r.desc)).cr, '2055.00');
    assert.equal(rows.find((r) => r.account === 'Payments sent (uncategorized expense)').dr, '1080.00');
    assert.ok(rows.some((r) => r.account === 'Checking' && r.dr === '500.00'));
    assert.ok(rows.some((r) => r.account === 'Checking' && r.cr === '80.00'));
    assert.ok(!rows.some((r) => /Uncategorized (Expense|Income)/.test(r.account)));
    // Clearing nets to the statement's balance change: 636.90 - 120.00.
    const clearing = rows.filter((r) => r.account === 'Uncategorized Asset').reduce((s, r) => s + Math.round(Number(r.dr || 0) * 100) - Math.round(Number(r.cr || 0) * 100), 0);
    assert.equal(clearing, 51690);
  });
  test('account overrides, including paymentsSent and transfers', () => {
    const out = write('qbo-journal', parse('venmo', readFixture('venmo-2025.csv')).transactions, { accounts: { paymentsSent: 'Owner Draws', transfers: 'Chase Checking', clearing: 'Venmo Clearing' } });
    const rows = journalRows(out.content);
    assert.ok(rows.some((r) => r.account === 'Owner Draws' && r.dr === '1080.00'));
    assert.ok(rows.some((r) => r.account === 'Chase Checking' && r.dr === '500.00'));
    assert.throws(() => write('qbo-journal', parse('venmo', readFixture('venmo-2025.csv')).transactions, { accounts: { bogus: 'x' } }), err('BAD_OPTION'));
  });
  test('gross sales never negative; every group balances, for every fixture', () => {
    for (const [s, f, o] of [['venmo', 'venmo-2025.csv'], ['cashapp', 'cashapp-2026.csv'], ['cashapp', 'cashapp-2024-v1.csv'], ['paypal', 'paypal-us.csv'], ['generic-bank', 'generic-bank-signed.csv', { dateOrder: 'mdy' }]]) {
      const txns = parse(s, readFixture(f), o).transactions;
      for (const r of summarizePayouts(txns, { groupBy: 'month' })) assert.ok(r.grossSales >= 0, `${f} ${r.key}`);
      assert.deepEqual(checkJournal(write('qbo-journal', txns).content).errors, []);
    }
  });
});

describe('bug 2: FITIDs', () => {
  const h = 'Date,Description,Amount,Check Number\n';
  test('overlapping exports with a non-unique id column keep the same FITID per row and never collide', () => {
    const a = fitids(convert('generic-bank', h + '01/05/2025,Coffee A,-3.00,0\n01/20/2025,Grocer B,-40.00,0\n', 'qbo', { dateOrder: 'mdy' }).content);
    const b = fitids(convert('generic-bank', h + '01/20/2025,Grocer B,-40.00,0\n02/02/2025,Rent C,-900.00,0\n', 'qbo', { dateOrder: 'mdy' }).content);
    const A = Object.fromEntries(a); const B = Object.fromEntries(b);
    assert.equal(A['Grocer B'], B['Grocer B']);
    assert.notEqual(B['Rent C'], A['Coffee A']);
    assert.notEqual(B['Rent C'], A['Grocer B']);
  });
  test('fee split: net line = base, gross line = base + G, fee line = base + F, with a warning (re-check N2)', () => {
    const p = parse('stripe-balance', 'balance_transaction_id,created,currency,gross,fee,net,reporting_category,description\ntxn_1AAAAAAAA,2025-01-02,usd,10.00,0.59,9.41,charge,x\n');
    const plain = fitids(write('qbo', p.transactions).content);
    const out = write('qbo', p.transactions, { includeFeesAsSeparateRows: true });
    const split = fitids(out.content);
    assert.equal(split[0][1], plain[0][1] + 'G');
    assert.equal(split[1][1], plain[0][1] + 'F');
    assert.ok(!split.some((x) => x[1] === plain[0][1]), 'no split line reuses the net line FITID');
    assert.ok(out.warnings.some((w) => /do not import the same period both ways/.test(w)));
  });
});

describe('bug 3: repeated exports', () => {
  test('two PayPal downloads pasted together give 7 transactions, not 14, with a warning', () => {
    const pp = readFixture('paypal-us.csv');
    const r = parse('paypal', pp + '\n' + pp.replace(/^﻿/, ''));
    assert.equal(r.transactions.length, 7);
    assert.ok(r.warnings.some((w) => /header row appears 2 times/.test(w)));
    assert.ok(r.warnings.some((w) => /Removed 7 duplicate/.test(w)));
    const ids = fitids(write('qbo', r.transactions).content).map((x) => x[1]);
    assert.equal(ids.length, 5);
    assert.equal(r.meta.duplicatesRemoved, 7);
  });
  test('two Venmo statements pasted together give 8 transactions', () => {
    const v = readFixture('venmo-2025.csv');
    const r = parse('venmo', v + '\n' + v);
    assert.equal(r.transactions.length, 8);
    assert.ok(r.warnings.some((w) => /duplicate/.test(w)));
  });
});

describe('bug 4: number format is never guessed', () => {
  const eu3 = 'Date;Description;Amount\n15.01.2025;Rent;-1.000\n16.01.2025;Salary;2.500\n17.01.2025;Fee;-5\n';
  test('thousands-only European amounts throw AMBIGUOUS_NUMBER_FORMAT with candidates', () => {
    assert.throws(() => parse('generic-bank', eu3), (e) => err('AMBIGUOUS_NUMBER_FORMAT')(e)
      && e.details.option === 'decimal' && e.details.sample === '-1.000'
      && e.details.candidates.some((c) => c.decimal === '.' && c.amount === -1)
      && e.details.candidates.some((c) => c.decimal === ',' && c.amount === -1000));
  });
  test('with decimal "," the amounts are -1000 and 2500', () => {
    assert.deepEqual(parse('generic-bank', eu3, { decimal: ',' }).transactions.map((t) => t.amount), [-1000, 2500, -5]);
  });
  test('when other values settle it, proceed and say so', () => {
    const r = parse('generic-bank', 'Date;Description;Amount\n15.01.2025;Rent;-1.000\n16.01.2025;Coffee;-3,50\n');
    assert.deepEqual(r.transactions.map((t) => t.amount), [-1000, -3.5]);
    assert.ok(r.warnings.some((w) => /could be read two ways/.test(w)));
  });
  test('mixed styles throw', () => {
    assert.throws(() => parse('generic-bank', 'Date,Description,Amount\n2025-01-15,A,"1,234.56"\n2025-01-16,B,"1.234,56"\n'), err('AMBIGUOUS_NUMBER_FORMAT'));
  });
});

describe('bug 5: Stripe detection needs Stripe evidence', () => {
  const g = 'ID,Created,Type,Amount,Fee,Net,Description\n1,2025-01-02,deposit,100.00,0,100.00,Paycheck\n2,2025-01-03,payout,50.00,0,50.00,Payout to savings\n';
  test('generic ID/Created/Type/Amount/Fee/Net falls to generic-bank and keeps signs', () => {
    assert.equal(detectSource(g).sourceId, 'generic-bank');
    assert.deepEqual(parse('auto', g).transactions.map((t) => t.amount), [100, 50]);
    assert.throws(() => parse('stripe-balance', g), err('WRONG_SOURCE'));
  });
  test('generic files with Transaction ID / Net Amount or Gross / Fee / Net are not Cash App or PayPal', () => {
    assert.equal(detectSource('Transaction ID,Date,Transaction Type,Amount,Net Amount\nA1,2025-01-02,Sale,10.00,9.50\n').sourceId, 'generic-bank');
    assert.equal(detectSource('Date,Name,Type,Status,Currency,Gross,Fee,Net\n2025-01-02,Ann,Sale,Done,USD,10.00,0.50,9.50\n').sourceId, 'generic-bank');
    assert.equal(detectSource('Payment ID,Order ID,Gross Amount,Net Amount,Date\n1,2,10.00,9.50,2025-01-02\n').sourceId, 'generic-bank');
  });
  test('real Stripe files still detect', () => {
    assert.equal(detectSource(readFixture('stripe-balance-history.csv')).sourceId, 'stripe-balance');
    assert.equal(detectSource('id,Type,Source,Amount,Fee,Net,Currency,Created (UTC)\ntxn_1AbCdEfGhIj,charge,ch_1,10.00,0.59,9.41,usd,2025-01-02 10:00\n').sourceId, 'stripe-balance');
  });
});

describe('bug 6: formula injection', () => {
  const inj = 'Date,Description,Amount,Transaction ID\n2025-01-02,"=HYPERLINK(""http://evil"",""x"")",-3.50,=1+1\n2025-01-03,@SUM(A1:A9),5.00,+cmd\n2025-01-04,-2+3+cmd|calc,5.00,-x\n';
  for (const t of ['xero-csv', 'qbo-csv-3', 'qbo-csv-4', 'qbo-journal']) {
    test(`${t}: no text cell starts with = + - @ tab or CR`, () => {
      const rows = strictParse(convert('generic-bank', inj, t).content);
      const textCols = t === 'xero-csv' ? [2, 3, 4] : t === 'qbo-journal' ? [2, 5, 6] : [1];
      for (const r of rows.slice(1)) for (const i of textCols) assert.doesNotMatch(r[i], /^[=+\-@\t\r]/, `${t} cell "${r[i]}"`);
    });
  }
  test('Xero keeps the text and prefixes the guard', () => {
    const rows = strictParse(convert('generic-bank', inj, 'xero-csv').content);
    assert.equal(rows[1][3], '\'=HYPERLINK("http://evil","x")');
    assert.equal(rows[2][4], "'+cmd");
  });
  test('a guard the source file already had is kept', () => {
    const r = parse('gumroad', readFixture('gumroad-sales.csv'));
    assert.ok(r.transactions.every((t) => !/^[=+\-@]/.test(t.description)));
  });
});

describe('bug 7: delimiter detection', () => {
  const eu = 'Date;Description;Amount\n01-02-2025;Albert Heijn, Amsterdam, NL;-3,50\n02-02-2025;Salaris, ACME, BV;2.500,00\n03-02-2025;Huur, jan, feb;-1.000,00\n';
  test('semicolon file with commas in descriptions', () => {
    assert.equal(sniffDelimiter(eu), ';');
    const r = parse('generic-bank', eu, { dateOrder: 'dmy' });
    assert.deepEqual(r.transactions.map((t) => [t.date, t.amount, t.description]), [['2025-02-01', -3.5, 'Albert Heijn, Amsterdam, NL'], ['2025-02-02', 2500, 'Salaris, ACME, BV'], ['2025-02-03', -1000, 'Huur, jan, feb']]);
  });
  test('Dutch headers map automatically', () => {
    assert.equal(detectSource(eu.replace('Date;Description;Amount', 'Datum;Omschrijving;Bedrag')).sourceId, 'generic-bank');
  });
  test('comma file with semicolons inside quoted text stays comma', () => {
    assert.equal(sniffDelimiter('a,b,c\n1,"x;y;z;w",3\n2,"p;q",4\n'), ',');
  });
});

describe('bug 8: day/month order is never guessed', () => {
  test('dash dates that fit both orders throw AMBIGUOUS_DATE_ORDER with candidates', () => {
    assert.throws(() => parse('generic-bank', 'Date,Description,Amount\n01-02-2025,A,1.50\n03-04-2025,B,2.50\n'), (e) => err('AMBIGUOUS_DATE_ORDER')(e)
      && e.details.option === 'dateOrder' && e.details.sample === '01-02-2025'
      && e.details.candidates.some((c) => c.dateOrder === 'mdy' && c.date === '2025-01-02')
      && e.details.candidates.some((c) => c.dateOrder === 'dmy' && c.date === '2025-02-01'));
  });
  test('dotted dates are day first, with a warning', () => {
    const r = parse('generic-bank', 'Date;Description;Amount\n01.02.2025;A;1,50\n03.04.2025;B;2,50\n');
    assert.deepEqual(r.transactions.map((t) => t.date), ['2025-02-01', '2025-04-03']);
    assert.ok(r.warnings.some((w) => /use dots/.test(w)));
  });
  test('dates that read the same either way (01/01, 05/05) do not count as ambiguous', () => {
    assert.equal(parse('generic-bank', 'Date,Description,Amount\n01/01/2025,A,1.50\n05/05/2025,B,2.50\n').transactions[1].date, '2025-05-05');
  });
  test('contradicting dates throw', () => {
    assert.throws(() => parse('generic-bank', 'Date,Description,Amount\n13/01/2025,A,1.50\n01/13/2025,B,2.50\n'), err('MIXED_DATE_FORMATS'));
  });
  test('the data deciding it is reported', () => {
    const r = parse('generic-bank', readFixture('generic-bank-debit-credit.csv'));
    assert.ok(r.warnings.some((w) => /"14\/03\/2025" can only be read that way/.test(w)));
  });
});

describe('bug 9: UTC timestamps and options.timeZone', () => {
  const venmo = readFixture('venmo-2025.csv').replace('2025-03-02T18:04:11', '2025-04-01T03:30:00');
  test('Venmo UTC time converts to the chosen zone; meta records it', () => {
    const la = parse('venmo', venmo, { timeZone: 'America/Los_Angeles' });
    const t = la.transactions.find((x) => x.id === '4012345678901234567');
    assert.equal(t.date, '2025-03-31');
    assert.equal(la.meta.timeZone, 'America/Los_Angeles');
    assert.ok(!la.warnings.some((w) => /no time zone was chosen/.test(w)));
  });
  test('without timeZone dates stay UTC, with a warning', () => {
    const utc = parse('venmo', venmo);
    assert.equal(utc.transactions.find((x) => x.id === '4012345678901234567').date, '2025-04-01');
    assert.equal(utc.meta.timeZone, 'UTC');
    assert.ok(utc.warnings.some((w) => /no time zone was chosen/.test(w)));
  });
  test('Stripe created_utc converts; a local created column is used as is', () => {
    const csv = 'balance_transaction_id,created_utc,currency,gross,fee,net,reporting_category\ntxn_1AAAAAAAA,2025-02-01 03:00:00,usd,10.00,0.59,9.41,charge\n';
    assert.equal(parse('stripe-balance', csv, { timeZone: 'America/New_York' }).transactions[0].date, '2025-01-31');
    const both = 'balance_transaction_id,created_utc,created,currency,gross,fee,net,reporting_category\ntxn_1AAAAAAAA,2025-02-01 03:00:00,,usd,10.00,0.59,9.41,charge\n';
    assert.equal(parse('stripe-balance', both).transactions.length, 1, 'blank local column falls back to created_utc');
  });
  test('bad time zone is a BAD_OPTION', () => {
    assert.throws(() => parse('venmo', venmo, { timeZone: 'Mars/Olympus' }), err('BAD_OPTION'));
  });
});

describe('bug 10: every error is an EngineError with a readable message', () => {
  const tx = [{ date: '2025-01-01', amount: 5, description: 'x', currency: 'USD', type: 'payment' }];
  test('ledgerBalance as text', () => {
    assert.match(write('qbo', tx, { ledgerBalance: '1,234.56' }).content, /<BALAMT>1234.56</);
    assert.throws(() => write('qbo', tx, { ledgerBalance: 'abc' }), err('BAD_OPTION'));
  });
  test('non-string cells and bad values', () => {
    assert.match(write('qbo', [{ ...tx[0], description: 12345 }]).content, /<NAME>12345</);
    assert.throws(() => write('qbo', [{ ...tx[0], currency: 5 }]), err('BAD_TXN'));
    assert.throws(() => write('qbo', [{ ...tx[0], fee: '1', gross: 6 }], { includeFeesAsSeparateRows: true }), err('BAD_TXN'));
    assert.throws(() => write('qbo-journal', [{ ...tx[0], tax: 'abc' }]), err('BAD_TXN'));
    assert.throws(() => write('qbo', [{ ...tx[0], type: 'gift' }]), err('BAD_TXN'));
  });
  test('garbage inputs never escape as plain errors', () => {
    const bad = [[null], [undefined], [{}], [[]], [[1, 2]], [tx, 5], [tx, null], [tx, { accounts: 5 }], [tx, { dateFormat: 7 }], [tx, { region: {} }], [tx, { currency: 'dollars' }], [tx, { intuBid: {} }]];
    for (const target of ['qbo', 'qbo-csv-3', 'xero-csv', 'qbo-journal']) {
      for (const [t, o] of bad) {
        try { write(target, t, o); } catch (e) { assert.ok(e instanceof EngineError, `${target}: ${e && e.message}`); assert.ok(e.message.length > 15); }
      }
    }
    for (const o of [null, 5, { decimal: ';' }, { dateOrder: 'ymd' }, { delimiter: 'ab' }, { mapping: 5 }]) {
      assert.throws(() => parse('generic-bank', 'Date,Amount\n2025-01-02,5\n', o), (e) => e instanceof EngineError);
    }
    assert.throws(() => summarizePayouts([{ date: 'x' }], { groupBy: 'month' }), (e) => e instanceof EngineError);
  });
});

describe('bug 11: no quadratic regex, sane cell cap', () => {
  const H = '﻿Date,Type,Title,Info,Currency,Amount,"Fees & Taxes",Net,"Tax Details"\n';
  test('a 40,000-digit Etsy deposit title is handled fast', () => {
    const t0 = performance.now();
    const r = parse('etsy', H + `"March 31, 2025",Deposit,"${'1'.repeat(40000)}",,USD,--,--,--,--\n"March 30, 2025",Deposit,"$5.00 sent to your bank account",,USD,--,--,--,--\n`);
    assert.ok(performance.now() - t0 < 300);
    assert.equal(r.transactions.length, 1);
  });
  test('a 1 MB cell gives CELL_TOO_LONG', () => {
    assert.throws(() => parse('etsy', H + `"March 31, 2025",Deposit,"${'1'.repeat(1e6)}",,USD,--,--,--,--\n`), err('CELL_TOO_LONG'));
  });
});

describe('bug 12: claims and leftovers', () => {
  test('Xero rejects 12-digit amounts like QuickBooks', () => {
    assert.throws(() => write('xero-csv', [{ date: '2025-01-01', amount: 1e12, description: 'x' }]), err('AMOUNT_TOO_LARGE'));
  });
  test('journal currency that matches nothing is an error, not silently ignored', () => {
    assert.throws(() => write('qbo-journal', [{ date: '2025-01-01', amount: 5, description: 'x', type: 'payment' }], { currency: 'EUR' }), err('NO_TRANSACTIONS'));
  });
  test('constructor and toString headers keep their names', () => {
    const r = parse('generic-bank', '__proto__,constructor,Date,Amount,toString\nx,y,2025-01-02,5.00,z\n');
    assert.equal(r.transactions[0].raw.constructor, 'y');
    assert.equal(r.transactions[0].raw.toString, 'z');
    assert.equal(({}).x, undefined);
  });
});

describe('suspicions', () => {
  const ppH = '"Date","Time","TimeZone","Name","Type","Status","Currency","Gross","Fee","Net","Transaction ID","Reference Txn ID","Balance Impact"';
  test('S1: a Pending PayPal row is left out even with a Balance Impact', () => {
    const r = parse('paypal', ppH + '\n"03/01/2025","10:00:00","PST","Buyer A","Express Checkout Payment","Pending","USD","100.00","-3.79","96.21","T1","","Credit"\n"03/15/2025","10:00:00","PST","Buyer B","Express Checkout Payment","Completed","USD","10.00","-0.59","9.41","T2","","Credit"\n');
    assert.deepEqual(r.transactions.map((t) => t.id), ['T2']);
  });
  test('S2: Payment Hold and Payment Release are not sales', () => {
    const r = parse('paypal', ppH + '\n"03/02/2025","10:00:00","PST","Buyer B","Payment Hold","Completed","USD","-50.00","0.00","-50.00","T2","","Debit"\n"03/13/2025","10:00:00","PST","Buyer B","Payment Release","Completed","USD","50.00","0.00","50.00","T3","","Credit"\n');
    assert.equal(r.transactions.length, 0);
  });
  test('S4: a failed Stripe payout keeps its payout_reversal pair so they cancel', () => {
    const csv = 'balance_transaction_id,effective_at,currency,gross,fee,net,payout_id,payout_status,reporting_category\ntxn_1PAYOUTAAA,2025-01-05 00:00:00,usd,100.00,0.00,100.00,po_1FAILEDAAA,failed,payout\ntxn_1REVERSALA,2025-01-06 00:00:00,usd,100.00,0.00,100.00,po_1FAILEDAAA,failed,payout_reversal\n';
    const r = parse('stripe-payouts', csv);
    assert.deepEqual(r.transactions.map((t) => t.amount), [-100, 100]);
    const [s] = summarizePayouts(r.transactions, { groupBy: 'payout' });
    assert.equal(s.payoutAmount, 0);
  });
  test('S5: a payout mixing currencies books the minority currency to clearing, not the bank', () => {
    const csv = 'balance_transaction_id,created,currency,gross,fee,net,reporting_category,description,automatic_payout_id\ntxn_1AAAAAAAA,2025-01-02,usd,10.00,0.59,9.41,charge,,po_1AAAAAAAA\ntxn_2AAAAAAAA,2025-01-03,usd,20.00,0.59,19.41,charge,,po_1AAAAAAAA\ntxn_3AAAAAAAA,2025-01-03,eur,20.00,1.00,19.00,charge,,po_1AAAAAAAA\n';
    const out = write('qbo-journal', parse('stripe-payouts', csv).transactions, { currency: 'EUR' });
    const rows = journalRows(out.content);
    assert.ok(!rows.some((r) => r.account === 'Checking'));
    assert.ok(out.warnings.some((w) => /more than one currency/.test(w)));
  });
  test('S6: a generic file where nearly everything is positive gets an invert-sign hint', () => {
    const rows = ['Date,Description,Amount', ...[1, 2, 3, 4, 5, 6].map((d) => `2025-01-0${d},Purchase ${d},${d}.00`)];
    const r = parse('generic-bank', rows.join('\n'));
    assert.ok(r.warnings.some((w) => /invert sign/.test(w)));
  });
});
