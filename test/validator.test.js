// Self-test of the independent validators: they must catch broken files,
// otherwise a passing matrix test means nothing.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { write } from '../index.js';
import { validateOfx } from '../test-support/ofx-validator.js';
import { checkQboCsv, checkJournal, checkXeroCsv } from '../test-support/csv-checks.js';

const txns = [
  { date: '2025-01-02', description: 'Coffee & cake', amount: -4.5, currency: 'USD', type: 'payment', raw: {} },
  { date: '2025-01-03', description: 'Client', amount: 100, currency: 'USD', type: 'payment', raw: {} },
];
const good = write('qbo', txns).content;

function errs(text, expect) { return validateOfx(text, expect).errors.join(' | '); }

describe('OFX validator catches', () => {
  test('a good file passes', () => assert.equal(errs(good, { intuBid: '3000', sumCents: 9550, count: 2 }), ''));
  test('missing LEDGERBAL', () => assert.match(errs(good.replace(/<LEDGERBAL>[\s\S]*?<\/LEDGERBAL>\r\n/, '')), /missing required <LEDGERBAL>/));
  test('duplicate FITID', () => {
    const ids = [...good.matchAll(/<FITID>([^<]+)</g)].map((m) => m[1]);
    assert.match(errs(good.replace(ids[1], ids[0])), /Duplicate FITID/);
  });
  test('bad DTPOSTED', () => assert.match(errs(good.replace('<DTPOSTED>20250102120000', '<DTPOSTED>2025-01-02')), /DTPOSTED/));
  test('impossible date', () => assert.match(errs(good.replace('<DTPOSTED>20250102120000', '<DTPOSTED>20250230120000')), /DTPOSTED/));
  test('NAME over 32 chars', () => assert.match(errs(good.replace('<NAME>Client</NAME>', '<NAME>' + 'X'.repeat(33) + '</NAME>')), /NAME must be 1-32/));
  test('unescaped ampersand', () => assert.match(errs(good.replace('Coffee &amp; cake', 'Coffee & cake')), /Unescaped &/));
  test('thousands separator in amount', () => assert.match(errs(good.replace('<TRNAMT>100.00', '<TRNAMT>1,100.00')), /TRNAMT/));
  test('sign mismatch with TRNTYPE', () => assert.match(errs(good.replace('<TRNAMT>100.00', '<TRNAMT>-100.00')), /CREDIT with negative/));
  test('wrong header order', () => assert.match(errs(good.replace('DATA:OFXSGML\r\nVERSION:102', 'VERSION:102\r\nDATA:OFXSGML')), /Header line 2/));
  test('missing blank line after header', () => assert.match(errs(good.replace('NEWFILEUID:NONE\r\n\r\n', 'NEWFILEUID:NONE\r\n')), /blank line/));
  test('mismatched closing tag', () => assert.match(errs(good.replace('</BANKTRANLIST>', '</BANKTRANLISTX>')), /does not match/));
  test('non-ASCII byte', () => assert.match(errs(good.replace('Client', 'Cliént')), /Non-ASCII/));
  test('out-of-order elements', () => assert.match(errs(good.replace(/<CURDEF>USD<\/CURDEF>\r\n(<BANKACCTFROM>[\s\S]*?<\/BANKACCTFROM>)/, '$1\r\n<CURDEF>USD</CURDEF>')), /out of spec order/));
  test('wrong total', () => assert.match(errs(good, { sumCents: 1 }), /expected 1/));
  test('INTU.BID present in generic OFX', () => assert.match(errs(good, { intuBid: null }), /must not carry INTU.BID/));
  test('LF-only header', () => assert.match(errs(good.replace(/\r\n/g, '\n')), /bare LF/));
});

describe('CSV checkers catch', () => {
  test('currency symbol in QBO amount', () => assert.ok(checkQboCsv('Date,Description,Amount\r\n01/02/2025,X,$4.50\r\n').errors.length));
  test('zero in 4-col unused side', () => assert.ok(checkQboCsv('Date,Description,Credit,Debit\r\n01/02/2025,X,4.50,0\r\n', { columns: 4 }).errors.length));
  test('LF line endings', () => assert.ok(checkQboCsv('Date,Description,Amount\n01/02/2025,X,4.50\n').errors.length));
  test('numeric-only description', () => assert.ok(checkQboCsv('Date,Description,Amount\r\n01/02/2025,12345,4.50\r\n').errors.length));
  test('wrong Xero header', () => assert.ok(checkXeroCsv('Date,Amount,Payee,Description,Reference\r\n01/02/2025,1.00,A,B,C\r\n').errors.length));
  test('unbalanced journal', () => {
    const t = 'Journal No.,Journal Date,Account Name,Debits,Credits,Description,Name\r\nJ1,01/02/2025,Bank,10.00,,x,\r\nJ1,01/02/2025,Sales,,9.99,x,\r\n';
    assert.match(checkJournal(t).errors.join(' '), /does not balance/);
  });
});
