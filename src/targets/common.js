// Shared preparation for every writer: validation, currency selection,
// optional fee split, integer cents and deterministic FITIDs.
import { fail } from '../errors.js';
import { toCents } from '../money.js';
import { fnv1a64 } from '../hash.js';
import { isValidYMD } from '../dates.js';

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

const TYPES = new Set(['payment', 'refund', 'fee', 'transfer', 'payout', 'other']);
// Kept in step with LINE_ACCOUNT_KEYS in journal.js (not imported from there
// to avoid a cycle: journal.js imports this module).
const JOURNAL_LINE_ACCOUNTS = new Set(['sales', 'refunds', 'fees', 'taxes', 'clearing', 'adjustmentsIncome', 'adjustmentsExpense', 'advertising', 'fulfillmentFees', 'reserve', 'taxesPayable']);
const MAX_CENTS = 99999999999; // 11 digits: QuickBooks rejects 12 or more

function textField(v, i, name) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  fail('BAD_TXN', `Transaction ${i + 1} has a ${name} that is not text.`);
  return '';
}

function moneyField(v, i, name, date) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) fail('BAD_TXN', `Transaction ${i + 1} (${date}) has a ${name} that is not a number ("${String(v)}"). Amounts must be numbers like -12.5.`);
  const c = Math.round(v * 100);
  if (Math.abs(c) > MAX_CENTS) fail('AMOUNT_TOO_LARGE', `A transaction on ${date} is too large to import (${v}). QuickBooks rejects amounts with 12 or more digits, and amounts this large are almost always a mistake in the file.`);
  return c / 100;
}

// Validate and normalize transactions coming from parse() or from the site
// (which may have edited them). Returns shallow copies with clean types.
export function normalizeTxns(transactions) {
  if (!Array.isArray(transactions)) fail('BAD_INPUT', 'There are no transactions to convert.');
  if (!transactions.length) fail('NO_TRANSACTIONS', 'There are no transactions to convert. The file may be empty, or every row was skipped (see the warnings).');
  return transactions.map((t, i) => {
    if (!t || typeof t !== 'object') fail('BAD_TXN', `Transaction ${i + 1} is empty or not a transaction.`);
    const m = ISO.exec(typeof t.date === 'string' ? t.date : '');
    if (!m || !isValidYMD(+m[1], +m[2], +m[3])) fail('BAD_TXN', `Transaction ${i + 1} has an invalid date "${String(t.date)}". Dates must be YYYY-MM-DD.`);
    if (t.amount === undefined || t.amount === null) fail('BAD_TXN', `Transaction ${i + 1} (${t.date}) has no amount.`);
    const out = { ...t };
    out.amount = moneyField(t.amount, i, 'amount', t.date);
    for (const k of ['gross', 'fee', 'net', 'tax', 'tips', 'giftCardSales']) { const v = moneyField(t[k], i, k, t.date); if (v === undefined) delete out[k]; else out[k] = v; }
    out.description = textField(t.description, i, 'description');
    const cur = t.currency === undefined || t.currency === null || t.currency === '' ? 'USD' : t.currency;
    if (typeof cur !== 'string' || !/^[A-Za-z]{3}$/.test(cur)) fail('BAD_TXN', `Transaction ${i + 1} (${t.date}) has an invalid currency "${String(cur)}". Use a 3-letter code such as USD.`);
    out.currency = cur.toUpperCase();
    const type = t.type === undefined || t.type === null || t.type === '' ? 'other' : t.type;
    if (!TYPES.has(type)) fail('BAD_TXN', `Transaction ${i + 1} (${t.date}) has an unknown type "${String(type)}". Use payment, refund, fee, transfer, payout or other.`);
    out.type = type;
    for (const k of ['id', 'counterparty', 'payoutId']) { const v = textField(t[k], i, k); if (v) out[k] = v; else delete out[k]; }
    if (t.transferAccount !== undefined && t.transferAccount !== null && t.transferAccount !== 'bank' && t.transferAccount !== 'card') fail('BAD_TXN', `Transaction ${i + 1} (${t.date}) has transferAccount "${String(t.transferAccount)}"; use "bank" or "card".`);
    if (t.refundSide !== undefined && t.refundSide !== null && t.refundSide !== 'sale' && t.refundSide !== 'purchase') fail('BAD_TXN', `Transaction ${i + 1} (${t.date}) has refundSide "${String(t.refundSide)}"; use "sale" or "purchase".`);
    if (t.journalLine !== undefined && t.journalLine !== null && (typeof t.journalLine !== 'string' || !t.journalLine.trim() || t.journalLine.length > 200)) fail('BAD_TXN', `Transaction ${i + 1} (${t.date}) has a journalLine that is not a short text label.`);
    if (t.journalAccount !== undefined && t.journalAccount !== null && !JOURNAL_LINE_ACCOUNTS.has(t.journalAccount)) fail('BAD_TXN', `Transaction ${i + 1} (${t.date}) has journalAccount "${String(t.journalAccount)}"; use one of: ${[...JOURNAL_LINE_ACCOUNTS].join(', ')}.`);
    if (t.payoutDate !== undefined && t.payoutDate !== null) {
      const pm = ISO.exec(typeof t.payoutDate === 'string' ? t.payoutDate : '');
      if (!pm || !isValidYMD(+pm[1], +pm[2], +pm[3])) fail('BAD_TXN', `Transaction ${i + 1} has an invalid payoutDate "${String(t.payoutDate)}".`);
    }
    return out;
  });
}

