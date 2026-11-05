// Gumroad exports.
//  - Payout CSV (Payouts page > download): Type,Date,Purchase ID,Item Name,
//    Buyer Name,Buyer Email,Taxes ($),Shipping ($),Sale Price ($),
//    Gumroad Fees ($),Net Total ($). Ends with optional "Subtotal - ..."
//    rows and a "Totals" row. Refunds, chargebacks and fees are dated rows.
//  - Sales CSV (Sales > Export): one row per purchase, refunds only flagged.
import { fail } from '../errors.js';
import { parseMoney } from '../money.js';
import { parseDate } from '../dates.js';
import { utcDateReader } from '../locale.js';
import { columnMap, pick, cell, cleanText, rawObject, makeTxn, finishMeta, sortByDate, hasAll } from '../util.js';

function layout(rows) {
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const map = columnMap(rows[i]);
    if (hasAll(map, ['Type', 'Date', 'Purchase ID', 'Sale Price ($)', 'Net Total ($)']) && map.has('gumroad fees ($)')) return { kind: 'payout', h: i, map };
    if (hasAll(map, ['Purchase ID', 'Sale Price ($)', 'Net Total ($)']) && (map.has('purchase date') || map.has('purchase time (utc timezone)'))) return { kind: 'sales', h: i, map };
  }
  return null;
}

export function detect(rows) {
  const l = layout(rows);
  if (!l) return { score: 0 };
  return { score: 0.97, reason: l.kind === 'payout' ? 'Found Gumroad payout columns (Type, Purchase ID, Gumroad Fees ($), Net Total ($)).' : 'Found Gumroad sales columns (Purchase ID, Sale Price ($), Net Total ($)).' };
}

function mapType(t) {
  const s = t.toLowerCase();
  if (s === 'sale') return 'payment';
  if (s.includes('refund') && !s.includes('fee')) return 'refund';
  if (s === 'chargeback') return 'refund';
  if (s.includes('fee')) return 'fee';
  if (s.includes('payouts')) return 'other';
  if (s.includes('credit')) return 'other';
  return 'other';
}

const money = (row, i) => {
  const v = parseMoney(cell(row, i));
  return v === null || Number.isNaN(v) ? null : v;
};

function parsePayout(rows, l, options, warnings) {
  const header = rows[l.h];
  const m = l.map;
  const c = {
    type: pick(m, 'Type'), date: pick(m, 'Date'), id: pick(m, 'Purchase ID'), item: pick(m, 'Item Name'), buyer: pick(m, 'Buyer Name'),
    email: pick(m, 'Buyer Email'), taxes: pick(m, 'Taxes ($)'), price: pick(m, 'Sale Price ($)'), fees: pick(m, 'Gumroad Fees ($)'), net: pick(m, 'Net Total ($)'),
  };
  const txns = [];
  let read = 0;
  let skipped = 0;
  let totalsNet = null;
  for (let r = l.h + 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.every((v) => v.trim() === '')) continue;
    const typeRaw = cell(row, c.type);
    if (/^totals?$/i.test(typeRaw)) { totalsNet = money(row, c.net); continue; }
    if (/^subtotal/i.test(typeRaw)) continue;
    read++;
    const date = parseDate(cell(row, c.date));
    if (!date) { skipped++; warnings.push(`Skipped a Gumroad row with an unreadable date "${cell(row, c.date)}".`); continue; }
    const net = money(row, c.net);
    if (net === null) { skipped++; warnings.push(`Skipped a Gumroad ${typeRaw} row dated ${date}: unreadable Net Total.`); continue; }
    if (net === 0) { skipped++; continue; }
    const price = money(row, c.price);
    const fees = money(row, c.fees);
    const item = cleanText(cell(row, c.item));
    const buyer = cleanText(cell(row, c.buyer)) || cleanText(cell(row, c.email));
    const pid = cell(row, c.id);
    // A purchase can have a Sale row and later a Refund row: the id includes the type.
    const id = pid ? `${pid}:${typeRaw.toLowerCase().replace(/\s+/g, '-')}` : undefined;
    const t = {
      date, description: [typeRaw, item, buyer].filter(Boolean).join(' - '), amountCents: net, currency: 'USD', id,
      type: mapType(typeRaw), counterparty: buyer || undefined, raw: rawObject(header, row),
    };
    if (price !== null && fees !== null) { t.grossCents = price; t.feeCents = fees; t.netCents = net; }
    txns.push(makeTxn(t));
  }
  const sum = txns.reduce((s, t) => s + Math.round(t.amount * 100), 0);
  if (totalsNet !== null && totalsNet !== sum) warnings.push(`The Gumroad Totals row says ${(totalsNet / 100).toFixed(2)} net, but the rows add up to ${(sum / 100).toFixed(2)}. Some rows may be missing or unreadable.`);
  if (txns.length) {
    // One payout file covers one payout. Tag rows so they group into a single payout entry.
    const last = txns.reduce((a, t) => (t.date > a ? t.date : a), txns[0].date);
    const pidTag = options.payoutId || `gumroad-${last}`;
    for (const t of txns) t.payoutId = pidTag;
  }
  warnings.push('Gumroad amounts are in US dollars. Taxes ($) that Gumroad collects as the seller of record are not part of your net and are kept in each row\'s raw data.');
  if (options.timeZone) warnings.push('The Gumroad payout CSV gives UTC calendar dates without times, so they cannot be converted to your time zone; they are kept as UTC dates.');
  const extra = { timeZone: 'UTC (dates only, not convertible)' };
  if (totalsNet !== null) extra.payoutTotal = totalsNet / 100;
  return { txns: sortByDate(txns), read, skipped, extra };
}

