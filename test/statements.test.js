// MT940 and camt.053 bank statements: money rules, refusals, dialects,
// multi-account files, FITIDs and the spreadsheet CSV target.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse, write, detectSource, convert } from '../index.js';
import { readFixture, centsOf } from '../test-support/fixtures.js';
import { validateOfx } from '../test-support/ofx-validator.js';
import { checkSpreadsheetCsv } from '../test-support/csv-checks.js';
import { parseXml } from '../src/xml.js';
import { statementAcctId } from '../src/targets/ofx.js';

const cents = (t) => Math.round(t.amount * 100);

function mt(lines61, { open = 'C251201EUR100,00', close = 'C251231EUR100,00', account = 'DE89370400440532013000', num = '1/1', ref = 'REF1' } = {}) {
  return [`:20:${ref}`, `:25:${account}`, `:28C:${num}`, `:60F:${open}`, ...lines61, `:62F:${close}`, '-'].join('\r\n') + '\r\n';
}

describe('MT940 money rules', () => {
  test('D, C, RD, RC marks and the optional funds code letter give the right sign', () => {
    const t = mt([':61:2512011201C10,00NTRFNONREF', ':61:2512011201D2,50NTRFNONREF', ':61:2512011201RD1,00NTRFNONREF', ':61:2512011201RC4,00NTRFNONREF', ':61:2512011201CR5,00NTRFNONREF', ':61:2512011201DR0,50NTRFNONREF', ':61:2512011201RCR0,25NMSCNONREF'],
      { close: 'C251231EUR108,75' });
    const r = parse('mt940', t);
    assert.deepEqual(r.transactions.map(cents), [1000, -250, 100, -400, 500, -50, -25]);
    assert.equal(r.meta.reconciled, true);
    assert.ok(r.transactions[2].description.startsWith('Reversal'));
  });
  test('decimal comma amounts, including "289," and leading zeros', () => {
    const r = parse('mt940', mt([':61:2512011201D289,NTRFNONREF', ':61:2512011201C000000000300,5NTRFNONREF'], { close: 'C251231EUR111,50' }));
    assert.deepEqual(r.transactions.map(cents), [-28900, 30050]);
    assert.equal(r.meta.reconciled, true);
  });
  test('a negative (D) opening balance is read as negative', () => {
    const r = parse('mt940', mt([':61:2512011201C50,00NTRFNONREF'], { open: 'D251201EUR100,00', close: 'D251231EUR50,00' }));
    assert.equal(r.meta.openingBalance, -100);
    assert.equal(r.meta.reconciled, true);
    assert.equal(r.transactions[0].balance, -50);
  });
  test('entry date year rollover around New Year, both directions', () => {
    const r = parse('mt940', mt([':61:2512310102C1,00NTRFA', ':61:2601021231C1,00NTRFB', ':61:2506150616C1,00NTRFC', ':61:251231C1,00NTRFD'], { close: 'C251231EUR104,00' }));
    assert.deepEqual(r.transactions.map((t) => [t.date, t.valueDate]), [
      ['2026-01-02', '2025-12-31'], ['2025-12-31', '2026-01-02'], ['2025-06-16', '2025-06-15'], ['2025-12-31', '2025-12-31'],
    ]);
  });
  test('currency comes from the balance, never assumed', () => {
    const r = parse('mt940', mt([':61:2512011201C1,00NTRFX'], { open: 'C251201CHF1,00', close: 'C251231CHF2,00' }));
    assert.equal(r.transactions[0].currency, 'CHF');
    const noOpen = ':20:X\r\n:25:123\r\n:28C:1\r\n:61:2512011201C1,00NTRFX\r\n:62F:C251231CHF2,00\r\n';
    assert.throws(() => parse('mt940', noOpen), (e) => e.code === 'WRONG_SOURCE' || e.code === 'BAD_FILE');
  });
  test('a statement that does not add up warns loudly and still converts', () => {
    const r = parse('mt940', mt([':61:2512011201C10,00NTRFX'], { close: 'C251231EUR999,00' }));
    assert.equal(r.meta.reconciled, false);
    assert.ok(r.warnings.some((w) => w.startsWith('WARNING: statement 1/1') && w.includes('difference 889.00')));
    assert.equal(r.meta.statements[0].reconciled, false);
  });
  test('an unreadable :61: line is skipped with a warning, and the balance check shows it', () => {
    const r = parse('mt940', mt([':61:2512011201C10.00NTRFX', ':61:2512011201C5,00NTRFY'], { close: 'C251231EUR115,00' }));
    assert.equal(r.transactions.length, 1);
    assert.ok(r.warnings.some((w) => w.includes('could not read')));
    assert.ok(r.warnings.some((w) => w.startsWith('WARNING:')));
  });
  test('the published samples: Rabobank and German reconcile, ING does not (as published); the constructed ABN AMRO file reconciles', () => {
    assert.equal(parse('mt940', readFixture('mt940-rabobank-gist.sta')).meta.reconciled, true);
    const de = parse('mt940', readFixture('mt940-german-sepa.sta'));
    assert.ok(de.meta.statements.every((s) => s.reconciled === true));
    assert.equal(centsOf(de.transactions), Math.round((de.meta.closingBalance - de.meta.openingBalance) * 100));
    assert.equal(parse('mt940', readFixture('mt940-ing-sample.sta')).meta.reconciled, false);
    assert.equal(parse('mt940', readFixture('mt940-abnamro.sta')).meta.reconciled, true);
  });
  test('statements missing between two statements are reported', () => {
    const a = mt([':61:2512011201C1,00NTRFX'], { close: 'C251201EUR101,00', num: '1' });
    const b = mt([':61:2512031203C1,00NTRFY'], { open: 'C251202EUR200,00', close: 'C251203EUR201,00', num: '3', ref: 'R3' });
    const r = parse('mt940', a + b);
    assert.ok(r.warnings.some((w) => w.includes('statements are missing')));
    assert.equal(r.meta.reconciled, false);
  });
  test('an exact repeat of a statement is read once', () => {
    const a = mt([':61:2512011201C1,00NTRFX'], { close: 'C251231EUR101,00' });
    const r = parse('mt940', a + a);
    assert.equal(r.transactions.length, 1);
    assert.ok(r.warnings.some((w) => w.includes('exact repeat')));
  });
  test('SWIFT envelope blocks are ignored', () => {
    const t = '{1:F01INGBNL2ABXXX0000000000}{2:I940INGBNL2AXXXN}{3:{108:X}}{4:\r\n' + mt([':61:2512011201C1,00NTRFX'], { close: 'C251231EUR101,00' }).replace('-\r\n', '-}\r\n');
    assert.equal(parse('auto', t).transactions.length, 1);
  });
});

