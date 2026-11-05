// Shopify Payments exports (Shopify admin > Finances > Payouts).
//
// shopify-transactions: "Export transactions" / payment transactions CSV,
//   Transaction Date,Type,Order,Card Brand,Card Source,Payout Status,
//   Payout Date,Available On,Amount,Fee,Net (Shopify help page), plus in real
//   exports Checkout, Payment Method Name, Presentment Amount, Presentment
//   Currency, Currency, VAT; newer files may add Payout ID (parser-only
//   evidence). Amount is in the payout currency, Fee positive, Net = Amount -
//   Fee. Transaction Date carries the store's UTC offset ("2023-10-31
//   12:00:42 +0100"); the store's local date is used as written, the same day
//   Shopify admin shows.
//
// shopify-payouts: payouts list export, one row per payout:
//   Payout Date,Status,Charges,Refunds,Adjustments,Reserved Funds,Fees,
//   Retried Amount,Total,Currency (real export). Each paid payout becomes its
//   parts plus the payout itself, so a Shopify balance account nets to zero
//   per payout and the journal gets one entry per payout.
// Header provenance: FORMATS.md, Shopify.
import { fail } from '../errors.js';
import { parseMoney, formatCents } from '../money.js';
import { parseDate } from '../dates.js';
import { resolveDecimal, resolveDateOrder } from '../locale.js';
import { columnMap, pick, cell, cleanText, rawObject, makeTxn, finishMeta, sortByDate, findHeaderRow } from '../util.js';

const TXN_REQUIRED = ['Transaction Date', 'Type', 'Payout Status', 'Payout Date', 'Available On', 'Amount', 'Fee', 'Net'];
const PAYOUT_REQUIRED = ['Payout Date', 'Status', 'Charges', 'Refunds', 'Adjustments', 'Reserved Funds', 'Fees', 'Total'];

// Shopify exports that are not money movements: refused with a pointer to
// the right file instead of falling through to the bank parser.
export function wrongExport(rows) {
  if (findHeaderRow(rows, ['Financial Status', 'Lineitem name']) >= 0) return 'This is a Shopify orders export. It lists what customers ordered, not the money Shopify Payments paid you, so it has no fees or payouts. In Shopify admin open Finances, then Payouts, and export the transactions (or the payouts list), then upload that file.';
  if (findHeaderRow(rows, ['Handle', 'Variant Price']) >= 0) return 'This is a Shopify products export, which has no transactions in it. In Shopify admin open Finances, then Payouts, and export the transactions (or the payouts list), then upload that file.';
  return null;
}

export function detect(rows, which) {
  if (which === 'shopify-transactions') {
    if (findHeaderRow(rows, TXN_REQUIRED, 5) < 0) return { score: 0 };
    return { score: 0.97, reason: 'Found Shopify Payments transaction columns (Payout Status, Payout Date, Available On, Amount, Fee, Net).' };
  }
  if (findHeaderRow(rows, PAYOUT_REQUIRED, 5) < 0) return { score: 0 };
  return { score: 0.97, reason: 'Found Shopify Payments payout columns (Charges, Refunds, Adjustments, Reserved Funds, Fees, Total).' };
}

export function parseTransactionsFile(rows, options = {}, warnings = []) {
  if (findHeaderRow(rows, TXN_REQUIRED, 5) < 0) {
    if (findHeaderRow(rows, PAYOUT_REQUIRED, 5) >= 0) fail('WRONG_SOURCE', 'This is the Shopify Payments payouts export (one row per payout), not the transactions export. Choose "Shopify Payments payouts CSV" as the source.');
    fail('WRONG_SOURCE', "This doesn't look like a Shopify Payments transactions export: we couldn't find the \"Payout Status\", \"Available On\" and \"Net\" columns. In Shopify admin open Finances, then Payouts, view the transactions and click Export.");
  }
  return parseTransactions(rows, options, warnings);
}

export function parsePayoutsFile(rows, options = {}, warnings = []) {
  if (findHeaderRow(rows, PAYOUT_REQUIRED, 5) < 0) {
    if (findHeaderRow(rows, TXN_REQUIRED, 5) >= 0) fail('WRONG_SOURCE', 'This is the Shopify Payments transactions export, not the payouts export. Choose "Shopify Payments transactions CSV" as the source.');
    fail('WRONG_SOURCE', "This doesn't look like a Shopify Payments payouts export: we couldn't find the \"Charges\", \"Reserved Funds\" and \"Total\" columns. In Shopify admin open Finances, then Payouts, and click Export.");
  }
  return parsePayouts(rows, options, warnings);
}

