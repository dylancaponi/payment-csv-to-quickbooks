import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse, write, detectSource, convert, summarizePayouts, EngineError, SOURCES, TARGETS } from '../index.js';
import { readFixture } from '../test-support/fixtures.js';
import { validateOfx } from '../test-support/ofx-validator.js';
import { checkQboCsv, checkJournal } from '../test-support/csv-checks.js';

const isEngineError = (code) => (e) => e instanceof EngineError && (!code || e.code === code) && typeof e.message === 'string' && e.message.length > 20;

describe('wrong or unrecognized files give human errors', () => {
  test('PDF', () => {
    assert.match(detectSource('%PDF-1.7\n...').reason, /PDF/);
    assert.throws(() => parse('auto', '%PDF-1.7\n'), isEngineError('NOT_CSV'));
  });
  test('xlsx/zip', () => assert.match(detectSource('PK\u0003\u0004rest').reason, /Excel/));
  test('already OFX', () => assert.match(detectSource('OFXHEADER:100\r\nDATA:OFXSGML\r\n').reason, /already/));
  test('empty file', () => {
    assert.equal(detectSource('').sourceId, null);
    assert.throws(() => parse('venmo', '   \n'), isEngineError('NOT_CSV'));
  });
  test('unrelated CSV', () => {
    const d = detectSource('name,email\nAda,ada@example.com\n');
    assert.equal(d.sourceId, null);
    assert.match(d.reason, /recognize/);
    assert.throws(() => parse('auto', 'name,email\nAda,ada@example.com\n'), isEngineError('UNRECOGNIZED'));
  });
  test('wrong source chosen explains how to export the right file', () => {
    assert.throws(() => parse('venmo', readFixture('paypal-us.csv')), (e) => isEngineError('WRONG_SOURCE')(e) && /venmo\.com/.test(e.message));
    assert.throws(() => parse('cashapp', readFixture('venmo-2025.csv')), isEngineError('WRONG_SOURCE'));
    for (const s of ['paypal', 'stripe-balance', 'etsy', 'airbnb', 'gumroad']) assert.throws(() => parse(s, readFixture('cashapp-2026.csv')), isEngineError('WRONG_SOURCE'));
  });
  test('unknown ids', () => {
    assert.throws(() => parse('nope', 'a,b\n'), isEngineError('UNKNOWN_SOURCE'));
    assert.throws(() => write('nope', [{ date: '2025-01-01', amount: 1, description: 'x', currency: 'USD', raw: {} }]), isEngineError('UNKNOWN_TARGET'));
  });
  test('writer rejects empty or invalid transactions', () => {
    assert.throws(() => write('qbo', []), isEngineError('NO_TRANSACTIONS'));
    assert.throws(() => write('qbo', [{ date: '2025-02-30', amount: 1, description: 'x' }]), isEngineError('BAD_TXN'));
    assert.throws(() => write('qbo', [{ date: '2025-02-03', amount: 'x', description: 'x' }]), isEngineError('BAD_TXN'));
    assert.throws(() => write('qbo', [{ date: '2025-02-03', amount: 1, description: 'x' }], { accountType: 'bitcoin' }), isEngineError('BAD_OPTION'));
  });
  test('truncated file with an open quote', () => {
    assert.throws(() => parse('paypal', '"Date","Name","Type","Status","Currency","Gross","Fee","Net"\n"01/02/2025","Oops'), isEngineError('UNTERMINATED_QUOTE'));
  });
  test('amount too large for QuickBooks', () => {
    assert.throws(() => write('qbo', [{ date: '2025-01-01', amount: 1234567890.12, description: 'Big', currency: 'USD', raw: {} }]), isEngineError('AMOUNT_TOO_LARGE'));
  });
});

describe('empty amounts and junk rows', () => {
  test('generic: blank amount rows are skipped with a warning', () => {
    const r = parse('generic-bank', 'Date,Description,Amount\n2025-01-02,Thing,\n2025-01-03,Other,5.00\n2025-01-04,Bad,abc\n');
    assert.equal(r.transactions.length, 1);
    assert.equal(r.meta.rowsSkipped, 2);
    assert.ok(r.warnings.some((w) => /no amount/.test(w)));
    assert.ok(r.warnings.some((w) => /could not read the amount/.test(w)));
  });
  test('file with headers but no rows yields an empty result and a warning', () => {
    const r = parse('paypal', '"Date","Time","TimeZone","Name","Type","Status","Currency","Gross","Fee","Net","Transaction ID"\n');
    assert.equal(r.transactions.length, 0);
    assert.ok(r.warnings.some((w) => /No transactions/.test(w)));
  });
});