describe('MT940 :86: dialects', () => {
  test('German ?NN subfields with SEPA keywords', () => {
    const t = mt([':61:2512011201D12,34NDDTNONREF', ':86:105?00SEPA-BASIS-LASTSCHRIFT?100599?20EREF+INV-77?21MREF+M1?22SVWZ+Rechnung 77 vom 01.1?232.2025?30BYLADEM1001?31DE02120300000000202051?32Stadtwerke Muster?33stadt GmbH?34992'],
      { close: 'C251231EUR87,66' });
    const x = parse('mt940', t).transactions[0];
    assert.equal(x.description, 'Rechnung 77 vom 01.12.2025');
    assert.equal(x.reference, 'INV-77');
    assert.equal(x.counterparty, 'Stadtwerke Musterstadt GmbH');
    assert.equal(x.counterpartyAccount, 'DE02120300000000202051');
  });
  test('ING /CNTP/ with an empty account part and /REMI/USTD//', () => {
    const t = mt([':61:2503170317C1166,88NTRFEREF//03174451128490', '/TRCD/00100/', ':86:/EREF/Reglement factures courtilleurs//CNTP//CMCIFR2A/SACOS JAVIE', 'R SAS///REMI/USTD//SACOS JAVIER H32302/'],
      { open: 'C250317EUR0,00', close: 'C250317EUR1166,88' });
    const x = parse('mt940', t).transactions[0];
    assert.equal(x.counterparty, 'SACOS JAVIER SAS');
    assert.equal(x.counterpartyAccount, undefined);
    assert.equal(x.description, 'SACOS JAVIER H32302');
    assert.equal(x.reference, 'Reglement factures courtilleurs');
  });
  test('ING sample: name wrapped at the 65-character limit, structured reference', () => {
    const r = parse('mt940', readFixture('mt940-ing-sample.sta'));
    assert.equal(r.transactions[1].counterparty, 'ING Testrekening');
    assert.equal(r.transactions[0].counterpartyAccount, 'NL08INGB0000001234');
    assert.equal(r.transactions[0].reference, 'E2E2014030100899040');
    assert.equal(r.meta.account, 'NL20INGB0001234567');
  });
  test('Rabobank: /ORDP//NAME/, counterparty IBAN on the second :61: line, wrapped REMI', () => {
    const r = parse('mt940', readFixture('mt940-rabobank-gist.sta'));
    const x = r.transactions[0];
    assert.equal(x.counterparty, 'Hr J DOE');
    assert.equal(x.counterpartyAccount, 'NL75INGB0001234567');
    assert.equal(x.description, 'bijdrage februari 2014');
    assert.equal(r.meta.account, 'NL68RABO0123456789');
    const kosten = r.transactions.find((t) => t.amount === -25.4);
    assert.equal(kosten.description, 'Periode 01-01-2015 t/m 31-03-2015');
  });
  test('free text is kept as the description', () => {
    const x = parse('mt940', readFixture('mt940-abnamro.sta')).transactions[0];
    assert.match(x.description, /^GIRO 500500 VOORBEELD ENERGIE BV/);
  });
});

