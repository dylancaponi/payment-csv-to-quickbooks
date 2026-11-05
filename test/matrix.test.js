// Every source fixture x every target, checked by the independent validators.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse, write, detectSource } from '../index.js';
import { CASES, TARGET_IDS, readFixture, centsOf, UNSUPPORTED } from '../test-support/fixtures.js';
import { validateOfx } from '../test-support/ofx-validator.js';
import { checkQboCsv, checkXeroCsv, checkJournal } from '../test-support/csv-checks.js';

function mainCurrency(txns) {
  const m = new Map();
  for (const t of txns) m.set(t.currency, (m.get(t.currency) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

for (const c of CASES) {
  describe(`${c.file}`, () => {
    const text = readFixture(c.file);
    const parsed = parse(c.source, text, c.options);
    const cur = mainCurrency(parsed.transactions);
    const expectSum = centsOf(parsed.transactions, cur);

    test('detects the right source', () => {
      const d = detectSource(text);
      assert.equal(d.sourceId, c.source, d.reason);
      assert.ok(d.confidence >= 0.4);
    });

    test('parses to the hand-computed count and total', () => {
      assert.equal(parsed.transactions.length, c.count);
      assert.equal(centsOf(parsed.transactions), c.sumCents);
      if (c.byCurrency) for (const [k, v] of Object.entries(c.byCurrency)) assert.equal(centsOf(parsed.transactions, k), v);
      for (const t of parsed.transactions) {
        assert.match(t.date, /^\d{4}-\d{2}-\d{2}$/);
        assert.equal(typeof t.amount, 'number');
        assert.ok(Number.isInteger(Math.round(t.amount * 100)));
        assert.equal(Math.abs(t.amount * 100 - Math.round(t.amount * 100)) < 1e-6, true);
        assert.ok(['payment', 'refund', 'fee', 'transfer', 'payout', 'other'].includes(t.type));
        assert.equal(typeof t.raw, 'object');
        if (t.gross !== undefined && t.fee !== undefined) assert.equal(Math.round(t.gross * 100) - Math.round(t.fee * 100), Math.round(t.amount * 100), `gross - fee != amount for ${t.description}`);
      }
      assert.equal(parsed.meta.dateRange.from <= parsed.meta.dateRange.to, true);
    });

    for (const target of TARGET_IDS) {
      if (UNSUPPORTED.has(`${c.source}>${target}`)) {
        test(`refuses ${target} with a plain error`, () => assert.throws(() => write(target, parsed.transactions, { sourceId: c.source }), (e) => e.code === 'NOT_SUPPORTED' && e.message.length > 40));
        continue;
      }
      for (const split of [false, true]) {
        test(`writes ${target}${split ? ' (fees as separate rows)' : ''} and it validates`, () => {
          const out = write(target, parsed.transactions, { includeFeesAsSeparateRows: split, sourceId: c.source });
          assert.ok(out.filename.length > 4);
          assert.equal(typeof out.content, 'string');
          assert.ok(Array.isArray(out.warnings));
          if (target === 'qbo' || target === 'qfx' || target === 'ofx') {
            assert.ok(out.filename.endsWith('.' + target));
            const intuBid = target === 'ofx' ? null : cur === 'CAD' ? '2' : '3000';
            const v = validateOfx(out.content, { intuBid, sumCents: expectSum, currency: cur, kind: 'bank' });
            assert.deepEqual(v.errors, []);
            if (!split) assert.equal(v.stmttrns.length, parsed.transactions.filter((t) => t.currency === cur).length);
          } else if (target === 'qbo-csv-3' || target === 'qbo-csv-4') {
            const v = checkQboCsv(out.content, { columns: target === 'qbo-csv-3' ? 3 : 4 });
            assert.deepEqual(v.errors, []);
            assert.equal(v.sumCents, expectSum);
          } else if (target === 'xero-csv') {
            const v = checkXeroCsv(out.content);
            assert.deepEqual(v.errors, []);
            assert.equal(v.sumCents, expectSum);
          } else {
            const v = checkJournal(out.content);
            assert.deepEqual(v.errors, []);
            assert.ok(v.entries.size >= 1);
          }
        });
      }
    }
  });
}
