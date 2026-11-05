// Regression tests from the second review pass.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse, write, convert, summarizePayouts, EngineError } from '../index.js';
import { utcToZoneDate } from '../src/dates.js';
import { readFixture } from '../test-support/fixtures.js';
import { checkJournal, strictParse } from '../test-support/csv-checks.js';

const rowsOf = (c) => strictParse(c).slice(1).map((r) => ({ account: r[2], dr: r[3], cr: r[4], desc: r[5] }));
const fits = (c) => [...c.matchAll(/<TRNAMT>([^<]+)<\/TRNAMT>\s*<FITID>([^<]+)/g)].map((m) => [m[1], m[2]]);
const VH = 'Account Statement - (@Pat-Example) ,,,,,,,,,,,,,,,,,,,,,\nAccount Activity,,,,,,,,,,,,,,,,,,,,,\n,ID,Datetime,Type,Status,Note,From,To,Amount (total),Amount (tip),Amount (tax),Amount (fee),Tax Rate,Tax Exempt,Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,Terminal Location,Year to Date Venmo Fees,Disclaimer\n';
const vr = (id, dt, type, status, note, from, to, amt, fee, fund, dest) => `,${id},${dt},${type},${status},${note},${from},${to},"${amt}",,0,${fee},0,,${fund},${dest},,,,Venmo,,`;
const venmo = (rows) => parse('venmo', VH + rows.join('\n') + '\n', { timeZone: 'America/Los_Angeles' });
const CH = '"Date","Transaction ID","Transaction Type","Currency","Amount","Fee","Net Amount","Asset Type","Asset Price","Asset Amount","Status","Notes","Name of sender/receiver","Account"\n';
const PH = '"Date","Time","TimeZone","Name","Type","Status","Currency","Gross","Fee","Net","Transaction ID","Reference Txn ID","Balance Impact"\n';

describe('N1: a fee on a transfer or payout is an expense; the bank line is what reaches the bank', () => {
  test('Cash App instant cash out: Amount -100, Fee -1.75, Net -101.75', () => {
    const ca = CH + '"2026-01-22 09:30:00 EST","#A1","Withdrawal","USD","-$100.00","-$1.75","-$101.75","","","","COMPLETE","Instant Cash Out","","Cash Balance"\n"2026-01-20 09:30:00 EST","#A2","P2P","USD","$200.00","$0.00","$200.00","","","","COMPLETE","Gig","Lee C","Cash Balance"\n';
    const out = convert('cashapp', ca, 'qbo-journal');
    const rows = rowsOf(out.content);
    assert.deepEqual(checkJournal(out.content).errors, []);
    assert.ok(rows.some((r) => r.account === 'Checking' && r.dr === '100.00'));
    assert.ok(rows.some((r) => r.account === 'Bank Charges & Fees' && r.dr === '1.75'));
    assert.ok(!rows.some((r) => r.dr === '101.75'));
  });
  test('Venmo instant transfer with Amount (fee)', () => {
    const t = venmo([vr('1003', '2025-03-07T18:00:00', 'Instant Transfer', 'Issued', '', '', '', '- $50.00', '$0.88', '', 'BANK *1')]).transactions;
    const [s] = summarizePayouts(t, { groupBy: 'month' });
    assert.deepEqual([s.transfersToBank, s.fees], [49.12, -0.88]);
  });
  test('Stripe instant payout with a fee: bank gets the gross, fee expensed', () => {
    const csv = 'id,Type,Source,Amount,Fee,Net,Currency,Created (UTC),Available On (UTC),Description,Transfer\ntxn_1AAAAAAAAAA,charge,ch_1AAAAAAAA,200.00,6.10,193.90,usd,2025-01-02 10:00,2025-01-02 10:00,x,po_1AAAAAAAAAA\ntxn_2AAAAAAAAAA,payout,po_1AAAAAAAAAA,-100.00,1.50,-101.50,usd,2025-01-03 10:00,2025-01-03 10:00,STRIPE PAYOUT,po_1AAAAAAAAAA\n';
    const [s] = summarizePayouts(parse('stripe-balance', csv, { timeZone: 'UTC' }).transactions, { groupBy: 'payout' });
    assert.deepEqual([s.payoutAmount, s.fees, s.difference], [100, -7.6, 92.4]);
  });
  test('PayPal withdrawal with a fee', () => {
    const pp = PH + '"03/15/2025","10:00:00","PST","","General Withdrawal","Completed","USD","-100.00","-1.50","-101.50","W1","","Debit"\n';
    const [s] = summarizePayouts(parse('paypal', pp).transactions, { groupBy: 'month' });
    assert.deepEqual([s.transfersToBank, s.fees], [100, -1.5]);
  });
});