export const validateTxns = normalizeTxns;

// Pick the currency to write. Files hold one currency; other rows are left
// out with a warning.
export function selectCurrency(transactions, options, warnings) {
  const counts = new Map();
  for (const t of transactions) { const c = (t.currency || 'USD').toUpperCase(); counts.set(c, (counts.get(c) || 0) + 1); }
  if (options.currency !== undefined && options.currency !== null && !/^[A-Za-z]{3}$/.test(String(options.currency))) fail('BAD_OPTION', 'The currency option must be a 3-letter code such as USD.');
  let currency = options.currency ? String(options.currency).toUpperCase() : null;
  if (!currency) {
    let best = -1;
    for (const [c, n] of counts) if (n > best) { best = n; currency = c; }
  }
  const kept = transactions.filter((t) => (t.currency || 'USD').toUpperCase() === currency);
  const dropped = transactions.length - kept.length;
  if (dropped) {
    const others = [...counts.keys()].filter((c) => c !== currency).sort().join(', ');
    warnings.push(`Left out ${dropped} transaction(s) in ${others}: an import file can only hold one currency, and this one is ${currency}. Download again with the other currency selected to get those.`);
  }
  if (!kept.length) fail('NO_TRANSACTIONS', `None of the transactions are in ${currency}.`);
  return { currency, kept };
}

// Expand each Txn into output lines with integer cents and a FITID.
// FITID base = hash(date, amount in cents, description, id if present, type)
// plus an occurrence number among rows identical on all of those, decided
// row by row (a repeated id elsewhere never changes another row's FITID).
// The same row in two overlapping exports gets the same FITID; two
// different rows never share one. Unsplit, the net line uses the base. With
// includeFeesAsSeparateRows the gross line is base + "G" and the fee line
// base + "F", so a net line and a gross line are never taken for the same
// transaction.
export function toLines(transactions, options = {}) {
  const split = !!options.includeFeesAsSeparateRows;
  const seen = new Map();
  const lines = [];
  const ordered = transactions
    .map((t, i) => [t, i])
    .sort((a, b) => (a[0].date < b[0].date ? -1 : a[0].date > b[0].date ? 1 : a[1] - b[1]))
    .map((x) => x[0]);
  for (const t of ordered) {
    const amount = toCents(t.amount);
    const desc = (t.description || '').trim();
    let base = `${t.date}|${amount}|${desc}|${t.id || ''}|${t.type || 'other'}`;
    const k = seen.get(base) || 0;
    seen.set(base, k + 1);
    base += `|${k}`;
    const parent = fitid(base);
    const fee = toCents(t.fee);
    const gross = toCents(t.gross);
    if (split && fee && gross !== null && !Number.isNaN(gross) && !Number.isNaN(fee) && gross - fee === amount && t.type !== 'fee') {
      lines.push({ txn: t, date: t.date, cents: gross, name: t.counterparty || desc, memo: desc, fitid: parent + 'G', kind: 'gross' });
      lines.push({ txn: t, date: t.date, cents: -fee, name: 'Fee', memo: `Fee: ${desc}`, fitid: parent + 'F', kind: 'fee' });
    } else {
      lines.push({ txn: t, date: t.date, cents: amount, name: t.counterparty || desc, memo: desc, fitid: parent, kind: 'txn' });
    }
  }
  return lines;
}

export const SPLIT_WARNING = 'Fees are written as separate lines. Transaction ids differ between split and unsplit files, so do not import the same period both ways: pick one setting and keep it for this account.';

export function noteSplit(options, warnings) {
  if (options.includeFeesAsSeparateRows) warnings.push(SPLIT_WARNING);
}

// Spreadsheet formula guard for text cells we write: a cell starting with
// = + - @ tab or CR is prefixed with an apostrophe. Amount and date cells are
// generated by the engine and never pass through here.
export function csvSafe(s) {
  const v = String(s == null ? '' : s);
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

export function fitid(key) {
  return fnv1a64(key).toUpperCase();
}

// ASCII-only text for picky importers: fold accents, drop emoji and
// control characters, collapse whitespace.
export function asciiText(s) {
  return String(s == null ? '' : s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–\u2014−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function unicodeText(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, '').replace(/\s+/g, ' ').trim();
}

export function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n).trimEnd();
}

export function dateRange(lines) {
  let from = lines[0].date;
  let to = lines[0].date;
  for (const l of lines) { if (l.date < from) from = l.date; if (l.date > to) to = l.date; }
  return { from, to };
}

export function sumCents(lines) {
  return lines.reduce((s, l) => s + l.cents, 0);
}

export function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export';
}

// Amount size check: QuickBooks rejects amounts with 12 or more digits.
export function checkAmountDigits(lines) {
  for (const l of lines) {
    if (Math.abs(l.cents) > MAX_CENTS) fail('AMOUNT_TOO_LARGE', `A transaction on ${l.date} is too large for QuickBooks (${(l.cents / 100).toFixed(2)}). QuickBooks rejects amounts with 12 or more digits.`);
  }
}