describe('MT940 and camt.053: accounts, refusals, FITIDs', () => {
  test('multi-account file: one account converted, the others named, option picks another', () => {
    const t = readFixture('mt940-german-sepa.sta');
    const r = parse('mt940', t);
    assert.equal(r.meta.accounts.length, 20);
    assert.ok(r.warnings.some((w) => w.includes('holds 20 accounts') && w.includes('0194774600888')));
    assert.ok(r.transactions.every((x) => x.account === r.meta.account));
    const other = parse('mt940', t, { account: '50880050/0194777100888' });
    assert.equal(other.transactions.length, 2);
    assert.equal(other.meta.account, '50880050/0194777100888');
    assert.throws(() => parse('mt940', t, { account: 'NL00NOPE' }), (e) => e.code === 'BAD_OPTION' && e.details.accounts.length === 20);
  });
  test('two currencies in one camt file are not merged', () => {
    const t = readFixture('camt053-multi.xml');
    const r = parse('camt053', t);
    assert.ok(r.transactions.every((x) => x.currency === 'EUR'));
    assert.ok(r.warnings.some((w) => w.includes('123456789 USD')));
    const usd = parse('camt053', t, { account: '123456789 USD' });
    assert.deepEqual(usd.transactions.map(cents), [2500]);
    assert.equal(usd.meta.openingBalance, -10);
    assert.equal(usd.meta.reconciled, true);
  });
  test('refusals name the format', () => {
    const d = detectSource(readFixture('mt942-mbank.sta'));
    assert.equal(d.sourceId, null);
    assert.match(d.reason, /MT942/);
    const wrap = (root, ns) => `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:${ns}"><${root}></${root}></Document>`;
    assert.match(detectSource(wrap('BkToCstmrAcctRpt', 'camt.052.001.02')).reason, /camt\.052/);
    assert.match(detectSource(wrap('BkToCstmrDbtCdtNtfctn', 'camt.054.001.02')).reason, /camt\.054/);
    assert.match(detectSource(wrap('CstmrCdtTrfInitn', 'pain.001.001.03')).reason, /pain\.001/);
    assert.throws(() => parse('camt053', wrap('BkToCstmrAcctRpt', 'camt.052.001.02')), (e) => e.code === 'WRONG_SOURCE' && /camt\.052/.test(e.message));
    assert.throws(() => parse('mt940', 'Date,Amount\n2025-01-01,1.00\n'), (e) => e.code === 'WRONG_SOURCE');
    assert.throws(() => parse('camt053', 'Date,Amount\n2025-01-01,1.00\n'), (e) => e.code === 'WRONG_SOURCE');
    assert.throws(() => parse('generic-bank', readFixture('mt940-ing-sample.sta')), (e) => e.code === 'WRONG_SOURCE' && /MT940/.test(e.message));
    assert.throws(() => parse('wise', readFixture('camt053-multi.xml')), (e) => e.code === 'WRONG_SOURCE' && /camt\.053/.test(e.message));
  });
  test('journal entries are refused for bank statements', () => {
    for (const [src, f] of [['mt940', 'mt940-rabobank-gist.sta'], ['camt053', 'camt053-multi.xml']]) {
      assert.throws(() => convert(src, readFixture(f), 'qbo-journal'), (e) => e.code === 'NOT_SUPPORTED');
      const p = parse(src, readFixture(f));
      assert.throws(() => write('qbo-journal', p.transactions, {}), (e) => e.code === 'NOT_SUPPORTED');
    }
  });
  test('FITIDs are unique, stable, and the same for an overlapping file', () => {
    const all = readFixture('mt940-rabobank-gist.sta');
    const fit = (text) => [...write('qbo', parse('mt940', text).transactions, {}).content.matchAll(/<FITID>([^<]+)</g)].map((m) => m[1]);
    const a = fit(all);
    assert.equal(new Set(a).size, a.length);
    assert.deepEqual(fit(all), a);
    // Only the statements from 2015-03-01 on: their entries keep the same ids.
    const cut = all.indexOf(':20:940S150302');
    assert.ok(cut > 0);
    const later = fit(all.slice(cut));
    assert.ok(later.length >= 3 && later.every((id) => a.includes(id)));
  });
  test('two identical entries on one day get different FITIDs', () => {
    const r = parse('mt940', mt([':61:2512011201C1,00NTRFNONREF', ':86:Same', ':61:2512011201C1,00NTRFNONREF', ':86:Same'], { close: 'C251231EUR102,00' }));
    const ids = [...write('ofx', r.transactions, {}).content.matchAll(/<FITID>([^<]+)</g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, 2);
  });
  test('the OFX ending balance can be set from the statement', () => {
    const r = parse('camt053', readFixture('camt053-v08.xml'));
    const out = write('ofx', r.transactions, { ledgerBalance: r.meta.closingBalance });
    assert.deepEqual(validateOfx(out.content, { sumCents: -2450, currency: 'EUR', kind: 'bank' }).errors, []);
    assert.match(out.content, /<BALAMT>75.50</);
  });
});

describe('camt.053 money rules', () => {
  const r = parse('camt053', readFixture('camt053-multi.xml'));
  test('sign from CdtDbtInd; RvslInd labels but does not flip; balance reconciles', () => {
    assert.deepEqual(r.transactions.map(cents), [66012, -28900, 5000, -3000, -5000, -150]);
    assert.equal(r.transactions[2].description, 'Reversal: Return of direct debit');
    assert.equal(r.meta.reconciled, true);
    assert.equal(r.meta.closingBalance, 1339.62);
  });
  test('pending entries are left out with a note', () => {
    assert.ok(!r.transactions.some((t) => t.amount === 999));
    assert.ok(r.warnings.some((w) => w.includes('not booked yet')));
  });
  test('batch entry split into its payments when they add up', () => {
    const b = r.transactions.filter((t) => t.id && t.id.startsWith('ASR-0004/'));
    assert.deepEqual(b.map((t) => [t.counterparty, t.description, cents(t)]), [['Stadtwerke', 'Strom Dezember', -3000], ['Telekom', 'Mobilfunk Dezember', -5000]]);
  });
  test('batch kept as one line when its payments do not add up', () => {
    const t = readFixture('camt053-multi.xml').replace('<Amt Ccy="EUR">50.00</Amt></TxAmt></AmtDtls>\n<RltdPties><Cdtr><Nm>Telekom', '<Amt Ccy="EUR">49.00</Amt></TxAmt></AmtDtls>\n<RltdPties><Cdtr><Nm>Telekom');
    const k = parse('camt053', t);
    assert.ok(k.transactions.some((x) => x.amount === -80 && /Batch of 2/.test(x.description)));
    assert.ok(k.warnings.some((w) => w.includes('kept as one line')));
    assert.equal(k.meta.reconciled, true);
  });
  test('counterparty: debtor for money in, creditor for money out; entities decoded', () => {
    assert.equal(r.transactions[0].counterparty, 'Müller & Söhne GmbH');
    assert.equal(r.transactions[0].counterpartyAccount, 'DE02120300000000202051');
    assert.equal(r.transactions[0].reference, 'INV-2025-118');
    assert.equal(r.transactions[1].counterpartyAccount, 'NL91ABNA0417164300');
    assert.equal(r.transactions[1].reference, 'RF18539007547034');
    assert.equal(r.transactions[4 + 1].type, 'fee');
  });
  test('version .001.08 shapes: Sts/Cd, Pty/Nm, DtTm, prefixed namespace, CDATA', () => {
    const v = parse('auto', readFixture('camt053-v08.xml'));
    assert.equal(v.meta.sourceId, 'camt053');
    assert.equal(v.transactions[0].counterparty, 'Boulangerie Paul & Fils');
    assert.equal(v.transactions[0].date, '2026-01-02');
    assert.equal(v.meta.reconciled, true);
  });
  test('ING sample (truncated as published): batch line without details, loud warning', () => {
    const s = parse('camt053', readFixture('camt053-ing-sample.xml'));
    assert.equal(s.transactions[0].description, 'Batch of 2 transactions');
    assert.ok(s.warnings.some((w) => w.startsWith('WARNING:') && w.includes('difference 335.00')));
  });
  test('amounts with more than two decimals are not rounded silently', () => {
    const t = readFixture('camt053-v08.xml').replace('<ns:Amt Ccy="EUR">24.50</ns:Amt><ns:CdtDbtInd>DBIT</ns:CdtDbtInd><ns:Sts>', '<ns:Amt Ccy="EUR">24.505</ns:Amt><ns:CdtDbtInd>DBIT</ns:CdtDbtInd><ns:Sts>');
    const x = parse('camt053', t);
    assert.equal(x.transactions.length, 0);
    assert.ok(x.warnings.some((w) => w.includes('amount could not be read')));
    assert.ok(x.warnings.some((w) => w.startsWith('WARNING:')));
  });
  test('no currency anywhere is refused, not guessed', () => {
    const t = readFixture('camt053-v08.xml').replace('<ns:Ccy>EUR</ns:Ccy>', '').replace(/ Ccy="EUR"/g, '');
    assert.throws(() => parse('camt053', t), (e) => e.code === 'BAD_FILE' && /currenc/.test(e.message));
  });
  test('XML reader: DOCTYPE refused, damaged files refused', () => {
    assert.throws(() => parseXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><x/>'), (e) => e.code === 'BAD_FILE');
    assert.throws(() => parse('camt053', readFixture('camt053-v08.xml').slice(0, 1500)), (e) => e.code === 'BAD_FILE');
    assert.equal(parseXml('<a x="1&amp;2"><b>&#x41;&lt;</b><c/></a>').children[0].text, 'A<');
  });
});

describe('spreadsheet CSV target', () => {
  const r = parse('camt053', readFixture('camt053-multi.xml'));
  test('columns, BOM, running balance, formula guard', () => {
    const out = write('spreadsheet-csv', r.transactions, { sourceId: 'camt053' });
    const v = checkSpreadsheetCsv(out.content);
    assert.deepEqual(v.errors, []);
    assert.equal(v.sumCents, 33962);
    assert.deepEqual(v.rows[1], ['2025-12-30', '2025-12-30', '660.12', 'EUR', 'Credit', 'Müller & Söhne GmbH', 'DE02120300000000202051', 'Invoice 2025-118', 'INV-2025-118', '1660.12']);
    assert.equal(v.rows[2][5], `'=HYPERLINK("http://x")`);
    assert.equal(v.rows[v.rows.length - 1][9], '1339.62');
    assert.ok(out.filename.endsWith('-spreadsheet.csv'));
  });
  test('semicolon style uses decimal commas', () => {
    const out = write('spreadsheet-csv', r.transactions, { style: 'semicolon' });
    const line = out.content.replace(/^﻿/, '').split('\r\n')[1];
    assert.equal(line, '2025-12-30;2025-12-30;660,12;EUR;Credit;Müller & Söhne GmbH;DE02120300000000202051;Invoice 2025-118;INV-2025-118;1660,12');
    assert.throws(() => write('spreadsheet-csv', r.transactions, { style: 'tab' }), (e) => e.code === 'BAD_OPTION');
  });
  test('balance column is blank when the balances do not follow from the amounts', () => {
    const tx = r.transactions.map((t, i) => (i === 2 ? { ...t, balance: 1 } : t));
    const out = write('spreadsheet-csv', tx, {});
    const v = checkSpreadsheetCsv(out.content);
    assert.ok(v.rows.slice(1).every((row) => row[9] === ''));
    assert.ok(out.warnings.some((w) => w.includes('Balance column is left blank')));
  });
  test('works for a CSV source without balances', () => {
    const p = parse('generic-bank', readFixture('generic-bank-debit-credit.csv'));
    const v = checkSpreadsheetCsv(write('spreadsheet-csv', p.transactions, {}).content);
    assert.deepEqual(v.errors, []);
  });
  test('date format option', () => {
    const out = write('spreadsheet-csv', r.transactions, { dateFormat: 'DD.MM.YYYY' });
    assert.ok(out.content.split('\r\n')[1].startsWith('30.12.2025;') || out.content.split('\r\n')[1].startsWith('30.12.2025,'));
  });
});

describe('review round 1 fixes', () => {
  const two = mt([':61:2512011201C1,00NTRFA'], { account: 'NL20INGB0001234567', close: 'C251231EUR101,00' })
    + mt([':61:2512011201C2,00NTRFB', ':61:2512021202C3,00NTRFC'], { account: 'DE89370400440532013000', close: 'C251231EUR105,00', ref: 'R2' });
  const acct = (out) => /<ACCTID>([^<]+)</.exec(out.content)[1];
  test('finding 1: each account gets its own ACCTID, from its account number', () => {
    for (const target of ['qbo', 'qfx', 'ofx']) {
      const a = write(target, parse('mt940', two).transactions, { sourceId: 'mt940' });
      const b = write(target, parse('mt940', two, { account: 'NL20INGB0001234567' }).transactions, { sourceId: 'mt940' });
      assert.equal(acct(a), statementAcctId('DE89370400440532013000', 'EUR'));
      assert.equal(acct(b), 'NL20INGB0001234567EUR');
      assert.notEqual(acct(a), acct(b));
    }
    const camt = write('ofx', parse('camt053', readFixture('camt053-v08.xml')).transactions, {});
    assert.equal(acct(camt), statementAcctId('FR1420041010050500013M02606', 'EUR'));
    assert.equal(acct(write('ofx', parse('mt940', readFixture('mt940-german-sepa.sta')).transactions, {})), statementAcctId('50880050/0194783700888', 'EUR'));
  });
  test('finding 1: sources without an account number keep their old ACCTID; accountId still wins', () => {
    const p = parse('generic-bank', readFixture('generic-bank-debit-credit.csv'));
    assert.match(acct(write('qbo', p.transactions, { sourceId: 'generic-bank' })), /^BI[0-9A-F]{10}$/);
    assert.equal(acct(write('qbo', parse('mt940', two).transactions, { accountId: 'MYACCT1' })), 'MYACCT1');
  });
  test('finding 5: two camt.053 documents in one file are both read, with a note', () => {
    const one = readFixture('camt053-v08.xml');
    const second = readFixture('camt053-multi.xml');
    const r = parse('auto', one + '\n' + second, { account: 'FR1420041010050500013M02606' });
    assert.ok(r.warnings.some((w) => w.includes('joins 2 camt.053 documents')));
    const all = parse('camt053', one + second);
    assert.equal(all.meta.accounts.length, 3);
  });
  test('finding 5: text or a non-camt element after the document is refused, never dropped', () => {
    const one = readFixture('camt053-v08.xml');
    assert.throws(() => parse('camt053', one + 'junk after the document'), (e) => e.code === 'BAD_FILE');
    assert.throws(() => parse('camt053', one + '<Other><x/></Other>'), (e) => e.code === 'WRONG_SOURCE' && /document 2/.test(e.message));
    assert.throws(() => parseXml('<a/><b/>'), (e) => e.code === 'BAD_FILE');
  });
  test('finding 5: lines outside any MT940 statement are reported', () => {
    const r = parse('mt940', mt([':61:2512011201C1,00NTRFA'], { close: 'C251231EUR101,00' }) + 'GARBAGE LINE WITH 2512011201C9,99 IN IT\r\n');
    assert.ok(r.warnings.some((w) => w.includes('outside any MT940 statement') && w.includes('GARBAGE')));
    const abn = parse('mt940', readFixture('mt940-abnamro.sta'));
    assert.ok(!abn.warnings.some((w) => w.includes('outside any MT940 statement')), 'BIC and 940 header lines are expected');
  });
  test('finding 8: a 2,000-entry statement is detected and converted', () => {
    const lines = [];
    for (let i = 0; i < 2000; i++) lines.push(`:61:2601150115D1,00NTRFREF${i}//B${i}`, `:86:/EREF/E2E${i}//NAME/Some Supplier B.V.//REMI/USTD//Invoice number ${i} for services rendered/`);
    const t = mt(lines, { open: 'C260101EUR2000,00', close: 'C260131EUR0,00' });
    assert.ok(t.indexOf(':62F:') > 20000);
    assert.equal(detectSource(t).sourceId, 'mt940');
    const r = parse('auto', t);
    assert.equal(r.transactions.length, 2000);
    assert.equal(r.meta.reconciled, true);
  });
  test('finding 4 and 8: cut-off and lower-case MT940 files get MT940 messages, not the CSV one', () => {
    const cut = mt([':61:2512011201C1,00NTRFA'], { close: 'C251231EUR101,00' }).split(':62F:')[0];
    assert.throws(() => parse('auto', cut), (e) => e.code === 'BAD_FILE' && /closing balance/.test(e.message) && !/header row/.test(e.message));
    const noBal = ':20:X\r\n:25:NL20INGB0001234567\r\n:28C:1\r\n:61:2512011201C1,00NTRFA\r\n';
    const d = detectSource(noBal);
    assert.equal(d.sourceId, null);
    assert.match(d.reason, /MT940/);
    assert.doesNotMatch(d.reason, /header row/);
    const lower = mt([':61:2512011201C1,00NTRFA'], { close: 'C251231EUR101,00' }).replace(':60F:', ':60f:').replace(':62F:', ':62f:');
    assert.match(detectSource(lower).reason, /lower case/);
  });
  test('finding 3: a :86: continuation line starting with :20: is refused with the reason', () => {
    const t = mt([':61:2512011201C1,00NTRFA', ':86:Invoice text', ':20:not a new statement', ':61:2512011201C2,00NTRFB'], { close: 'C251231EUR103,00' });
    assert.throws(() => parse('mt940', t), (e) => e.code === 'BAD_FILE' && /starts with ":20:"/.test(e.message));
  });
  test('finding 6: ">" inside an attribute value does not end the tag', () => {
    const t = readFixture('camt053-v08.xml').replace('<ns:Ustrd>Facture 77</ns:Ustrd>', '<ns:Ustrd note="1>0">Facture 77</ns:Ustrd>').replace('<ns:Amt Ccy="EUR">24.50</ns:Amt><ns:CdtDbtInd>DBIT</ns:CdtDbtInd><ns:Sts>', '<ns:Amt Ccy="EUR" x="a>b">24.50</ns:Amt><ns:CdtDbtInd>DBIT</ns:CdtDbtInd><ns:Sts>');
    const r = parse('camt053', t);
    assert.equal(r.transactions[0].description, 'Facture 77');
    assert.equal(r.meta.reconciled, true);
  });
  test('finding 7: RvslInd "1" marks a reversal; the sign still follows CdtDbtInd', () => {
    const t = readFixture('camt053-v08.xml').replace('<ns:CdtDbtInd>DBIT</ns:CdtDbtInd><ns:Sts>', '<ns:CdtDbtInd>DBIT</ns:CdtDbtInd><ns:RvslInd>1</ns:RvslInd><ns:Sts>');
    const x = parse('camt053', t).transactions[0];
    assert.match(x.description, /^Reversal:/);
    assert.equal(x.amount, -24.5);
  });
  test('finding 12: paged camt.053 statements use ITBD at the page break and are checked', () => {
    const page = (bals, amt, ind, n) => `<Stmt><Id>P${n}</Id><ElctrncSeqNb>${n}</ElctrncSeqNb><Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy></Acct>${bals}<Ntry><Amt Ccy="EUR">${amt}</Amt><CdtDbtInd>${ind}</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-01-0${n}</Dt></BookgDt><AcctSvcrRef>E${n}</AcctSvcrRef></Ntry></Stmt>`;
    const bal = (cd, a, dt) => `<Bal><Tp><CdOrPrtry><Cd>${cd}</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">${a}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>${dt}</Dt></Dt></Bal>`;
    const doc = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt>${page(bal('OPBD', '100.00', '2026-01-01') + bal('ITBD', '110.00', '2026-01-01'), '10.00', 'CRDT', 1)}${page(bal('ITBD', '110.00', '2026-01-01') + bal('CLBD', '105.00', '2026-01-02'), '5.00', 'DBIT', 2)}</BkToCstmrStmt></Document>`;
    const r = parse('camt053', doc);
    assert.ok(r.meta.statements.every((s) => s.reconciled === true));
    assert.equal(r.meta.reconciled, true);
    assert.equal(r.meta.closingBalance, 105);
    const broken = parse('camt053', doc.replace(bal('ITBD', '110.00', '2026-01-01') + bal('CLBD', '105.00', '2026-01-02'), bal('ITBD', '110.00', '2026-01-01') + bal('CLBD', '99.00', '2026-01-02')));
    assert.ok(broken.warnings.some((w) => w.startsWith('WARNING: statement 2')));
  });
});

describe('review round 2 fixes', () => {
  const acct = (out) => /<ACCTID>([^<]+)</.exec(out.content)[1];
  const ofxFor = (text, opts) => write('ofx', parse('mt940', text, opts).transactions, {});
  test('R2-1: one account number in two currencies gets two ids, and the id does not depend on the other currency being in the file', () => {
    const eur = mt([':61:2512011201C1,00NTRFA'], { account: 'NL91ABNA0417164300EUR', close: 'C251231EUR101,00' });
    const usd = mt([':61:2512011201C2,00NTRFB', ':61:2512011201C3,00NTRFC'], { account: 'NL91ABNA0417164300USD', open: 'C251201USD0,00', close: 'C251231USD5,00', ref: 'R2' });
    const both = eur + usd;
    const idUsd = acct(ofxFor(both));
    const idEur = acct(ofxFor(both, { account: 'NL91ABNA0417164300 EUR' }));
    assert.equal(idUsd, 'NL91ABNA0417164300USD');
    assert.equal(idEur, 'NL91ABNA0417164300EUR');
    assert.equal(acct(ofxFor(eur)), idEur, 'next month, EUR only: same id');
    assert.equal(acct(ofxFor(usd)), idUsd);
  });
  test('R2-2: case and spacing do not change the id; long numbers keep a hash of the full number', () => {
    assert.equal(statementAcctId('nl91 abna 0417 1643 00', 'eur'), statementAcctId('NL91ABNA0417164300', 'EUR'));
    const a = statementAcctId('MT84MALT011000012345MTLCAST001S', 'EUR');
    const b = statementAcctId('MT99XXXX011000012345MTLCAST001S', 'EUR');
    assert.equal(a.length, 22);
    assert.notEqual(a, b, 'same last characters, different bank: different ids');
    assert.match(a, /^[A-Z0-9]{12}[0-9A-F]{7}EUR$/);
    assert.equal(a.slice(0, 12), '5MTLCAST001S', 'last 12 characters of the account number');
  });
  test('R2-2: one account written with and without spaces is one account', () => {
    const a = mt([':61:2512011201C1,00NTRFA'], { account: 'NL91ABNA0417164300', close: 'C251201EUR101,00' });
    const b = mt([':61:2512021202C1,00NTRFB'], { account: 'nl91 abna 0417 1643 00', open: 'C251201EUR101,00', close: 'C251202EUR102,00', ref: 'R2' });
    const r = parse('mt940', a + b);
    assert.equal(r.meta.accounts.length, 1);
    assert.equal(r.transactions.length, 2);
    assert.equal(acct(write('qbo', r.transactions, {})), 'NL91ABNA0417164300EUR');
  });
  test('R2-3: pages of one day in reverse file order are chained by balance', () => {
    const p1 = mt([':61:2601010101C10,00NTRFA'], { open: 'C260101EUR100,00', close: 'C260101EUR110,00', num: '1/1' }).replace(':62F:', ':62M:');
    const p2 = mt([':61:2601010101D5,00NTRFB'], { open: 'C260101EUR110,00', close: 'C260101EUR105,00', num: '1/2', ref: 'R2' }).replace(':60F:', ':60M:');
    const r = parse('mt940', p2 + p1);
    assert.ok(!r.warnings.some((w) => w.includes('statements are missing')), r.warnings.join(' | '));
    assert.equal(r.meta.reconciled, true);
    assert.equal(r.meta.closingBalance, 105);
    assert.deepEqual(r.transactions.map((t) => t.balance), [110, 105]);
    assert.match(write('ofx', r.transactions, { ledgerBalance: r.meta.closingBalance }).content, /<BALAMT>105.00</);
  });
  test('R2-3: pages that do not chain still give the loud gap warning', () => {
    const p1 = mt([':61:2601010101C10,00NTRFA'], { open: 'C260101EUR100,00', close: 'C260101EUR110,00', num: '1/1' });
    const p2 = mt([':61:2601010101D5,00NTRFB'], { open: 'C260101EUR200,00', close: 'C260101EUR195,00', num: '1/2', ref: 'R2' });
    const r = parse('mt940', p2 + p1);
    assert.ok(r.warnings.some((w) => w.includes('statements are missing')));
    assert.equal(r.meta.reconciled, false);
  });
});

describe('review round 3 fixes', () => {
  test('R3-1: account numbers that differ only in punctuation are not merged', () => {
    const a = mt([':61:2512011201C1,00NTRFA'], { account: '12-3456', close: 'C251201EUR101,00' });
    const b = mt([':61:2512021202C2,00NTRFB'], { account: '123-456', open: 'C251201EUR100,00', close: 'C251202EUR102,00', ref: 'R2' });
    const r = parse('mt940', a + b);
    assert.equal(r.meta.accounts.length, 2);
    assert.ok(r.warnings.some((w) => w.includes('holds 2 accounts')));
    const c = mt([':61:2512021202C1,00NTRFB'], { account: '12-34 56', open: 'C251201EUR101,00', close: 'C251202EUR102,00', ref: 'R3' });
    assert.equal(parse('mt940', a + c).meta.accounts.length, 1, 'spaces alone still merge');
  });
});

describe('ING code words from the format description', () => {
  test('a :86: that starts with /IREF/ is read as the /TAG/ layout (ING example)', () => {
    const t = mt([':61:2502100210C1977,55NTRFMAIN100//00000000000001', '/TRCD/00100/', ':86:/IREF/MAIN100//CNTP/NL41INGB0', '751121812/INGBNL2AXXX/BIERVERBO', 'ND N.V.///REMI/USTD//2510000/'],
      { open: 'C250210EUR0,00', close: 'C250210EUR1977,55' });
    const x = parse('mt940', t).transactions[0];
    assert.equal(x.counterparty, 'BIERVERBOND N.V.');
    assert.equal(x.counterpartyAccount, 'NL41INGB0751121812');
    assert.equal(x.description, '2510000');
  });
});

describe('statement notes read right at 1 and at 2', () => {
  const noPlaceholders = (ws) => ws.every((w) => !/\((s|ies)\)|entryy|\b1 entries\b|\b1 lines\b|\b1 places\b|\b1 repeats\b/.test(w));
  test('camt pending, split and kept batch notes, singular and plural', () => {
    const one = parse('camt053', readFixture('camt053-multi.xml'));
    assert.ok(one.warnings.includes('Left out 1 entry that is not booked yet (status pending or information only). It does not change the booked balance; a later statement will show it once it is booked.'));
    assert.ok(one.warnings.includes('1 batch entry was split into its individual payments, because the payments add up exactly to the booked amount.'));
    assert.ok(one.warnings.some((w) => w.includes('123456789 USD (1 entry)')));
    assert.ok(noPlaceholders(one.warnings));
    const t = readFixture('camt053-multi.xml');
    const pend = t.slice(t.indexOf('<Ntry>\n<NtryRef>E6</NtryRef>'), t.indexOf('</Ntry>', t.indexOf('<NtryRef>E6</NtryRef>')) + 7);
    const two = parse('camt053', t.replace(pend, pend + '\n' + pend.replace('E6', 'E7')));
    assert.ok(two.warnings.some((w) => w.startsWith('Left out 2 entries that are not booked yet') && w.includes('They do not change')));
    assert.ok(noPlaceholders(two.warnings));
    const kept = parse('camt053', t.replace('<Amt Ccy="EUR">50.00</Amt></TxAmt></AmtDtls>\n<RltdPties><Cdtr><Nm>Telekom', '<Amt Ccy="EUR">49.00</Amt></TxAmt></AmtDtls>\n<RltdPties><Cdtr><Nm>Telekom'));
    assert.ok(kept.warnings.includes('1 batch entry was kept as one line: its individual payments do not add up to the booked amount in the account currency.'));
  });
  test('MT940 repeat, gap, stray-line and left-out-account notes, singular and plural', () => {
    const a = mt([':61:2512011201C1,00NTRFX'], { close: 'C251231EUR101,00' });
    const r1 = parse('mt940', a + a + 'STRAY TEXT LINE ONE\r\n');
    assert.ok(r1.warnings.includes('This file contains 1 exact repeat of a statement it already holds. The repeated statement was read once.'));
    assert.ok(r1.warnings.some((w) => w.startsWith('1 line of this file is outside any MT940 statement and was not read: "STRAY TEXT LINE ONE". If it holds a booking,')));
    assert.ok(noPlaceholders(r1.warnings));
    const r2 = parse('mt940', a + a + a + 'STRAY ONE LINE\r\nSTRAY TWO LINE\r\n');
    assert.ok(r2.warnings.some((w) => w.startsWith('This file contains 2 exact repeats')));
    assert.ok(r2.warnings.some((w) => w.startsWith('2 lines of this file are outside any MT940 statement and were not read') && w.includes('If they hold bookings')));
    const g = mt([':61:2512031203C1,00NTRFY'], { open: 'C251202EUR200,00', close: 'C251203EUR201,00', num: '3', ref: 'R3' });
    assert.ok(parse('mt940', a + g).warnings.some((w) => w.startsWith('In 1 place a statement')));
    const g2 = mt([':61:2512051205C1,00NTRFZ'], { open: 'C251205EUR900,00', close: 'C251205EUR901,00', num: '5', ref: 'R5' });
    assert.ok(parse('mt940', a + g + g2).warnings.some((w) => w.startsWith('In 2 places a statement')));
    assert.ok(noPlaceholders(parse('mt940', readFixture('mt940-german-sepa.sta')).warnings));
  });
});

describe('review round 4 fixes', () => {
  test('R4-2: free text that starts with /EXCH/ or /CHGS/ keeps its description', () => {
    const one = (l86) => parse('mt940', mt([':61:2512011201C1,00NTRFREF1', `:86:${l86}`], { close: 'C251231EUR101,00' })).transactions[0];
    assert.equal(one('/EXCH/1,0850/ conversion USD').description, '/EXCH/1,0850/ conversion USD');
    assert.equal(one('/CHGS/EUR2,50/').description, '/CHGS/EUR2,50/');
  });
  test('R4-2: /CHGS/ inside REMI text does not cut it; //CHGS/ after the REMI value is structure', () => {
    const one = (l86) => parse('mt940', mt([':61:2512011201C1,00NTRFREF1', `:86:${l86}`], { close: 'C251231EUR101,00' })).transactions[0];
    assert.equal(one('/EREF/E1//REMI/USTD//Fee /CHGS/ text here/').description, 'Fee /CHGS/ text here');
    assert.equal(one('/EREF/E1//REMI/USTD//Invoice 7//CHGS/EUR2,50/').description, 'Invoice 7');
  });
  test('R4-3: a reference TYPE word in :61: subfield 7 is not used as a reference; ids stay unique and stable', () => {
    const t = mt([':61:2512011201C1,00NTRFEREF//B1', ':86:/REMI/USTD//One/', ':61:2512011201C1,00NTRFEREF//B2', ':86:/REMI/USTD//One/', ':61:2512011201C1,00NTRFPREF', ':86:/REMI/USTD//Two/', ':61:2512011201C1,00NTRFIREF', ':86:/REMI/USTD//Two/'], { close: 'C251231EUR104,00' });
    const r = parse('mt940', t);
    assert.deepEqual(r.transactions.map((x) => x.id), ['B1', 'B2', undefined, undefined]);
    assert.ok(r.transactions.every((x) => x.reference === undefined));
    const ids = (text) => [...write('ofx', parse('mt940', text).transactions, {}).content.matchAll(/<FITID>([^<]+)</g)].map((m) => m[1]);
    assert.equal(new Set(ids(t)).size, 4);
    assert.deepEqual(ids(t), ids(t));
    const rabo = parse('mt940', readFixture('mt940-rabobank-gist.sta'));
    assert.ok(rabo.transactions.every((x) => x.id !== 'EREF' && x.reference !== 'EREF'));
  });
});