describe('N3: FITIDs are decided per row', () => {
  const GH = 'Type,Date,Purchase ID,Item Name,Buyer Name,Buyer Email,Taxes ($),Shipping ($),Sale Price ($),Gumroad Fees ($),Net Total ($)\n';
  test('a repeated Gumroad purchase id does not change another row\'s FITID', () => {
    const g2 = GH + 'Sale,2026-03-02,P1==,Course,Al,a@x,0,0,100.0,10.0,90.0\nPartial Refund,2026-03-05,P1==,Course,Al,a@x,0,0,-10.0,-1.0,-9.0\nPartial Refund,2026-03-06,P1==,Course,Al,a@x,0,0,-20.0,-2.0,-18.0\nSale,2026-03-07,P2==,Book,Bo,b@x,0,0,10.0,1.0,9.0\n';
    const g3 = GH + 'Sale,2026-03-07,P2==,Book,Bo,b@x,0,0,10.0,1.0,9.0\nSale,2026-03-08,P3==,Book,Cy,c@x,0,0,10.0,1.0,9.0\n';
    const a = fits(convert('gumroad', g2, 'qbo').content).find((x) => x[0] === '9.00')[1];
    const b = fits(convert('gumroad', g3, 'qbo').content)[0][1];
    assert.equal(a, b);
  });
  test('a sometimes-repeated Reference column does not change other rows', () => {
    const h = 'Date,Description,Amount,Reference\n';
    const a = fits(convert('generic-bank', h + '2025-01-05,Coffee,-3.00,R1\n2025-01-06,Rent,-900.00,R2\n2025-01-07,Fee,-1.00,R2\n', 'qbo').content);
    const b = fits(convert('generic-bank', h + '2025-01-05,Coffee,-3.00,R1\n', 'qbo').content);
    assert.equal(a[0][1], b[0][1]);
    assert.equal(new Set(a.map((x) => x[1])).size, 3);
  });
});

describe('N4: funding from a card is not a bank transfer', () => {
  test('Venmo payment funded by Visa *4242 books to the card account, not Checking', () => {
    const p = venmo([vr('2002', '2025-03-06T18:00:00', 'Payment', 'Complete', 'Shoes', 'Pat Example', 'Shop B', '- $90.00', '', 'Visa *4242', ''), vr('2004', '2025-03-08T18:00:00', 'Payment', 'Complete', 'Gig', 'Lee C', 'Pat Example', '+ $200.00', '', '', 'Venmo balance')]);
    const out = write('qbo-journal', p.transactions, { sourceId: 'venmo' });
    const rows = rowsOf(out.content);
    assert.ok(!rows.some((r) => r.account === 'Checking'));
    assert.ok(rows.some((r) => r.account === 'Credit card or other funding source' && r.cr === '90.00'));
    assert.ok(out.warnings.some((w) => /card or another source/.test(w)));
    assert.ok(p.warnings.some((w) => /card or another source/.test(w)));
    const o2 = write('qbo-journal', p.transactions, { accounts: { fundingCard: 'Amex Card' } });
    assert.ok(rowsOf(o2.content).some((r) => r.account === 'Amex Card'));
  });
});

