// Shared helpers for source parsers.
import { fromCents } from './money.js';

export function norm(h) {
  return String(h == null ? '' : h)
    .replace(/^﻿/, '')
    .replace(/^"+|"+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Build a lookup from normalized header name to column index.
export function columnMap(headerRow) {
  const map = new Map();
  headerRow.forEach((h, i) => {
    const k = norm(h);
    if (k && !map.has(k)) map.set(k, i);
  });
  return map;
}

// Find the first matching column among aliases. Returns index or -1.
export function pick(map, ...aliases) {
  for (const a of aliases) {
    const i = map.get(norm(a));
    if (i !== undefined) return i;
  }
  return -1;
}

export function hasAll(map, names) {
  return names.every((n) => map.has(norm(n)));
}

// Find the index of the header row: the first row (within maxScan) whose
// normalized cells include every required name.
export function findHeaderRow(rows, required, maxScan = 40) {
  const req = required.map(norm);
  const lim = Math.min(rows.length, maxScan);
  for (let i = 0; i < lim; i++) {
    const set = new Set(rows[i].map(norm));
    if (req.every((r) => set.has(r))) return i;
  }
  return -1;
}

export function cell(row, idx) {
  if (idx < 0 || idx >= row.length) return '';
  const v = row[idx];
  return v == null ? '' : String(v).trim();
}

// Tidy whitespace. A leading apostrophe that the exporting app added as a
// spreadsheet formula guard is kept on purpose: removing it would re-arm the
// formula in any spreadsheet that later opens our output.
export function cleanText(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

export function rawObject(header, row) {
  const o = {};
  const put = (k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  header.forEach((h, i) => {
    let k = String(h == null ? '' : h).replace(/^\ufeff/, '').trim();
    if (!k) k = `column${i + 1}`;
    if (Object.prototype.hasOwnProperty.call(o, k)) k = `${k}_${i + 1}`;
    put(k, row[i] === undefined ? '' : row[i]);
  });
  if (row.length > header.length) {
    for (let i = header.length; i < row.length; i++) if (row[i] !== '') put(`column${i + 1}`, row[i]);
  }
  return o;
}

// Construct a Txn from cents values. Optional fields are omitted when absent.
export function makeTxn(f) {
  const t = {
    date: f.date,
    description: f.description || '',
    amount: fromCents(f.amountCents),
    currency: (f.currency || 'USD').toUpperCase(),
  };
  if (f.grossCents !== undefined && f.grossCents !== null) t.gross = fromCents(f.grossCents);
  if (f.feeCents !== undefined && f.feeCents !== null) t.fee = fromCents(f.feeCents);
  if (f.netCents !== undefined && f.netCents !== null) t.net = fromCents(f.netCents);
  else if (t.gross !== undefined || t.fee !== undefined) t.net = t.amount;
  if (f.taxCents) t.tax = fromCents(f.taxCents);
  if (f.tipsCents) t.tips = fromCents(f.tipsCents);
  if (f.giftCardSalesCents) t.giftCardSales = fromCents(f.giftCardSalesCents);
  if (f.id) t.id = String(f.id);
  t.type = f.type || 'other';
  if (f.counterparty) t.counterparty = f.counterparty;
  if (f.payoutId) t.payoutId = String(f.payoutId);
  if (f.payoutDate) t.payoutDate = f.payoutDate;
  if (f.transferAccount) t.transferAccount = f.transferAccount;
  if (f.refundSide) t.refundSide = f.refundSide;
  t.raw = f.raw || {};
  return t;
}

export function finishMeta(transactions, rowsRead, rowsSkipped, extra = {}) {
  let from = null;
  let to = null;
  const counts = new Map();
  for (const t of transactions) {
    if (!from || t.date < from) from = t.date;
    if (!to || t.date > to) to = t.date;
    counts.set(t.currency, (counts.get(t.currency) || 0) + 1);
  }
  let currency = null;
  let best = -1;
  for (const [c, n] of counts) if (n > best) { best = n; currency = c; }
  const meta = { rowsRead, rowsSkipped, currency, dateRange: { from, to } };
  if (counts.size > 1) meta.currencies = [...counts.keys()].sort();
  return Object.assign(meta, extra);
}

// Sort by date ascending, stable (keeps file order within a day).
export function sortByDate(txns) {
  return txns
    .map((t, i) => [t, i])
    .sort((a, b) => (a[0].date < b[0].date ? -1 : a[0].date > b[0].date ? 1 : a[1] - b[1]))
    .map((x) => x[0]);
}

// Classify a funding source / destination label.
// - bank words (bank, checking, savings, credit union) -> bank
// - clear card evidence (Visa, Mastercard, American Express / Amex,
//   the word "card", Discover without a bank word, or a common card
//   product: Quicksilver, Venture, Savor, Sapphire, Freedom, Double Cash, Custom Cash) -> card
// - anything else ("Wells Fargo *0000", "Chime *1234", blank) -> bank, and
//   the label is reported so the parser can warn which account was used.
export function fundingKind(label, unclear) {
  const v = String(label || '').toLowerCase();
  if (/\b(bank|checking|chequing|savings|credit union)\b/.test(v)) return 'bank';
  // Card evidence: a card network, the word "card", or a well-known card product.
  if (/\b(visa|mastercard|master card|american express|amex|discover|card|quicksilver|venture|savor|sapphire|freedom|double cash|custom cash)\b/.test(v)) return 'card';
  if (unclear) unclear.add(String(label || '').trim() || '(blank)');
  return 'bank';
}

export function unclearFundingNote(unclear, vendor) {
  if (!unclear || !unclear.size) return null;
  const list = [...unclear].slice(0, 8).map((l) => `"${l}"`).join(', ');
  return `${vendor} funding or destination label(s) ${list} are not clearly a bank or a card, so the money moved with them is booked to your bank account. If one is really a card, move those lines to the card account in QuickBooks (or set the account in the options).`;
}

export function pendingNote(list, vendor) {
  if (!list.length) return null;
  const items = list.slice(0, 10).map((p) => `${p.date} ${(p.amount).toFixed(2)} (${p.description})`).join('; ');
  return `Left out ${list.length} pending transfer(s) or withdrawal(s) that had not completed when this file was exported: ${items}${list.length > 10 ? '; and more' : ''}. A later month's ${vendor} export will not include them, so export this period again after they complete.`;
}
