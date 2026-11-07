// Walmart Marketplace Recon report (reconciliation / settlement report), v1,
// CSV (Seller Center Payments, or the reconreport API's CSV file). Sources
// for every rule below: research/2026-11-06-marketplace-payout-formats.md
// and FORMATS.md, Appendix G.
//
// Layout (Walmart's Recon Report JSON documentation, one real report pulled
// through the API and published as fixtures, and a public importer that
// reads the CSV by these header names): one header row, one
// "PaymentSummary" row per report carrying Period Start Date, Period End
// Date, Currency, Total Payable and Transaction Posted Timestamp, then one
// row per (order line event, amount component): Transaction Type (Sale,
// Refund, Adjustment), Amount Type (Product Price, Shipping, Commission on
// Product, Commission on Shipping, Product tax, Product tax withheld,
// Shipping tax, Shipping tax withheld, Fee/Reimbursement) and a signed
// Amount. Currency is empty on item rows.
//
// The report becomes one entry: named lines plus the payout of Total
// Payable, dated on the PaymentSummary row's Transaction Posted Timestamp.
// The rows are summed and compared with Total Payable; a mismatch is a
// WARNING and the gap goes to clearing (UNVERIFIED: no complete real report
// was available to confirm that the rows add up to Total Payable).
import { fail } from '../errors.js';
import { parseMoney, formatCents } from '../money.js';
import { parseDate } from '../dates.js';
import { columnMap, pick, cell, rawObject, makeTxn, finishMeta, findHeaderRow, norm } from '../util.js';

export const MARKER = 'Walmart recon';
const REQUIRED = ['Period Start Date', 'Total Payable', 'Transaction Type', 'Amount Type', 'Amount'];

const JSON_MSG = 'This is the JSON form of the Walmart Recon report (from the reconFileJson API). This converter reads the CSV form. In Seller Center open Payments, download the reconciliation report for the payment period as CSV (or call the reconFile API for the CSV), and upload that file.';