describe('N5: duplicates are only merged when the whole source row is identical and ids are row-unique', () => {
  const GH = 'Type,Date,Purchase ID,Item Name,Buyer Name,Buyer Email,Taxes ($),Shipping ($),Sale Price ($),Gumroad Fees ($),Net Total ($)\n';
  test('two identical Gumroad partial refunds are both kept', () => {
    const g = GH + 'Sale,2026-03-02,P1==,Course,Al,a@x,0,0,100.0,10.0,90.0\nPartial Refund,2026-03-05,P1==,Course,Al,a@x,0,0,-10.0,-1.0,-9.0\nPartial Refund,2026-03-05,P1==,Course,Al,a@x,0,0,-10.0,-1.0,-9.0\n';
    const p = parse('gumroad', g);
    assert.equal(p.transactions.length, 3);
    assert.equal(p.transactions.reduce((s, t) => s + Math.round(t.amount * 100), 0), 7200);
  });
  test('PayPal rows sharing a Reference Txn ID are not merged; true repeats are, with count and total', () => {
    const row1 = '"03/05/2025","10:00:00","PST","Buyer","Express Checkout Payment","Completed","USD","100.00","-3.79","96.21","P1","","Credit"';
    const row2 = '"03/06/2025","10:00:00","PST","Buyer","Payment Refund","Completed","USD","-10.00","0.30","-9.70","P2","P1","Debit"';
    const r = parse('paypal', PH + [row1, row2, row1].join('\n') + '\n');
    assert.equal(r.transactions.length, 2);
    assert.ok(r.warnings.some((w) => /Removed 1 duplicate transaction\(s\) totalling 96\.21/.test(w)));
  });
});

describe('N6: time zones honour explicit offsets; re-saved timestamps are not converted', () => {
  test('explicit offsets and Z', () => {
    assert.equal(utcToZoneDate('2025-04-08T23:30:00-07:00', 'America/New_York'), '2025-04-09');
    assert.equal(utcToZoneDate('2025-04-08T23:30:00Z', 'America/New_York'), '2025-04-08');
    assert.equal(utcToZoneDate('2025-04-08 23:30:00 +0000', 'Asia/Kolkata'), '2025-04-09');
    assert.equal(utcToZoneDate('2025-03-09 10:00:00', 'America/Los_Angeles'), '2025-03-09');
  });
  test('a Stripe file re-saved by Excel is not converted and says so', () => {
    const s = parse('stripe-balance', 'id,Type,Source,Amount,Fee,Net,Currency,Created (UTC),Available On (UTC),Description\ntxn_1AAAAAAAAAA,charge,ch_1AAAAAAAA,10.00,0.59,9.41,usd,7/1/2025 2:12,7/3/2025 0:00,x\n', { timeZone: 'America/Los_Angeles' });
    assert.equal(s.transactions[0].date, '2025-07-01');
    assert.ok(s.warnings.some((w) => /re-saved in a spreadsheet/.test(w)));
    assert.match(s.meta.timeZone, /not converted/);
  });
});

describe('C1: a won chargeback reverses against sales, not payments sent', () => {
  test('PayPal Chargeback Reversal', () => {
    const pp = PH + ['"03/05/2025","10:00:00","PST","Buyer","Express Checkout Payment","Completed","USD","100.00","-3.79","96.21","P1","","Credit"',
      '"03/15/2025","10:00:00","PST","Buyer","Chargeback","Completed","USD","-100.00","0.00","-100.00","P2","P1","Debit"',
      '"03/20/2025","10:00:00","PST","Buyer","Chargeback Reversal","Completed","USD","100.00","0.00","100.00","P3","P1","Credit"'].join('\n') + '\n';
    const [s] = summarizePayouts(parse('paypal', pp).transactions, { groupBy: 'month' });
    assert.deepEqual([s.grossSales, s.refunds, s.paymentsSent], [100, 0, 0]);
  });
  test('Cash App received payment with status REFUNDED is the original sale', () => {
    const ca = CH + '"2026-01-20 09:30:00 EST","#A2","Received P2P","USD","$50.00","$0.00","$50.00","","","","PAYMENT REFUNDED","Gig","Lee C","Cash Balance"\n';
    assert.equal(parse('cashapp', ca).transactions[0].type, 'payment');
  });
});