describe('FITIDs', () => {
  test('deterministic across runs and identical between QBO and QFX', () => {
    const txns = parse('venmo', readFixture('venmo-2025.csv')).transactions;
    const ids = (c) => [...c.matchAll(/<FITID>([^<]+)</g)].map((m) => m[1]);
    const a = ids(write('qbo', txns).content);
    const b = ids(write('qbo', parse('venmo', readFixture('venmo-2025.csv')).transactions).content);
    const q = ids(write('qfx', txns).content);
    assert.deepEqual(a, b);
    assert.deepEqual(a, q);
    assert.equal(new Set(a).size, a.length);
    for (const id of a) assert.match(id, /^[0-9A-F]{16}$/);
  });
  test('exact duplicate rows without ids get distinct but stable FITIDs', () => {
    const text = 'Date,Description,Amount\n2025-01-02,Coffee,-3.00\n2025-01-02,Coffee,-3.00\n2025-01-02,Coffee,-3.00\n';
    const run = () => [...write('qbo', parse('generic-bank', text).transactions).content.matchAll(/<FITID>([^<]+)</g)].map((m) => m[1]);
    const a = run();
    assert.equal(new Set(a).size, 3);
    assert.deepEqual(a, run());
  });
  test('row order in the input does not change ids of rows with source ids', () => {
    const txns = parse('stripe-balance', readFixture('stripe-balance-history.csv')).transactions;
    const map = (list) => Object.fromEntries([...write('ofx', list).content.matchAll(/<FITID>([^<]+)<\/FITID>\r\n<NAME>([^<]+)</g)].map((m) => [m[2] + m[1], m[1]]));
    assert.deepEqual(map(txns), map([...txns].reverse()));
  });
  test('an overlapping later export reuses FITIDs for the shared rows', () => {
    const full = parse('cashapp', readFixture('cashapp-2026.csv')).transactions;
    const ids = (l) => new Set([...write('qbo', l).content.matchAll(/<FITID>([^<]+)</g)].map((m) => m[1]));
    const all = ids(full);
    const later = ids(full.slice(2));
    for (const id of later) assert.ok(all.has(id));
  });
});

describe('fees as separate rows', () => {
  test('split keeps totals and makes gross + fee lines', () => {
    const txns = parse('stripe-payouts', readFixture('stripe-payout-reconciliation.csv')).transactions;
    const plain = write('qbo-csv-3', txns);
    const split = write('qbo-csv-3', txns, { includeFeesAsSeparateRows: true });
    const a = checkQboCsv(plain.content);
    const b = checkQboCsv(split.content);
    assert.equal(a.sumCents, b.sumCents);
    assert.equal(b.rows.length, a.rows.length + 4);
    assert.ok(b.rows.some((r) => r[1].startsWith('Fee:') && r[2] === '-3.26'));
  });
});

describe('credit card accounts', () => {
  test('creditcard account type uses CREDITCARDMSGSRSV1 and CCACCTFROM', () => {
    const txns = parse('generic-bank', readFixture('generic-bank-signed.csv'), { dateOrder: 'mdy' }).transactions;
    const out = write('qbo', txns, { accountType: 'creditcard', accountId: '4111-0000-1111' });
    const v = validateOfx(out.content, { kind: 'cc', intuBid: '3000' });
    assert.deepEqual(v.errors, []);
    assert.match(out.content, /<CCACCTFROM>\r\n<ACCTID>4111-0000-1111<\/ACCTID>\r\n<\/CCACCTFROM>/);
    assert.doesNotMatch(out.content, /BANKACCTFROM|ACCTTYPE/);
  });
});

