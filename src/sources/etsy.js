// Etsy exports. Layouts understood:
//  - Monthly Payment account statement (etsy_statement_YYYY_M.csv):
//    Date,Type,Title,Info,Currency,Amount,Fees & Taxes,Net[,Tax Details]
//    UTF-8 BOM, amounts with currency symbols, "--" placeholders, deposit
//    amount only inside the Title text, newest first.
//  - Sold Orders (EtsySoldOrdersYYYY[-M].csv): one row per order.
//  - Etsy Payments sales (EtsyDirectCheckoutPaymentsYYYY[-M].csv).
//  - Deposits (EtsyDepositsYYYY[-M].csv): Date,Amount,Currency,Status,Bank Account Ending Digits
import { fail } from '../errors.js';
import { parseMoney } from '../money.js';
import { parseDate } from '../dates.js';
import { resolveDecimal, resolveDateOrder } from '../locale.js';
import { columnMap, pick, cell, cleanText, rawObject, makeTxn, finishMeta, sortByDate, hasAll } from '../util.js';

function layout(rows) {
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const map = columnMap(rows[i]);
    if (hasAll(map, ['Date', 'Type', 'Title', 'Info', 'Currency', 'Amount', 'Fees & Taxes', 'Net'])) return { kind: 'statement', h: i, map };
    if (hasAll(map, ['Sale Date', 'Order ID', 'Order Total']) && (map.has('order net') || map.has('card processing fees'))) return { kind: 'orders', h: i, map };
    if (hasAll(map, ['Payment ID', 'Order ID', 'Gross Amount', 'Net Amount']) && (map.has('posted gross') || map.has('funds available'))) return { kind: 'payments', h: i, map };
    if (hasAll(map, ['Date', 'Amount', 'Currency', 'Status', 'Bank Account Ending Digits'])) return { kind: 'deposits', h: i, map };
    if (hasAll(map, ['Sale Date', 'Item Name', 'Transaction ID', 'Item Total'])) return { kind: 'items', h: i, map };
  }
  return null;
}

export function detect(rows) {
  const l = layout(rows);
  if (!l) return { score: 0 };
  const reasons = {
    statement: 'Found Etsy monthly statement columns (Type, Title, Info, Fees & Taxes, Net).',
    orders: 'Found Etsy Sold Orders columns (Sale Date, Order ID, Order Net).',
    payments: 'Found Etsy Payments sales columns (Payment ID, Gross Amount, Net Amount).',
    deposits: 'Found Etsy Deposits columns (Bank Account Ending Digits).',
    items: 'Found Etsy Sold Order Items columns.',
  };
  return { score: l.kind === 'items' ? 0.7 : 0.97, reason: reasons[l.kind] };
}

const TYPE_MAP = { sale: 'payment', refund: 'refund', fee: 'fee', marketing: 'fee', vat: 'fee', shipping: 'fee', deposit: 'payout', tax: 'other', payment: 'transfer', reserve: 'other', adjustment: 'other' };

function orderKey(title, info) {
  const m = /#\s*(\d{6,})/.exec(title) || /#\s*(\d{6,})/.exec(info) || /order:\s*(\d+)/i.exec(info);
  return m ? m[1] : '';
}