describe('F1/F2: ambiguity never dead-ends when the caller gave a value', () => {
  test('comma-delimited US file with quoted "1,000" reads thousands', () => {
    const r = parse('generic-bank', 'Date,Description,Amount\n01/15/2025,Rent,"-1,000"\n01/16/2025,Pay,"2,500"\n');
    assert.deepEqual(r.transactions.map((t) => t.amount), [-1000, 2500]);
  });
  test('short US statement with dateOrder given: proceeds, marked assumed, sample with both readings', () => {
    const r = parse('generic-bank', 'Date,Description,Amount\n04/01/2025,A,-5.00\n04/02/2025,B,-6.00\n04/10/2025,C,7.00\n', { dateOrder: 'mdy' });
    assert.equal(r.transactions[2].date, '2025-04-10');
    assert.equal(r.meta.dateOrderAssumed, true);
    const s = r.meta.assumptionSamples.find((x) => x.kind === 'dateOrder');
    assert.deepEqual(s.readings, [{ dateOrder: 'mdy', date: '2025-04-01' }, { dateOrder: 'dmy', date: '2025-01-04' }]);
    assert.ok(r.warnings.some((w) => /Please confirm/.test(w)));
  });
  test('the engine fixture generic-bank-signed.csv converts with dateOrder', () => {
    const out = convert('auto', readFixture('generic-bank-signed.csv'), 'qbo', { dateOrder: 'mdy' });
    assert.equal(out.meta.dateOrderAssumed, true);
    assert.throws(() => parse('auto', readFixture('generic-bank-signed.csv')), (e) => e instanceof EngineError && e.code === 'AMBIGUOUS_DATE_ORDER');
  });
  test('decimal given for ambiguous amounts: proceeds and is marked assumed', () => {
    const r = parse('generic-bank', 'Date;Description;Amount\n15.01.2025;Rent;-1.000\n16.01.2025;Salary;2.500\n', { decimal: ',' });
    assert.deepEqual(r.transactions.map((t) => t.amount), [-1000, 2500]);
    assert.equal(r.meta.decimalAssumed, true);
    assert.deepEqual(r.meta.assumptionSamples[0].readings, [{ decimal: '.', amount: -1 }, { decimal: ',', amount: -1000 }]);
  });
  test('platform exports with fixed formats never raise', () => {
    const r = parse('stripe-balance', 'balance_transaction_id,created,currency,gross,fee,net,reporting_category\ntxn_1AAAAAAAA,2025-01-02,jpy,1.000,0,1.000,charge\n');
    assert.equal(r.transactions[0].amount, 1);
    assert.equal(r.meta.decimalAssumed, true);
  });
});

describe('S8: skipped pending transfers are listed', () => {
  test('PayPal pending General Withdrawal', () => {
    const r = parse('paypal', PH + '"03/21/2025","10:00:00","PST","","General Withdrawal","Pending","USD","-90.00","0.00","-90.00","P4","","Debit"\n"03/22/2025","10:00:00","PST","A","Website Payment","Completed","USD","10.00","0.00","10.00","P5","","Credit"\n');
    assert.ok(r.warnings.some((w) => /pending transfer.*2025-03-21 -90\.00 \(General Withdrawal\).*export this period again/.test(w)));
    assert.deepEqual(r.meta.pendingTransfers, [{ date: '2025-03-21', amount: -90, description: 'General Withdrawal' }]);
  });
  test('Cash App pending cash out and Venmo pending transfer', () => {
    const ca = CH + '"2026-01-22 09:30:00 EST","#A1","Withdrawal","USD","-$100.00","$0.00","-$100.00","","","","PENDING","Cash Out","","SAMPLE BANK"\n"2026-01-20 09:30:00 EST","#A2","P2P","USD","$200.00","$0.00","$200.00","","","","COMPLETE","Gig","Lee C","Cash Balance"\n';
    assert.ok(parse('cashapp', ca).warnings.some((w) => /2026-01-22 -100\.00/.test(w)));
    const v = venmo([vr('1001', '2025-03-05T18:00:00', 'Standard Transfer', 'Pending', '', '', '', '- $100.00', '', '', 'BANK *1'), vr('1002', '2025-03-06T18:00:00', 'Payment', 'Complete', 'x', 'Lee', 'Pat Example', '+ $5.00', '', '', 'Venmo balance')]);
    assert.ok(v.warnings.some((w) => /pending transfer.*-100\.00/.test(w)));
  });
});