describe('options', () => {
  const txns = parse('generic-bank', readFixture('generic-bank-signed.csv'), { dateOrder: 'mdy' }).transactions;
  test('intuBid, bankName, accountId, ledgerBalance, CAD', () => {
    const out = write('qbo', txns.map((t) => ({ ...t, currency: 'CAD' })), { intuBid: '2', bankName: 'Caisse Démo & Co', accountId: 'ACC-1', ledgerBalance: 1282.95 });
    const v = validateOfx(out.content, { intuBid: '2', currency: 'CAD' });
    assert.deepEqual(v.errors, []);
    assert.match(out.content, /<ORG>Caisse Demo &amp; Co<\/ORG>/);
    assert.match(out.content, /<BALAMT>1282.95</);
    assert.ok(!out.warnings.some((w) => /US dollar/.test(w)));
  });
  test('non-USD QBO warns', () => {
    const out = write('qbo', txns.map((t) => ({ ...t, currency: 'EUR' })));
    assert.ok(out.warnings.some((w) => /US dollar/.test(w)));
  });
  test('date formats for CSV targets', () => {
    const out = write('qbo-csv-3', txns, { dateFormat: 'DD/MM/YYYY' });
    assert.deepEqual(checkQboCsv(out.content, { dateFormat: 'DD/MM/YYYY' }).errors, []);
    assert.match(write('xero-csv', txns, { region: 'UK' }).content, /^\*Date,\*Amount,Payee,Description,Reference,Cheque Number\r\n02\/04\/2025|^\*Date,\*Amount,Payee,Description,Reference,Cheque Number\r\n01\/04\/2025/);
    assert.throws(() => write('qbo-csv-3', txns, { dateFormat: 'YY/MM' }), isEngineError('BAD_OPTION'));
  });
  test('NAME is truncated to 32 and special characters escaped/folded', () => {
    const out = write('qbo', [{ date: '2025-01-01', amount: -1, description: 'A very long merchant name that keeps going & going <and> going', currency: 'USD', raw: {} }]);
    const v = validateOfx(out.content);
    assert.deepEqual(v.errors, []);
    assert.equal(v.stmttrns[0].name.length <= 32, true);
    assert.match(v.stmttrns[0].memo, /& going <and> going/);
  });
  test('journal accounts, prefix and month grouping', () => {
    const out = write('qbo-journal', parse('venmo', readFixture('venmo-2025.csv')).transactions, { groupBy: 'month', journalPrefix: 'VEN', accounts: { bank: 'Chase Checking', clearing: 'Venmo Clearing' }, sourceId: 'venmo' });
    const v = checkJournal(out.content);
    assert.deepEqual(v.errors, []);
    assert.ok([...v.entries.keys()].every((k) => k.startsWith('VEN-')));
    const lines = [...v.entries.values()][0].lines;
    assert.ok(lines.some((l) => l.account === 'Venmo Clearing'));
  });
});

describe('summarizePayouts', () => {
  test('rejects bad groupBy and explains missing payout ids', () => {
    const txns = parse('venmo', readFixture('venmo-2025.csv')).transactions;
    assert.throws(() => summarizePayouts(txns, { groupBy: 'week' }), isEngineError('BAD_OPTION'));
    assert.throws(() => summarizePayouts(txns, { groupBy: 'payout' }), isEngineError('NO_PAYOUT_IDS'));
  });
  test('every row: components add up to activity, activity = payout + difference', () => {
    for (const [s, f, g] of [['stripe-balance', 'stripe-balance-history.csv', 'payout'], ['airbnb', 'airbnb-paid.csv', 'payout'], ['etsy', 'etsy-statement-2025-3.csv', 'month'], ['paypal', 'paypal-us.csv', 'month']]) {
      for (const r of summarizePayouts(parse(s, readFixture(f)).transactions, { groupBy: g })) {
        const c = (x) => Math.round(x * 100);
        assert.equal(c(r.grossSales) + c(r.refunds) + c(r.fees) + c(r.taxes) + c(r.adjustments) + c(r.paymentsSent), c(r.netActivity), `${f} ${r.key}`);
        assert.equal(c(r.payoutAmount) + c(r.transfersToBank) - c(r.transfersFromBank) + c(r.difference), c(r.netActivity));
        assert.ok(r.grossSales >= 0, 'gross sales never negative');
      }
    }
  });
});