function parseStatement(rows, l, options, warnings) {
  const header = rows[l.h];
  const m = l.map;
  const c = { date: pick(m, 'Date'), type: pick(m, 'Type'), title: pick(m, 'Title'), info: pick(m, 'Info'), currency: pick(m, 'Currency'), amount: pick(m, 'Amount'), fees: pick(m, 'Fees & Taxes'), net: pick(m, 'Net') };
  const data = rows.slice(l.h + 1).filter((r) => !r.every((v) => v.trim() === ''));
  const decimal = resolveDecimal(data.flatMap((r) => [cell(r, c.amount), cell(r, c.fees), cell(r, c.net)]), options, warnings, 'this Etsy statement', '.');
  const dOrder = resolveDateOrder(data.map((r) => cell(r, c.date)), options, warnings, 'this Etsy statement', { order: 'mdy', reason: 'Etsy files we have seen always write month/day/year' });
  const txns = [];
  let read = 0;
  let skipped = 0;
  const unknownTypes = new Set();
  for (const row of data) {
    read++;
    const dateRaw = cell(row, c.date);
    const date = parseDate(dateRaw, dOrder);
    if (!date) { skipped++; warnings.push(`Skipped an Etsy row with an unreadable date "${dateRaw}".`); continue; }
    const typeRaw = cell(row, c.type);
    const tkey = typeRaw.toLowerCase();
    const title = cleanText(cell(row, c.title));
    const info = cleanText(cell(row, c.info));
    let net = parseMoney(cell(row, c.net), decimal);
    let type = TYPE_MAP[tkey];
    if (!type) { type = 'other'; unknownTypes.add(typeRaw); }
    if (tkey === 'deposit') {
      // The deposit amount only appears in the Title, e.g. "€20.51 sent to your bank account".
      // Linear scan (no backtracking regex): the token before the phrase.
      const at = title.toLowerCase().indexOf(' sent to your bank account');
      const token = at > 0 ? title.slice(Math.max(0, at - 40), at).trim().split(/\s+/).pop() : '';
      const amt = token ? parseMoney(token, decimal) : null;
      if (amt === null || Number.isNaN(amt)) { skipped++; warnings.push(`Skipped an Etsy deposit row we could not read the amount from: "${title}".`); continue; }
      net = -Math.abs(amt);
    }
    if (net === null || Number.isNaN(net)) {
      const a = parseMoney(cell(row, c.amount), decimal);
      const f = parseMoney(cell(row, c.fees), decimal);
      net = (a && !Number.isNaN(a) ? a : 0) + (f && !Number.isNaN(f) ? f : 0);
    }
    if (net === 0) { skipped++; continue; }
    if (tkey === 'fee' && /^credit for/i.test(title)) type = 'fee';
    const order = orderKey(title, info);
    const description = `${title || typeRaw}${info && !title.includes(info) ? ' (' + info + ')' : ''}`;
    const t = { date, description, amountCents: net, currency: cell(row, c.currency) || 'USD', type, raw: rawObject(header, row) };
    if (tkey === 'tax') t.taxCents = net;
    if (tkey === 'sale' || tkey === 'refund') { t.grossCents = net; t.feeCents = 0; t.netCents = net; }
    if (order) t.raw.orderId = order;
    txns.push(makeTxn(t));
  }
  if (unknownTypes.size) warnings.push(`Etsy row type(s) we have not seen before were kept as "other": ${[...unknownTypes].join(', ')}.`);
  warnings.push('Etsy statements do not say which sales each deposit paid out, so payout journal entries for Etsy are grouped by month.');
  return { txns: sortByDate(txns.reverse()), read, skipped };
}

function parseOrders(rows, l, options, warnings) {
  const header = rows[l.h];
  const m = l.map;
  const c = {
    date: pick(m, 'Sale Date'), order: pick(m, 'Order ID'), name: pick(m, 'Full Name', 'Buyer'), currency: pick(m, 'Currency'),
    total: pick(m, 'Order Total', 'Order total'), fees: pick(m, 'Card Processing Fees'), net: pick(m, 'Order Net'),
    adjTotal: pick(m, 'Adjusted Order Total'), adjNet: pick(m, 'Adjusted Net Order Amount'), status: pick(m, 'Status'),
    items: pick(m, 'Number of Items'),
  };
  const data = rows.slice(l.h + 1).filter((r) => !r.every((v) => v.trim() === ''));
  const dOrder = resolveDateOrder(data.map((r) => cell(r, c.date)), options, warnings, 'this Etsy orders file', { order: 'mdy', reason: 'Etsy order files we have seen always write month/day/year' });
  const txns = [];
  let read = 0;
  let skipped = 0;
  let adjusted = 0;
  for (const row of data) {
    read++;
    const date = parseDate(cell(row, c.date), dOrder);
    if (!date) { skipped++; warnings.push(`Skipped an Etsy order with an unreadable date "${cell(row, c.date)}".`); continue; }
    const total = parseMoney(cell(row, c.total));
    let net = parseMoney(cell(row, c.net));
    const fees = parseMoney(cell(row, c.fees));
    if (net === null || Number.isNaN(net)) { skipped++; warnings.push(`Skipped Etsy order ${cell(row, c.order)}: unreadable Order Net.`); continue; }
    const adjNet = parseMoney(cell(row, c.adjNet));
    if (adjNet && !Number.isNaN(adjNet)) adjusted++;
    const order = cell(row, c.order);
    const name = cleanText(cell(row, c.name));
    const t = {
      date, description: `Etsy order #${order}${name ? ' - ' + name : ''}`, amountCents: net, currency: cell(row, c.currency) || 'USD',
      id: order ? `order-${order}` : undefined, type: 'payment', counterparty: name || undefined, raw: rawObject(header, row),
    };
    if (total !== null && !Number.isNaN(total)) {
      t.grossCents = total;
      t.feeCents = total - net; // card processing fee plus any marketplace sales tax Etsy kept
      t.netCents = net;
      const f = fees && !Number.isNaN(fees) ? fees : 0;
      if (total - net !== f) t.taxCents = -(total - net - f);
    }
    txns.push(makeTxn(t));
  }
  warnings.push('The Etsy Sold Orders file has order totals and card processing fees only. Transaction fees, listing fees, ads and shipping labels are only in the monthly statement CSV (Finances > Monthly statements), which is the better file for your books.');
  if (adjusted) warnings.push(`${adjusted} Etsy order(s) have refund adjustments (Adjusted Net Order Amount). Refund dates are not in this file, so refunds are not included; use the monthly statement CSV to capture them.`);
  return { txns: sortByDate(txns), read, skipped };
}