const num = (v, decimal) => {
  const m = parseMoney(v, decimal);
  return m === null || Number.isNaN(m) ? null : m;
};

// Shopify writes ISO dates. A file re-saved in a spreadsheet can show
// numeric dates instead; only those go through the order check.
// A decimal comma points to a day-first spreadsheet, so the US month-first
// default is only used for decimal-point files; otherwise the date order is
// asked for (or taken from options.dateOrder, marked as assumed).
function dateOrderFor(values, options, warnings, label, decimal) {
  const reSaved = values.filter((v) => /^\d{1,2}[\/.-]/.test(v));
  return reSaved.length ? resolveDateOrder(reSaved, options, warnings, label, decimal === '.' ? { order: 'mdy', reason: 'Shopify admin and US spreadsheets write month/day/year' } : null) : 'mdy';
}
const ADJ_NOTE = 'in a journal entry they are booked to "Uncategorized Income" (money added) or "Uncategorized Expense" (money taken), unless you set other account names. Reserved funds are your own money that Shopify holds back for a while: when they are released, book the release to the same account so it is not counted as income twice.';
function storeDate(raw, order) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw).trim());
  return m ? parseDate(`${m[1]}-${m[2]}-${m[3]}`, 'mdy') : parseDate(String(raw).trim().split(/\s+/)[0], order);
}

function mapType(type) {
  const t = type.toLowerCase().replace(/\s+/g, '_');
  if (t === 'charge') return { type: 'payment' };
  if (t === 'refund') return { type: 'refund', refundSide: 'sale' };
  if (t === 'dispute' || t === 'dispute_reversal' || t === 'chargeback' || t === 'chargeback_won' || t === 'chargeback_lost') return { type: 'refund', refundSide: 'sale' };
  if (t === 'payout') return { type: 'payout' };
  if (t.includes('fee')) return { type: 'fee' };
  return { type: 'other' }; // adjustment, reserve, reserved_funds, charge_adjustment, refund_adjustment, ...
}

function parseTransactions(rows, options, warnings) {
  const h = findHeaderRow(rows, TXN_REQUIRED, 5);
  const header = rows[h];
  const map = columnMap(header);
  const c = {
    date: pick(map, 'Transaction Date'), type: pick(map, 'Type'), order: pick(map, 'Order'), status: pick(map, 'Payout Status'),
    payoutDate: pick(map, 'Payout Date'), payoutId: pick(map, 'Payout ID'), amount: pick(map, 'Amount'), fee: pick(map, 'Fee'), net: pick(map, 'Net'),
    currency: pick(map, 'Currency'), method: pick(map, 'Payment Method Name'), card: pick(map, 'Card Brand'),
  };
  const data = rows.slice(h + 1).filter((r) => !r.every((v) => v.trim() === ''));
  const decimal = resolveDecimal(data.flatMap((r) => [cell(r, c.amount), cell(r, c.fee), cell(r, c.net)]), options, warnings, 'this Shopify file', '.');
  const dOrder = dateOrderFor(data.flatMap((r) => [cell(r, c.date), cell(r, c.payoutDate)]), options, warnings, 'this Shopify file', decimal);
  if (c.currency < 0) warnings.push(`This Shopify file has no Currency column, so the amounts are treated as ${(options.currency || 'USD').toUpperCase()}. If your payouts are in another currency, the currency in the converted file needs changing.`);
  const txns = [];
  let read = 0, skipped = 0, zero = 0, pending = 0, mismatched = 0, adjCents = 0;
  const unknownTypes = new Set();
  for (const row of data) {
    read++;
    const dateRaw = cell(row, c.date);
    const date = storeDate(dateRaw, dOrder);
    if (!date) { skipped++; warnings.push(`Skipped a Shopify row with an unreadable date "${dateRaw}".`); continue; }
    const amount = num(cell(row, c.amount), decimal);
    let net = num(cell(row, c.net), decimal);
    const fee = num(cell(row, c.fee), decimal);
    if (net === null) net = amount !== null && fee !== null ? amount - fee : amount;
    if (net === null) { skipped++; warnings.push(`Skipped a Shopify row dated ${dateRaw}: unreadable amount "${cell(row, c.net)}".`); continue; }
    if (net === 0 && !amount) { skipped++; zero++; continue; }
    const typeRaw = cell(row, c.type);
    const m = mapType(typeRaw);
    if (m.type === 'other' && !/adjust|reserve/i.test(typeRaw)) unknownTypes.add(typeRaw || '(blank)');
    const status = cell(row, c.status).toLowerCase();
    const paid = status === 'paid';
    if (!paid) pending++;
    const pDate = cell(row, c.payoutDate) ? storeDate(cell(row, c.payoutDate), dOrder) : null;
    const currency = (cell(row, c.currency) || options.currency || 'USD').toUpperCase();
    // Shopify pays out once per day per currency (UNVERIFIED as a written
    // rule): without a Payout ID column the payout date names the payout.
    const pid = cell(row, c.payoutId) || (pDate ? `shopify-${pDate}-${currency}` : '');
    const order = cell(row, c.order);
    const label = { payment: 'Shopify charge', refund: 'Shopify refund', payout: 'Shopify payout', fee: 'Shopify fee', other: `Shopify ${cleanText(typeRaw) || 'adjustment'}` }[m.type];
    const t = {
      date, description: order ? `${label} ${order}` : label, amountCents: m.type === 'payout' ? -Math.abs(net) : net, currency,
      type: m.type, refundSide: m.refundSide, payoutId: paid && pid ? pid : undefined, payoutDate: paid && pDate ? pDate : undefined,
      raw: rawObject(header, row),
    };
    if (m.type !== 'payout' && amount !== null && fee !== null && fee !== 0) {
      if (amount - fee === net) { t.grossCents = amount; t.feeCents = fee; t.netCents = net; } else mismatched++;
    }
    if (m.type === 'other') adjCents += Math.abs(t.amountCents);
    txns.push(makeTxn(t));
  }
  if (zero) warnings.push(`Left out ${zero} Shopify row(s) with a zero amount.`);
  if (c.payoutId < 0 && txns.some((t) => t.payoutId)) warnings.push('This file has no Payout ID column, so rows are grouped into payouts by their payout date and currency. If Shopify paid you twice on the same day in the same currency, those two payouts are combined into one deposit here; compare with your bank.');
  if (adjCents) warnings.push(`Shopify adjustments and reserved funds total ${formatCents(adjCents)}; ${ADJ_NOTE}`);
  if (pending) warnings.push(`${pending} Shopify row(s) are not marked paid yet (Payout Status pending or similar). They are included, but have not reached your bank; in a journal entry they go to the clearing account.`);
  if (mismatched) warnings.push(`${mismatched} Shopify row(s) have Amount minus Fee different from Net; we used Net and did not split the fee for them.`);
  if (unknownTypes.size) warnings.push(`Some Shopify rows have a type we do not recognise (${[...unknownTypes].join(', ')}); they are kept as adjustments. Check them in the preview.`);
  const sorted = sortByDate(txns.reverse());
  return { transactions: sorted, warnings, meta: finishMeta(sorted, read, skipped, { timeZone: 'as exported (the store time zone shown in the file)' }) };
}

