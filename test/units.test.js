import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, writeCSV, sniffDelimiter } from '../src/csv.js';
import { parseMoney, formatCents, sniffDecimal } from '../src/money.js';
import { parseDate, sniffDateOrder, formatDate } from '../src/dates.js';
import { fnv1a64 } from '../src/hash.js';
import { EngineError } from '../src/errors.js';
import { strictParse } from '../test-support/csv-checks.js';

describe('CSV reader', () => {
  test('strips BOM and handles CRLF', () => {
    assert.deepEqual(parseCSV('﻿a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  });
  test('quoted fields with commas, quotes and embedded newlines', () => {
    const rows = parseCSV('x,"a, b","say ""hi""","line1\nline2"\r\nnext,,,\n');
    assert.deepEqual(rows[0], ['x', 'a, b', 'say "hi"', 'line1\nline2']);
    assert.deepEqual(rows[1], ['next', '', '', '']);
  });
  test('CRLF inside quotes is normalized to LF', () => {
    assert.deepEqual(parseCSV('"a\r\nb",c\r\n'), [['a\nb', 'c']]);
  });
  test('bare CR line endings', () => {
    assert.deepEqual(parseCSV('a,b\r1,2\r'), [['a', 'b'], ['1', '2']]);
  });
  test('ragged rows and missing final newline', () => {
    assert.deepEqual(parseCSV('a,b\n1,2,3\n4'), [['a', 'b'], ['1', '2', '3'], ['4']]);
  });
  test('unterminated quote gives a human error', () => {
    assert.throws(() => parseCSV('a,b\n"oops,2\n'), (e) => e instanceof EngineError && e.code === 'UNTERMINATED_QUOTE' && /line 2/.test(e.message));
  });
  test('sniffs semicolon and tab delimiters', () => {
    assert.equal(sniffDelimiter('a;b;c\n1;2;3\n'), ';');
    assert.equal(sniffDelimiter('a\tb\tc\n1\t2\t3\n'), '\t');
    assert.equal(sniffDelimiter('"a;x",b,c\n1,2,3\n'), ',');
    assert.deepEqual(parseCSV('Datum;Betrag\n01.02.2025;-1.234,56\n'), [['Datum', 'Betrag'], ['01.02.2025', '-1.234,56']]);
  });
  test('writer round-trips through an independent strict reader', () => {
    const rows = [['Date', 'Description', 'Amount'], ['01/02/2025', 'Comma, "quote" and\nnewline', '-1.00'], ['01/03/2025', ' leading space', '2.00']];
    const text = writeCSV(rows);
    assert.ok(text.endsWith('\r\n'));
    assert.deepEqual(strictParse(text), rows);
    assert.deepEqual(parseCSV(text), rows);
  });
});

describe('money', () => {
  const cases = [
    ['+ $25.00', 2500], ['- $1,000.00', -100000], ['-$5.00', -500], ['$2', 200], ['(12.34)', -1234], ['12.34-', -1234],
    ['-€0.19', -19], ['£1,208.35', 120835], ['1,234.56', 123456], ['USD 10.00', 1000], ['10.00 USD', 1000], ['0.0', 0],
    ['19.0', 1900], ['1.71', 171], ['80', 8000], ['-0.005', -1], ['0.004', 0], ['2,907,287', 290728700], ['$-3.10', -310],
  ];
  for (const [s, c] of cases) test(`parses "${s}"`, () => assert.equal(parseMoney(s), c));
  test('placeholders are null', () => { for (const s of ['', '--', '-', 'N/A', '(None)', null, undefined]) assert.equal(parseMoney(s), null); });
  test('garbage is NaN', () => { for (const s of ['abc', '1,23,4.00', '1.2.3', '$']) assert.ok(Number.isNaN(parseMoney(s)), s); });
  test('decimal comma', () => {
    assert.equal(parseMoney('-1.227,95', ','), -122795);
    assert.equal(parseMoney('0,00', ','), 0);
    assert.equal(parseMoney('"104,13"'.replace(/"/g, ''), ','), 10413);
    assert.equal(sniffDecimal(['1.227,95', '-35,96', '0,00']), ',');
    assert.equal(sniffDecimal(['1,234.00', '-2.24', '2,907,287']), '.');
  });
  test('formatCents', () => {
    assert.equal(formatCents(-123456), '-1234.56');
    assert.equal(formatCents(5), '0.05');
    assert.equal(formatCents(-5), '-0.05');
    assert.equal(formatCents(0), '0.00');
    assert.throws(() => formatCents(1.5));
  });
  test('no float drift: 10,000 x $0.10 and 3 x $0.10', () => {
    let s = 0;
    for (let i = 0; i < 10000; i++) s += parseMoney('0.10');
    assert.equal(formatCents(s), '1000.00');
    assert.equal(formatCents(parseMoney('0.10') * 3), '0.30');
  });
});

describe('dates', () => {
  const cases = [
    ['2025-04-08T11:37:36', '2025-04-08'], ['2024-09-26 16:18:23 EDT', '2024-09-26'], ['2026-03-20 02:43:16 +0000', '2026-03-20'],
    ['01/05/2022', '2022-01-05'], ['1/1/2018', '2018-01-01'], ['11/30/25', '2025-11-30'], ['2026/03/02', '2026-03-02'],
    ['January 30, 2025', '2025-01-30'], ['16 January, 2024', '2024-01-16'], ['03 Jan 2024', '2024-01-03'], ['Sep 5 2025', '2025-09-05'],
    ['20250131', '2025-01-31'], ['2025-06-24 11:00', '2025-06-24'],
  ];
  for (const [s, d] of cases) test(`parses "${s}"`, () => assert.equal(parseDate(s), d));
  test('day-first when asked', () => assert.equal(parseDate('15/01/2024', 'dmy'), '2024-01-15'));
  test('rejects impossible dates', () => {
    for (const s of ['02/30/2025', '13/13/2025', '2025-02-29', 'Closing balance', '', 'Febtober 3, 2025']) assert.equal(parseDate(s), null, s);
    assert.equal(parseDate('2024-02-29'), '2024-02-29');
  });
  test('sniffs order', () => {
    assert.equal(sniffDateOrder(['03/03/2025', '14/03/2025']).order, 'dmy');
    assert.equal(sniffDateOrder(['03/30/2025', '01/02/2025']).order, 'mdy');
    assert.equal(sniffDateOrder(['01/02/2025', '02/03/2025']).ambiguous, true);
    assert.equal(sniffDateOrder(['01.02.2025', '02.03.2025']).order, 'dmy');
    assert.equal(sniffDateOrder(['01.02.2025', '02.03.2025']).ambiguous, false);
    assert.equal(sniffDateOrder(['01-02-2025']).ambiguous, true);
    assert.equal(sniffDateOrder(['13/01/2025', '01/13/2025']).conflicting, true);
  });
  test('formats', () => {
    assert.equal(formatDate('2025-03-07', 'MM/DD/YYYY'), '03/07/2025');
    assert.equal(formatDate('2025-03-07', 'DD/MM/YYYY'), '07/03/2025');
    assert.equal(formatDate('2025-03-07', 'YYYY-MM-DD'), '2025-03-07');
  });
});

describe('hash', () => {
  test('known FNV-1a 64 vectors', () => {
    assert.equal(fnv1a64(''), 'cbf29ce484222325');
    assert.equal(fnv1a64('a'), 'af63dc4c8601ec8c');
    assert.equal(fnv1a64('foobar'), '85944171f73967e8');
  });
});