function parsePayments(rows, l, options, warnings) {
  const header = rows[l.h];
  const m = l.map;
  const c = {
    id: pick(m, 'Payment ID'), order: pick(m, 'Order ID'), gross: pick(m, 'Gross Amount'), fees: pick(m, 'Fees'), net: pick(m, 'Net Amount'),
    currency: pick(m, 'Currency'), date: pick(m, 'Order Date'), name: pick(m, 'Buyer', 'Buyer Name', 'Buyer Username'), status: pick(m, 'Status'),
    refund: pick(m, 'Refund Amount'), adjNet: pick(m, 'Adjusted Net'),
  };
  const data = rows.slice(l.h + 1).filter((r) => !r.every((v) => v.trim() === ''));
  const dOrder = resolveDateOrder(data.map((r) => cell(r, c.date)), options, warnings, 'this Etsy payments file', { order: 'mdy', reason: 'Etsy order files we have seen always write month/day/year' });
  const txns = [];
  let read = 0;
  let skipped = 0;
  for (const row of data) {
    read++;
    const date = parseDate(cell(row, c.date), dOrder);
    const gross = parseMoney(cell(row, c.gross));
    const net = parseMoney(cell(row, c.net));
    if (!date || net === null || Number.isNaN(net)) { skipped++; warnings.push(`Skipped Etsy payment ${cell(row, c.id)}: unreadable date or amount.`); continue; }
    const name = cleanText(cell(row, c.name));
    const t = {
      date, description: `Etsy payment for order #${cell(row, c.order)}${name ? ' - ' + name : ''}`, amountCents: net,
      currency: cell(row, c.currency) || 'USD', id: cell(row, c.id) || undefined, type: 'payment', counterparty: name || undefined, raw: rawObject(header, row),
    };
    if (gross !== null && !Number.isNaN(gross)) { t.grossCents = gross; t.feeCents = gross - net; t.netCents = net; }
    txns.push(makeTxn(t));
  }
  warnings.push('The Etsy Payments sales file covers card processing only; Etsy transaction, listing and ad fees are in the monthly statement CSV.');
  return { txns: sortByDate(txns), read, skipped };
}

function parseDeposits(rows, l, options, warnings) {
  const header = rows[l.h];
  const m = l.map;
  const c = { date: pick(m, 'Date'), amount: pick(m, 'Amount'), currency: pick(m, 'Currency'), status: pick(m, 'Status'), bank: pick(m, 'Bank Account Ending Digits') };
  const data = rows.slice(l.h + 1).filter((r) => !r.every((v) => v.trim() === ''));
  const dOrder = resolveDateOrder(data.map((r) => cell(r, c.date)), options, warnings, 'this Etsy deposits file', { order: 'mdy', reason: 'Etsy files we have seen always write month/day/year' });
  const txns = [];
  let read = 0;
  let skipped = 0;
  for (const row of data) {
    read++;
    const status = cell(row, c.status);
    if (status && !/executed|complete|paid|sent/i.test(status)) { skipped++; continue; }
    const date = parseDate(cell(row, c.date), dOrder);
    const amt = parseMoney(cell(row, c.amount));
    if (!date || amt === null || Number.isNaN(amt) || amt === 0) { skipped++; continue; }
    const bank = cell(row, c.bank);
    txns.push(makeTxn({
      date, description: `Etsy deposit to bank${bank ? ' ending ' + bank : ''}`, amountCents: -Math.abs(amt),
      currency: cell(row, c.currency) || 'USD', type: 'payout', payoutId: `etsy-${date}-${amt}`, raw: rawObject(header, row),
    }));
  }
  warnings.push('Etsy deposits are shown as money leaving your Etsy balance (negative), the same way the monthly statement shows them.');
  return { txns: sortByDate(txns), read, skipped };
}

export function parse(rows, options = {}, warnings = []) {
  const l = layout(rows);
  if (!l) fail('WRONG_SOURCE', "This doesn't look like an Etsy export. The best file for your books is the monthly statement: Shop Manager > Finances > Monthly statements > pick a month > Generate CSV. Sold Orders and Deposits CSVs (Settings > Options > Download Data) also work.");
  if (l.kind === 'items') fail('UNSUPPORTED_LAYOUT', 'This is the Etsy Sold Order Items file (one row per item). It has no fees or payouts, so it cannot become a bank import. Please upload the monthly statement CSV (Finances > Monthly statements) or the Sold Orders CSV instead.');
  const fn = { statement: parseStatement, orders: parseOrders, payments: parsePayments, deposits: parseDeposits }[l.kind];
  const { txns, read, skipped } = fn(rows, l, options, warnings);
  return { transactions: txns, warnings, meta: finishMeta(txns, read, skipped, { etsyLayout: l.kind, timeZone: 'as exported (Etsy does not state a time zone)' }) };
}
