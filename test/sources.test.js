// Source-specific facts from FORMATS.md, checked against the fixtures.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse, write, summarizePayouts } from '../index.js';
import { readFixture } from '../test-support/fixtures.js';
import { checkJournal } from '../test-support/csv-checks.js';

const P = (src, file, opts) => parse(src, readFixture(file), opts);
const find = (txns, pred) => { const t = txns.find(pred); assert.ok(t, 'expected transaction not found'); return t; };

describe('Venmo', () => {
  test('preamble, beginning/ending balance and multi-line disclaimer are not transactions; balance reconciles', () => {
    const r = P('venmo', 'venmo-2025.csv');
    assert.equal(r.meta.openingBalance, 120);
    assert.equal(r.meta.closingBalance, 636.9);
    assert.equal(r.meta.reconciled, true);
    assert.ok(!r.transactions.some((t) => /disclaimer|electronic transfers/i.test(t.description)));
  });
  test('quoted newline in note, emoji kept, holder inferred for counterparty', () => {
    const r = P('venmo', 'venmo-2025.csv');
    const rent = find(r.transactions, (t) => t.id === '4012345678901234568');
    assert.equal(rent.amount, -1000);
    assert.equal(rent.counterparty, 'Jordan Placeholder');
    assert.match(rent.description, /Rent share March/);
    assert.match(find(r.transactions, (t) => t.id === '4012345678901234567').description, /🍕/);
  });
  test('19-digit IDs stay exact strings', () => {
    const r = P('venmo', 'venmo-2025.csv');
    assert.ok(r.transactions.some((t) => t.id === '4012345678901234573'));
  });
  test('fee row: gross = total + fee', () => {
    const t = find(P('venmo', 'venmo-2025.csv').transactions, (x) => x.id === '4012345678901234570');
    assert.deepEqual([t.amount, t.gross, t.fee], [1961.9, 2000, 38.1]);
  });
  test('externally funded payment gets an offsetting transfer; can be turned off', () => {
    const on = P('venmo', 'venmo-2025.csv');
    assert.ok(on.transactions.some((t) => t.id === '4012345678901234569:funding' && t.amount === 80 && t.type === 'transfer'));
    const off = P('venmo', 'venmo-2025.csv', { externalFunding: 'ignore' });
    assert.equal(off.transactions.length, 7);
  });
  test('2021 layout, pending skipped, crypto section ignored', () => {
    const r = P('venmo', 'venmo-2021.csv');
    assert.equal(r.meta.rowsSkipped, 1);
    assert.equal(r.meta.reconciled, true);
    assert.equal(find(r.transactions, (t) => t.type === 'payment').counterparty, 'Alex Mock');
  });
});

describe('Cash App', () => {
  test('v2: fees, failed and notification rows', () => {
    const r = P('cashapp', 'cashapp-2026.csv');
    const buy = find(r.transactions, (t) => /Bitcoin Buy/.test(t.description));
    assert.deepEqual([buy.amount, buy.gross, buy.fee], [-5, -4.9, 0.1]);
    assert.equal(r.meta.rowsSkipped, 2);
    assert.ok(r.warnings.some((w) => /failed/.test(w)));
  });
  test('v1: zero cents dropped, reversed payment is a refund, thousands separator', () => {
    const r = P('cashapp', 'cashapp-2024-v1.csv');
    assert.equal(find(r.transactions, (t) => t.amount === 2).counterparty, 'Drew Synthetic');
    assert.equal(find(r.transactions, (t) => t.amount === 45).type, 'refund');
    assert.equal(find(r.transactions, (t) => t.amount === 1149).description, 'PAYROLL SAMPLE CO');
  });
  test('newest-first file comes out oldest first', () => {
    const d = P('cashapp', 'cashapp-2026.csv').transactions.map((t) => t.date);
    assert.deepEqual(d, [...d].sort());
  });
});