describe('large files', () => {
  function bigVenmo(n) {
    const head = 'Account Statement - (@Big-Test) ,,,,,,,,,,,,,,,,,,,,,\r\nAccount Activity,,,,,,,,,,,,,,,,,,,,,\r\n,ID,Datetime,Type,Status,Note,From,To,Amount (total),Amount (tip),Amount (tax),Amount (fee),Tax Rate,Tax Exempt,Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,Terminal Location,Year to Date Venmo Fees,Disclaimer\r\n';
    let body = '';
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const cents = ((i * 7919) % 50000) + 1;
      const sign = i % 3 === 0 ? '-' : '+';
      sum += sign === '-' ? -cents : cents;
      const amt = `${sign} $${Math.floor(cents / 100).toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')}`;
      const day = String((i % 28) + 1).padStart(2, '0');
      body += `,${5000000000000000000n + BigInt(i)},2025-01-${day}T10:00:00,Payment,Complete,"Note ${i}, with comma",Person ${i % 40},Big Test,"${amt}",,0,,0,,${sign === '-' ? 'Venmo balance' : ''},${sign === '+' ? 'Venmo balance' : ''},,,,Venmo,,\r\n`;
    }
    return { text: head + body, sum };
  }
  test('5,000-row file parses and writes every target quickly; QBO Online parts are produced', () => {
    const { text, sum } = bigVenmo(5000);
    const t0 = performance.now();
    const r = parse('auto', text);
    assert.equal(r.transactions.length, 5000);
    assert.equal(r.transactions.reduce((s, t) => s + Math.round(t.amount * 100), 0), sum);
    const outs = {};
    for (const t of TARGETS) outs[t.id] = write(t.id, r.transactions, { groupBy: 'month' });
    const ms = performance.now() - t0;
    assert.ok(ms < 5000, `took ${ms}ms`);
    const v = validateOfx(outs.qbo.content, { sumCents: sum, count: 5000 });
    assert.deepEqual(v.errors, []);
    assert.ok(outs.qbo.parts.length >= 5);
    let partSum = 0; let partCount = 0;
    for (const p of outs.qbo.parts) {
      assert.ok(new TextEncoder().encode(p.content).length <= 350 * 1024);
      const pv = validateOfx(p.content);
      assert.deepEqual(pv.errors, []);
      partSum += pv.sumCents; partCount += pv.stmttrns.length;
      assert.ok(pv.stmttrns.length <= 1000);
    }
    assert.equal(partSum, sum);
    assert.equal(partCount, 5000);
    assert.ok(outs['qbo-csv-3'].parts.length >= 5);
    let csvSum = 0;
    const dayPart = new Map();
    outs['qbo-csv-3'].parts.forEach((p, i) => {
      const c = checkQboCsv(p.content, { maxRows: 1000 });
      assert.deepEqual(c.errors, []);
      csvSum += c.sumCents;
      for (const r of c.rows) { if (dayPart.has(r[0])) assert.equal(dayPart.get(r[0]), i, `day ${r[0]} split across parts`); dayPart.set(r[0], i); }
    });
    assert.equal(csvSum, sum);
    // Split QBO parts carry running balances that end at the full file's balance.
    const bals = outs.qbo.parts.map((p) => Number(/<BALAMT>([^<]+)/.exec(p.content)[1]));
    assert.equal(Math.round(bals[bals.length - 1] * 100), sum);
    let running = 0;
    outs.qbo.parts.forEach((p, i) => { running += validateOfx(p.content).sumCents; assert.equal(Math.round(bals[i] * 100), running); });
  });
});

describe('catalog', () => {
  test('SOURCES and TARGETS have the contract shape', () => {
    for (const s of SOURCES) {
      for (const k of ['id', 'name', 'vendor', 'fileHint', 'sampleHeader']) assert.equal(typeof s[k], 'string', `${s.id}.${k}`);
      assert.ok(Array.isArray(s.howToExport) && s.howToExport.length);
      assert.ok(Array.isArray(s.quirks) && s.quirks.length);
      assert.doesNotThrow(() => detectSource(s.sampleHeader + '\n'));
    }
    for (const t of TARGETS) {
      for (const k of ['id', 'name', 'software', 'extension', 'mime']) assert.equal(typeof t[k], 'string', `${t.id}.${k}`);
      assert.ok(t.howToImport.length && t.requirements.length);
    }
  });
  test('no em dashes in user-facing text', () => {
    const all = JSON.stringify([SOURCES, TARGETS]);
    assert.equal(all.includes('\u2014'), false);
  });
  test('convert() one-shot', () => {
    const r = convert('auto', readFixture('gumroad-payout.csv'), 'qbo-journal');
    assert.equal(r.meta.sourceId, 'gumroad');
    assert.deepEqual(checkJournal(r.content).errors, []);
  });
});