export function wrongExport(rows) {
  const head = rows.slice(0, 3).map((r) => r.join(',')).join('\n');
  if (/^\s*[{[]/.test(head) && /Total Payable|PaymentSummary|reportData/.test(head)) return JSON_MSG;
  return null;
}

export function detect(rows) {
  if (findHeaderRow(rows, REQUIRED, 5) >= 0) return { score: 0.98, reason: 'Found Walmart Recon report columns (Period Start Date, Total Payable, Transaction Type, Amount Type, Amount).' };
  return { score: 0 };
}

const TAX_IN = 'Sales tax charged to buyers';
const TAX_MF = 'Sales tax kept by Walmart (marketplace facilitator)';
// (Transaction Type or *) | Amount Type, lower case. Every Amount Type below
// was seen in the real report.
const LINES = {
  'sale|product price': { kind: 'sale', line: 'Product sales' },
  'sale|shipping': { kind: 'sale', line: 'Shipping charged to buyers' },
  'refund|product price': { kind: 'refund', line: 'Refunds: product' },
  'refund|shipping': { kind: 'refund', line: 'Refunds: shipping' },
  '*|commission on product': { kind: 'fee', line: 'Walmart commission' },
  '*|commission on shipping': { kind: 'fee', line: 'Walmart commission' },
  '*|product tax': { kind: 'tax', line: TAX_IN },
  '*|shipping tax': { kind: 'tax', line: TAX_IN },
  '*|product tax withheld': { kind: 'tax', line: TAX_MF },
  '*|shipping tax withheld': { kind: 'tax', line: TAX_MF },
};

function classify(type, amountType, desc) {
  const t = norm(type); const a = norm(amountType);
  if (t === 'adjustment' && a === 'fee/reimbursement') {
    if (/shipping label/i.test(desc)) return { kind: 'fee', line: 'Walmart shipping labels', account: 'fulfillmentFees' };
    return null;
  }
  if (t !== 'sale' && t !== 'refund') return null;
  return LINES[`${t}|${a}`] || LINES[`*|${a}`] || null;
}

const mdy = (s) => {
  const m = String(s || '').trim().match(/^(\d{1,2}\/\d{1,2}\/\d{4})/);
  return m ? parseDate(m[1], 'mdy') : null;
};

export function parse(rows, options = {}, warnings = []) {
  const wrong = wrongExport(rows);
  if (wrong) fail('WRONG_SOURCE', wrong);
  const h = findHeaderRow(rows, REQUIRED, 5);
  if (h < 0) fail('MISSING_COLUMNS', 'This does not look like a Walmart Recon report: it needs the columns Period Start Date, Total Payable, Transaction Type, Amount Type and Amount. In Seller Center open Payments and download the reconciliation (recon) report for a payment period as CSV.');
  const header = rows[h];
  const map = columnMap(header);
  const c = {
    start: pick(map, 'Period Start Date'), end: pick(map, 'Period End Date'), total: pick(map, 'Total Payable'), currency: pick(map, 'Currency'),
    posted: pick(map, 'Transaction Posted Timestamp'), type: pick(map, 'Transaction Type'), desc: pick(map, 'Transaction Description'),
    amount: pick(map, 'Amount'), amountType: pick(map, 'Amount Type'), po: pick(map, 'Purchase Order #'),
  };
  const data = rows.slice(h + 1).filter((r) => !r.every((v) => String(v).trim() === ''));
  const summaries = data.filter((r) => norm(cell(r, c.type)) === 'paymentsummary');
  if (!summaries.length) fail('BAD_FILE', 'This Walmart Recon report has no PaymentSummary row (the row with Total Payable, the amount Walmart paid out), so its lines could not be checked against the payout. Upload the report exactly as Walmart gave it, without removing rows.');
  if (summaries.length > 1) fail('BAD_FILE', `This file holds ${summaries.length} PaymentSummary rows, so it looks like several Walmart Recon reports pasted together, and the rows cannot be matched to their payouts. Upload one report per file, as downloaded.`);
  const sum = summaries[0];
  const currency = (cell(sum, c.currency) || 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) fail('BAD_FILE', `The Walmart PaymentSummary row has currency "${cell(sum, c.currency)}", which is not a 3-letter currency code.`);
  const totalCents = parseMoney(cell(sum, c.total), '.');
  if (totalCents === null || Number.isNaN(totalCents)) fail('BAD_FILE', `The Walmart PaymentSummary row has a Total Payable we cannot read ("${cell(sum, c.total)}").`);
  const start = mdy(cell(sum, c.start)); const end = mdy(cell(sum, c.end));
  const posted = mdy(cell(sum, c.posted));
  const date = posted || end;
  // Review finding 1: the fallback to the period end is never silent.
  if (!posted && end) warnings.push(`WARNING: the Walmart PaymentSummary row's Transaction Posted Timestamp ("${cell(sum, c.posted).slice(0, 40)}") could not be read as MM/DD/YYYY, so the payout is dated on the Period End Date, ${end}. The deposit usually reaches your bank later than that (in the one real report we have seen, three weeks later), so check the date against your bank feed and change it if needed.`);
  if (!date) fail('BAD_FILE', 'The Walmart PaymentSummary row has no readable Transaction Posted Timestamp or Period End Date (MM/DD/YYYY), so the payout could not be dated.');
  const id = `${start || '?'} to ${end || '?'}`;
  // Review finding 4: a posted date before the period ends, or more than 60
  // days after it, is unusual for a payout of that period.
  if (posted && end) {
    const days = (Date.parse(posted) - Date.parse(end)) / 86400000;
    if (days < 0 || days > 60) warnings.push(`The Walmart payout is dated ${posted}, which is ${days < 0 ? 'before the end of' : 'more than 60 days after'} its period (${start || '?'} to ${end}). Check that this is the right report and that the date matches the deposit in your bank feed.`);
  }

  const lines = new Map();
  const unknown = new Map();
  let rowCents = 0; let read = 1; let skipped = 0; const badRows = [];
  for (const row of data) {
    if (row === sum) continue;
    read++;
    const raw = cell(row, c.amount);
    const cents = parseMoney(raw, '.');
    if (cents === null || Number.isNaN(cents)) { skipped++; badRows.push(`${cell(row, c.type)} ${cell(row, c.amountType)}${cell(row, c.po) ? `, purchase order ${cell(row, c.po)}` : ''} ("${raw}")`); continue; }
    rowCents += cents;
    if (!cents) continue;
    const type = cell(row, c.type); const at = cell(row, c.amountType); const desc = cell(row, c.desc);
    let m = classify(type, at, desc);
    if (!m) {
      // Grouped by Transaction Type and Amount Type (review finding 2), so
      // many distinct descriptions cannot make an entry too long to import;
      // the descriptions are listed in the warning.
      // ...and by sign (round 2 finding 6), so money in never nets against money out.
      const label = `Other Walmart amounts: ${[type, at].filter(Boolean).join(' / ') || '(blank)'} (${cents > 0 ? 'money in' : 'money out'})`;
      const u = unknown.get(label) || { count: 0, cents: 0, descs: new Map() };
      u.count++; u.cents += cents; unknown.set(label, u);
      const dk = desc || '(no description)';
      u.descs.set(dk, (u.descs.get(dk) || 0) + cents);
      m = { kind: 'other', line: label };
    }
    const key = `${m.kind}|${m.account || ''}|${m.line}`;
    if (!lines.has(key)) lines.set(key, { ...m, cents: 0, count: 0 });
    const l = lines.get(key);
    l.cents += cents; l.count++;
  }

  const taxNet = [...lines.values()].filter((l) => l.kind === 'tax').reduce((a, l) => a + l.cents, 0);
  const txns = [];
  const base = { date, currency, payoutId: id, payoutDate: date };
  const sumRaw = { [MARKER]: id, ...rawObject(header, sum) };
  let n = 0;
  for (const l of lines.values()) {
    if (!l.cents) continue;
    n++;
    const t = { ...base, id: `${id}:${n}`, description: `Walmart payout ${id}: ${l.line}`, amountCents: l.cents, raw: { [MARKER]: id, line: l.line, rows: String(l.count) } };
    if (l.kind === 'sale') { t.type = l.cents >= 0 ? 'payment' : 'refund'; if (l.cents < 0) t.refundSide = 'sale'; }
    else if (l.kind === 'refund') { t.type = 'refund'; t.refundSide = 'sale'; }
    else if (l.kind === 'tax') { t.type = 'other'; t.taxCents = l.cents; }
    else if (l.kind === 'fee') t.type = 'fee';
    else t.type = 'other';
    const txn = makeTxn(t);
    txn.journalLine = l.line;
    if (l.account) txn.journalAccount = l.account;
    if (l.kind === 'tax' && taxNet) txn.journalAccount = 'taxesPayable';
    txns.push(txn);
  }
  const diff = rowCents - totalCents;
  if (totalCents || diff) txns.push(makeTxn({ ...base, id: `${id}:payout`, description: totalCents < 0 ? `Walmart payout ${id}: charged to you` : `Walmart payout ${id}: deposit (Total Payable)`, amountCents: -totalCents, type: 'payout', raw: sumRaw }));

  if (diff) warnings.push(`WARNING: the Walmart Recon report for ${id} does not add up. Its rows total ${formatCents(rowCents)} ${currency}, but Total Payable (the payout) is ${formatCents(totalCents)} (difference ${formatCents(diff)}). Rows may be missing from this file, or the report may hold amounts outside the payout. The payout is booked as ${formatCents(totalCents)} and the difference goes to the clearing account. Compare with the payment in Seller Center before importing.`);
  const badWord = badRows.length === 1 ? '1 Walmart row has' : `${badRows.length} Walmart rows have`;
  if (badRows.length) warnings.push(`WARNING: ${badWord} an amount we cannot read and were left out: ${badRows.slice(0, 5).join('; ')}. The total check above shows the effect.`);
  if (unknown.size) {
    const describe = (u) => {
      const ds = [...u.descs.entries()].slice(0, 5).map(([d, ct]) => `"${d.slice(0, 80)}" ${formatCents(ct)}`).join(', ');
      const more = u.descs.size > 5 ? ` and ${u.descs.size - 5} more descriptions` : '';
      return `${ds}${more}`;
    };
    const list = [...unknown.entries()].map(([k, u]) => `${k.replace(/^Other Walmart amounts: /, '')} (${u.count === 1 ? '1 row' : `${u.count} rows`}, ${formatCents(u.cents)}: ${describe(u)})`).join('; ');
    warnings.push(`Some Walmart amounts are of a kind this converter does not recognise yet: ${list}. They are kept on lines per type, amount type and direction (money in and money out separately), and booked to "Uncategorized Income" (money in) or "Uncategorized Expense" (money out) in a journal entry. Check them in Seller Center and recategorize them in your books.`);
  }
  if (taxNet) warnings.push(`In this Walmart report, ${formatCents(taxNet)} of sales tax charged to buyers was not kept back by Walmart, so it reached you and you may owe it. In a journal entry it is booked to "Sales Tax / VAT Payable" (a liability, not income) unless you set your own sales tax account.`);
  if (totalCents < 0) warnings.push(`The Walmart payout for ${id} is negative (${formatCents(totalCents)}): Walmart took money from you instead of paying out. It is booked as money out of your bank account.`);

  const meta = finishMeta(txns, read, skipped, {
    timeZone: 'not applicable; every line is dated on the payout (Transaction Posted Timestamp of the PaymentSummary row)',
    periodStart: start, periodEnd: end, depositDate: date, depositTotal: totalCents / 100, rowsTotal: rowCents / 100, reconciled: diff === 0,
  });
  return { transactions: txns, warnings, meta };
}