describe('PayPal', () => {
  test('memo, hold and reversal rows excluded; BOM header read', () => {
    const r = P('paypal', 'paypal-us.csv');
    assert.equal(r.meta.rowsSkipped, 3);
    assert.ok(!r.transactions.some((t) => /Hold|Shopping Cart/.test(t.raw.Type)));
  });
  test('fee = gross - net, thousands separators', () => {
    const t = find(P('paypal', 'paypal-us.csv').transactions, (x) => x.id === '9WD00000TEST0001');
    assert.deepEqual([t.gross, t.fee, t.amount], [1250, 46.73, 1203.27]);
  });
  test('currency conversion row names the original payee', () => {
    const t = find(P('paypal', 'paypal-us.csv').transactions, (x) => x.id === '9WD00000TEST0008');
    assert.equal(t.amount, -21.84);
    assert.match(t.description, /Sample Hosting Co/);
  });
  test('multi-currency: writer keeps one currency and warns', () => {
    const r = P('paypal', 'paypal-us.csv');
    assert.deepEqual(r.meta.currencies, ['EUR', 'USD']);
    const usd = write('qbo-csv-3', r.transactions);
    assert.ok(usd.warnings.some((w) => /Left out 2 transaction\(s\) in EUR/.test(w)));
    const eur = write('ofx', r.transactions, { currency: 'EUR' });
    assert.match(eur.content, /<CURDEF>EUR/);
    assert.equal((eur.content.match(/<STMTTRN>/g) || []).length, 2);
  });
  test('EU locale: decimal comma and day-first dates inferred from CET', () => {
    const r = P('paypal', 'paypal-eu.csv');
    assert.equal(r.transactions[0].date, '2025-01-15');
    assert.equal(r.transactions[1].date, '2025-02-02');
    assert.equal(r.transactions[0].amount, 1191.99);
    assert.equal(r.meta.currency, 'EUR');
  });
});

describe('Stripe', () => {
  test('legacy balance history: payout ids from Transfer, dispute mapped to refund', () => {
    const r = P('stripe-balance', 'stripe-balance-history.csv');
    const d = find(r.transactions, (t) => t.id === 'txn_9Z0TestDispute001');
    assert.deepEqual([d.type, d.gross, d.fee, d.amount], ['refund', -30, 15, -45]);
    assert.equal(find(r.transactions, (t) => t.id === 'txn_9Z0TestPayout0002').payoutDate, '2025-07-02');
  });
  test('legacy payout summary: deposits match payouts, unpaid charge goes to clearing', () => {
    const rows = summarizePayouts(P('stripe-balance', 'stripe-balance-history.csv').transactions, { groupBy: 'payout' });
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    assert.equal(byKey.po_9Z0TestPayout0001.payoutAmount, 55.36);
    assert.equal(byKey.po_9Z0TestPayout0001.difference, 0);
    const p2 = byKey.po_9Z0TestPayout0002;
    assert.deepEqual([p2.grossSales, p2.refunds, p2.fees, p2.payoutAmount, p2.difference, p2.date], [1601.79, -50, -62.66, 1489.13, 0, '2025-07-02']);
    assert.equal(byKey['(not yet paid out)'].difference, 11.35);
  });
  test('payout reconciliation: payout amount = sum of its rows', () => {
    const rows = summarizePayouts(P('stripe-payouts', 'stripe-payout-reconciliation.csv').transactions, { groupBy: 'payout' });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => [r.key, r.payoutAmount, r.date, r.hasPayoutRow]), [
      ['po_7X2TestPayoutA0001', 136.48, '2025-02-04', false],
      ['po_7X2TestPayoutB0002', 246, '2025-02-06', false],
    ]);
  });
  test('journal entries for payout reconciliation balance and hit the bank for the payout amount', () => {
    const out = write('qbo-journal', P('stripe-payouts', 'stripe-payout-reconciliation.csv').transactions, { sourceId: 'stripe-payouts', accounts: { bank: 'Business Checking', fees: 'Stripe Fees' } });
    const v = checkJournal(out.content);
    assert.deepEqual(v.errors, []);
    const lines = [...v.entries.values()].flatMap((e) => e.lines);
    assert.deepEqual(lines.filter((l) => l.account === 'Business Checking').map((l) => l.dr), ['136.48', '246.00']);
    assert.ok(lines.some((l) => l.account === 'Stripe Fees' && l.dr === '24.00'));
  });
  test('itemized balance change report: empty description unquoted, categories', () => {
    const r = P('stripe-balance', 'stripe-balance-change-itemized.csv');
    assert.equal(r.transactions[0].type, 'payment');
    assert.equal(find(r.transactions, (t) => t.raw.reporting_category === 'fee').type, 'fee');
    assert.throws(() => summarizePayouts(r.transactions, { groupBy: 'payout' }), /group by month/);
  });
});