function parseSales(rows, l, options, warnings) {
  const header = rows[l.h];
  const m = l.map;
  const c = {
    id: pick(m, 'Purchase ID'), item: pick(m, 'Item Name'), buyer: pick(m, 'Buyer Name'), email: pick(m, 'Purchase Email', 'Buyer Email'),
    date: pick(m, 'Purchase Date'), time: pick(m, 'Purchase Time (UTC timezone)'), price: pick(m, 'Sale Price ($)'), fees: pick(m, 'Fees ($)'),
    net: pick(m, 'Net Total ($)'), refunded: pick(m, 'Refunded?'), full: pick(m, 'Fully Refunded?'), partial: pick(m, 'Partial Refund ($)'),
    disputed: pick(m, 'Disputed?'), won: pick(m, 'Dispute Won?'),
  };
  const txns = [];
  let read = 0;
  let skipped = 0;
  let refunds = 0;
  let free = 0;
  const tzMeta = {};
  const utcDate = c.time >= 0 ? utcDateReader(options, warnings, tzMeta, 'Gumroad', rows.slice(l.h + 1).map((r) => cell(r, c.time))) : null;
  if (!utcDate) tzMeta.timeZone = 'UTC (dates only, not convertible)';
  for (let r = l.h + 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.every((v) => v.trim() === '')) continue;
    if (/^totals?$/i.test(cell(row, 0))) continue;
    read++;
    const date = utcDate && cell(row, c.time) ? utcDate(cell(row, c.time)) : parseDate(cell(row, c.date));
    if (!date) { skipped++; warnings.push(`Skipped a Gumroad sale with an unreadable date "${cell(row, c.date)}".`); continue; }
    const price = money(row, c.price);
    const fees = money(row, c.fees) || 0;
    let net = money(row, c.net);
    if (net === null && price !== null) net = price - fees;
    if (net === null) { skipped++; continue; }
    if (net === 0 && !price) { skipped++; free++; continue; }
    const item = cleanText(cell(row, c.item));
    const buyer = cleanText(cell(row, c.buyer)) || cleanText(cell(row, c.email));
    const pid = cell(row, c.id);
    txns.push(makeTxn({
      date, description: ['Sale', item, buyer].filter(Boolean).join(' - '), amountCents: net, currency: 'USD', id: pid ? `${pid}:sale` : undefined,
      type: 'payment', counterparty: buyer || undefined, grossCents: price ?? net, feeCents: fees, netCents: net, raw: rawObject(header, row),
    }));
    const flag = (i) => /^(1|true|yes)$/i.test(cell(row, i));
    const lostDispute = flag(c.disputed) && !flag(c.won);
    if (flag(c.full) || lostDispute) {
      refunds++;
      txns.push(makeTxn({
        date, description: [lostDispute && !flag(c.full) ? 'Chargeback' : 'Refund', item, buyer].filter(Boolean).join(' - '), amountCents: -net, currency: 'USD',
        id: pid ? `${pid}:refund` : undefined, type: 'refund', counterparty: buyer || undefined, grossCents: -(price ?? net), feeCents: -fees, netCents: -net,
        raw: { generatedFrom: pid, reason: lostDispute ? 'disputed' : 'fully refunded' },
      }));
    } else {
      const partial = money(row, c.partial);
      if (partial) {
        refunds++;
        txns.push(makeTxn({
          date, description: ['Partial refund', item, buyer].filter(Boolean).join(' - '), amountCents: -Math.abs(partial), currency: 'USD',
          id: pid ? `${pid}:partial-refund` : undefined, type: 'refund', counterparty: buyer || undefined, raw: { generatedFrom: pid, reason: 'partial refund' },
        }));
      }
    }
  }
  if (free) warnings.push(`Left out ${free} free (zero-price) Gumroad purchase(s).`);
  if (refunds) warnings.push(`${refunds} Gumroad refund(s) or chargeback(s) were found. The sales CSV does not record refund dates, so refunds are dated on the purchase date. For exact dates use the Gumroad payout CSV instead.`);
  return { txns: sortByDate(txns), read, skipped, extra: tzMeta };
}

export function parse(rows, options = {}, warnings = []) {
  const l = layout(rows);
  if (!l) fail('WRONG_SOURCE', "This doesn't look like a Gumroad export. For your books, use the payout CSV: open Payouts, click the download button next to a paid payout. The Sales CSV (Sales > Export) also works.");
  const res = l.kind === 'payout' ? parsePayout(rows, l, options, warnings) : parseSales(rows, l, options, warnings);
  return { transactions: res.txns, warnings, meta: finishMeta(res.txns, res.read, res.skipped, Object.assign({ gumroadLayout: l.kind }, res.extra)) };
}