function parsePayouts(rows, options, warnings) {
  const h = findHeaderRow(rows, PAYOUT_REQUIRED, 5);
  const header = rows[h];
  const map = columnMap(header);
  const c = {
    date: pick(map, 'Payout Date'), status: pick(map, 'Status'), charges: pick(map, 'Charges'), refunds: pick(map, 'Refunds'),
    adjustments: pick(map, 'Adjustments'), reserved: pick(map, 'Reserved Funds'), fees: pick(map, 'Fees'), retried: pick(map, 'Retried Amount'),
    total: pick(map, 'Total'), currency: pick(map, 'Currency'),
  };
  const data = rows.slice(h + 1).filter((r) => !r.every((v) => v.trim() === ''));
  const decimal = resolveDecimal(data.flatMap((r) => [c.charges, c.refunds, c.fees, c.total].map((i) => cell(r, i))), options, warnings, 'this Shopify payouts file', '.');
  const dOrder = dateOrderFor(data.map((r) => cell(r, c.date)), options, warnings, 'this Shopify payouts file', decimal);
  const txns = [];
  let read = 0, skipped = 0, notPaid = 0, unbalanced = 0, failedRows = 0, adjCents = 0;
  const retriedList = [];
  const feeCredits = [];
  const seen = new Map();
  for (const row of data) {
    read++;
    const dateRaw = cell(row, c.date);
    const date = storeDate(dateRaw, dOrder);
    if (!date) { skipped++; warnings.push(`Skipped a Shopify payout row with an unreadable date "${dateRaw}".`); continue; }
    const status = cell(row, c.status).toLowerCase();
    const failed = status === 'failed';
    if (status !== 'paid' && !failed) { skipped++; notPaid++; continue; }
    const v = (i) => (i < 0 ? 0 : num(cell(row, i), decimal) ?? 0);
    const charges = v(c.charges), refunds = -Math.abs(v(c.refunds)), adjustments = v(c.adjustments), reserved = v(c.reserved), retried = v(c.retried);
    const feesAbs = Math.abs(v(c.fees));
    const total = num(cell(row, c.total), decimal);
    if (total === null) { skipped++; warnings.push(`Skipped the Shopify payout of ${dateRaw}: unreadable Total "${cell(row, c.total)}".`); continue; }
    // Fees are positive (paid) in real exports; a negative value is read by
    // the sign that makes the row add up to Total (a fee paid or a fee credit).
    const rest = charges + refunds + adjustments + reserved + retried;
    let feeCents;
    if (rest - feesAbs === total) feeCents = -feesAbs;
    else if (rest + feesAbs === total) { feeCents = feesAbs; feeCredits.push(`${formatCents(feesAbs)} on ${date}`); }
    else { skipped++; unbalanced++; warnings.push(`Skipped the Shopify payout of ${dateRaw}: Charges, Refunds, Adjustments, Reserved Funds, Fees and Retried Amount add up to ${formatCents(rest - feesAbs)} (or ${formatCents(rest + feesAbs)} if the fee is a credit), not to its Total ${formatCents(total)}. Check that payout in Shopify.`); continue; }
    const currency = (cell(row, c.currency) || options.currency || 'USD').toUpperCase();
    const raw = rawObject(header, row);
    if (failed) {
      // The sales and fees inside a failed payout happened; the money stays
      // in the Shopify balance (clearing) until a later payout retries it.
      failedRows++;
      const fpart = (cents, type, description, extra = {}) => { if (cents) txns.push(makeTxn({ date, description, amountCents: cents, currency, type, raw, ...extra })); };
      fpart(charges, 'payment', `Shopify charges (failed payout ${date})`);
      fpart(refunds, 'refund', `Shopify refunds (failed payout ${date})`, { refundSide: 'sale' });
      fpart(adjustments, 'other', `Shopify adjustments (failed payout ${date})`);
      fpart(reserved, 'other', `Shopify reserved funds (failed payout ${date})`);
      fpart(feeCents, 'fee', `Shopify fees (failed payout ${date})`);
      adjCents += Math.abs(adjustments) + Math.abs(reserved);
      continue;
    }
    const n = (seen.get(`${date}|${currency}`) || 0) + 1;
    seen.set(`${date}|${currency}`, n);
    const pid = `shopify-payout-${date}-${currency}${n > 1 ? `-${n}` : ''}`;
    const part = (cents, type, description, extra = {}) => { if (cents) txns.push(makeTxn({ date, description, amountCents: cents, currency, type, payoutId: pid, payoutDate: date, raw, ...extra })); };
    part(charges, 'payment', `Shopify charges (payout ${date})`);
    part(refunds, 'refund', `Shopify refunds (payout ${date})`, { refundSide: 'sale' });
    part(adjustments, 'other', `Shopify adjustments (payout ${date})`);
    part(reserved, 'other', `Shopify reserved funds (payout ${date})`);
    part(feeCents, 'fee', `Shopify fees (payout ${date})`);
    // Retried Amount is money from an earlier failed payout that was already
    // booked when it was earned: it is paid out of the balance, not income.
    if (retried) retriedList.push(`${formatCents(retried)} on ${date}`);
    part(-total, 'payout', `Shopify payout ${date}`);
    adjCents += Math.abs(adjustments) + Math.abs(reserved);
  }
  if (notPaid) warnings.push(`Left out ${notPaid} Shopify payout row(s) that are scheduled or in transit; they will appear as paid in a later export.`);
  if (failedRows) warnings.push(`${failedRows} Shopify payout(s) failed. Their sales, refunds and fees are still included, but no money reached your bank for them, so in a journal entry that money stays in the clearing account ("Uncategorized Asset" unless you set another) until Shopify pays it in a later payout.`);
  if (feeCredits.length) warnings.push(`Some Shopify payouts show fees as a credit to you (${feeCredits.join(', ')}), because that is the only way their columns add up to the Total. They are booked as negative fees; check them against Shopify.`);
  if (retriedList.length) warnings.push(`Some payouts include a Retried Amount (${retriedList.join(', ')}). That is money from an earlier failed payout, already counted when it was earned, so it is not booked as income again: in a journal entry it comes out of the clearing account ("Uncategorized Asset" unless you set another).`);
  if (unbalanced) warnings.push(`${unbalanced} Shopify payout row(s) were left out because their columns do not add up.`);
  if (adjCents) warnings.push(`Shopify adjustments and reserved funds total ${formatCents(adjCents)}; ${ADJ_NOTE}`);
  const sorted = sortByDate(txns);
  return { transactions: sorted, warnings, meta: finishMeta(sorted, read, skipped, { timeZone: 'as exported' }) };
}