describe('Etsy', () => {
  test('statement: BOM, symbols, "--", deposit amount from title, tax rows tagged', () => {
    const r = P('etsy', 'etsy-statement-2025-3.csv');
    const dep = find(r.transactions, (t) => t.type === 'payout');
    assert.equal(dep.amount, -1208.35);
    const sale = find(r.transactions, (t) => t.type === 'payment');
    assert.equal(sale.amount, 1250);
    assert.equal(find(r.transactions, (t) => /Sales tax paid by buyer/.test(t.description)).tax, -3.36);
  });
  test('statement month summary', () => {
    const [m] = summarizePayouts(P('etsy', 'etsy-statement-2025-3.csv').transactions, { groupBy: 'month' });
    assert.deepEqual([m.key, m.date, m.grossSales, m.refunds, m.fees, m.taxes, m.payoutAmount, m.difference], ['2025-03', '2025-03-31', 1250, -17.37, -4.83, -2.06, 1208.35, 17.39]);
  });
  test('sold orders: marketplace tax carved out of the fee gap', () => {
    const t = P('etsy', 'etsy-sold-orders.csv').transactions[0];
    assert.deepEqual([t.gross, t.fee, t.amount, t.tax], [38.94, 4.06, 34.88, -2.64]);
    const [m] = summarizePayouts([t], { groupBy: 'month' });
    assert.deepEqual([m.grossSales, m.fees, m.taxes], [38.94, -1.42, -2.64]);
  });
  test('deposits file dates "July 3, 2025" and thousands separators', () => {
    const r = P('etsy', 'etsy-deposits.csv');
    assert.deepEqual(r.transactions.map((t) => [t.date, t.amount]), [['2025-07-03', -116.58], ['2025-07-10', -1024]]);
  });
  test('sold order items file gets a helpful error', () => {
    const text = '"Sale Date","Item Name",Buyer,Quantity,Price,"Coupon Code","Coupon Details","Discount Amount","Shipping Discount","Order Shipping","Order Sales Tax","Item Total",Currency,"Transaction ID","Listing ID"\n06/22/23,"Sticker",buyer,1,3.00,,,0.00,0.00,0,0,3,USD,1,2\n';
    assert.throws(() => parse('etsy', text), /Sold Order Items/);
  });
});

describe('Airbnb', () => {
  test('payout rows group the rows below them; payout = sum of Amount', () => {
    const rows = summarizePayouts(P('airbnb', 'airbnb-paid.csv').transactions, { groupBy: 'payout' });
    assert.deepEqual(rows.map((r) => [r.key, r.payoutAmount, r.difference, r.date]), [['G-TESTPAYOUT1', 2581.58, 0, '2025-10-17'], ['G-TESTPAYOUT2', 190.95, 0, '2025-12-05']]);
  });
  test('reservation fee = gross - amount; adjustment fees signed; occupancy tax not in amount', () => {
    const r = P('airbnb', 'airbnb-paid.csv');
    const res = find(r.transactions, (t) => /HMTEST0004/.test(t.description));
    assert.deepEqual([res.amount, res.gross, res.fee], [3116.11, 3212.48, 96.37]);
    const adj = find(r.transactions, (t) => /HMTEST0002/.test(t.description));
    assert.deepEqual([adj.amount, adj.gross, adj.fee], [-629.53, -649, -19.47]);
    assert.equal(res.raw['Occupancy taxes'], '310.94');
  });
  test('Spanish headers are recognized', () => {
    const text = 'Fecha,Llega en esta fecha,Tipo,Código de confirmación,Fecha de la reservación,Fecha de inicio,Fecha de finalización,Noches,Huésped,Anuncio,Detalles,Código de referencia,Moneda,Monto,Total pagado,Tarifa por servicio,Tarifa de Pago rápido,Tarifa de limpieza,Ingresos brutos,Impuestos liquidados por Airbnb\n15/01/2025,20/01/2025,Payout,,,,,,,,Transferir a Ana,G-ES1,EUR,,90.00,,,,,\n15/01/2025,,Reservación,HMES1,01/01/2025,10/01/2025,12/01/2025,2,Luis Prueba,Piso,,,EUR,90.00,,3.00,,,93.00,\n';
    const r = parse('auto', text);
    assert.equal(r.meta.sourceId, 'airbnb');
    assert.equal(r.transactions.length, 2);
    assert.equal(find(r.transactions, (t) => t.type === 'payout').amount, -90);
  });
});

describe('Gumroad', () => {
  test('payout CSV: subtotal/totals skipped, refunds negate fees, payout fee row', () => {
    const r = P('gumroad', 'gumroad-payout.csv');
    assert.equal(r.meta.payoutTotal, 22.65);
    const ref = find(r.transactions, (t) => t.type === 'refund');
    assert.deepEqual([ref.amount, ref.gross, ref.fee], [-15.75, -19, -3.25]);
    assert.ok(!r.warnings.some((w) => /Totals row says/.test(w)));
    const [s] = summarizePayouts(r.transactions, { groupBy: 'payout' });
    assert.deepEqual([s.grossSales, s.refunds, s.fees, s.payoutAmount], [47, -19, -5.35, 22.65]);
  });
  test('sales CSV: free sale skipped, formula guard removed, refunds generated', () => {
    const r = P('gumroad', 'gumroad-sales.csv');
    assert.ok(r.warnings.some((w) => /free/.test(w)));
    assert.equal(r.transactions.filter((t) => t.type === 'refund').length, 2);
    assert.equal(find(r.transactions, (t) => /Partial refund/.test(t.description)).amount, -20);
  });
});

describe('Generic bank', () => {
  test('preamble skipped, debit/credit merged, day-first sniffed, footer ignored', () => {
    const r = P('generic-bank', 'generic-bank-debit-credit.csv');
    assert.equal(r.meta.dateOrder, 'dmy');
    assert.deepEqual(r.meta.mapping, { date: 'Date', description: 'Description', debit: 'Debit', credit: 'Credit' });
    assert.equal(r.transactions[1].amount, -125.4);
    assert.ok(r.warnings.some((w) => /without a date/.test(w)));
  });
  test('mapping override and invertSign', () => {
    const text = 'When,What,Value\n2025-01-02,Card purchase,12.50\n2025-01-03,Payment received,-100.00\n';
    const r = parse('generic-bank', text, { mapping: { date: 'When', description: 'What', amount: 'Value' }, invertSign: true });
    assert.deepEqual(r.transactions.map((t) => t.amount), [-12.5, 100]);
  });
  test('unsigned amount with a DR/CR indicator column', () => {
    const text = 'Date,Narrative,Amount,Type\n2025-01-02,Rent,500.00,DR\n2025-01-03,Sale,75.00,CR\n';
    assert.deepEqual(parse('generic-bank', text).transactions.map((t) => t.amount), [-500, 75]);
  });
});
