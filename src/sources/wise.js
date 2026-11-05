// Wise balance statement CSV (Wise > a currency balance > Statements and
// reports > CSV). One file per currency balance, newest first. Header names
// with spaces are quoted. Three layouts are known (FORMATS.md, Wise):
//   A: "TransferWise ID",Date,Amount,Currency,Description,"Payment Reference",
//      "Running Balance","Exchange From","Exchange To","Exchange Rate",
//      "Payer Name","Payee Name","Payee Account Number",Merchant,
//      "Card Last Four Digits","Card Holder Full Name",Attachment,Note,
//      "Total fees"
//   B: A + "Exchange To Amount"
//   C: B + "Date Time" after Date + "Transaction Type",
//      "Transaction Details Type" at the end
// Date DD-MM-YYYY. Amount is signed and is what moved the balance. A fee can
// be its own row ("... Charges for: TRANSFER-...") while the main row's
// "Total fees" shows the same fee, so Total fees is never subtracted again:
// Amount is used as written and Running Balance checks the result.
import { fail } from '../errors.js';
import { parseMoney, formatCents } from '../money.js';
import { parseDate } from '../dates.js';
import { resolveDateOrder } from '../locale.js';
import { columnMap, pick, cell, cleanText, rawObject, makeTxn, finishMeta, sortByDate, findHeaderRow } from '../util.js';

const ID_COL = ['TransferWise ID', 'Wise ID'];

function headerIndex(rows) {
  for (const id of ID_COL) {
    const h = findHeaderRow(rows, [id, 'Date', 'Amount', 'Currency', 'Description', 'Running Balance'], 5);
    if (h >= 0) return h;
  }
  return -1;
}

export function detect(rows) {
  const h = headerIndex(rows);
  if (h < 0) return { score: 0 };
  return { score: 0.97, reason: 'Found Wise statement columns (TransferWise ID, Running Balance, Exchange From, Exchange To).' };
}

const num = (v) => {
  const m = parseMoney(v, '.');
  return m === null || Number.isNaN(m) ? null : m;
};

function mapType(id, description, amount) {
  if (/charges? for:/i.test(description) || /^fee-/i.test(id)) return 'fee';
  if (/^BALANCE-/i.test(id) || /^converted /i.test(description)) return 'other'; // currency conversion between your own balances
  if (/^CARD-/i.test(id)) return amount < 0 ? 'payment' : 'refund';
  return amount === 0 ? 'other' : 'payment';
}

export function parse(rows, options = {}, warnings = []) {
  const h = headerIndex(rows);
  if (h < 0) fail('WRONG_SOURCE', "This doesn't look like a Wise statement: we couldn't find the \"TransferWise ID\" and \"Running Balance\" columns. In Wise open the currency balance, choose Statements, and download the statement as CSV.");
  const header = rows[h];
  const map = columnMap(header);
  const c = {
    id: pick(map, ...ID_COL), date: pick(map, 'Date'), amount: pick(map, 'Amount'), currency: pick(map, 'Currency'),
    description: pick(map, 'Description'), reference: pick(map, 'Payment Reference'), balance: pick(map, 'Running Balance'),
    payer: pick(map, 'Payer Name'), payee: pick(map, 'Payee Name'), merchant: pick(map, 'Merchant'), note: pick(map, 'Note'),
  };
  const data = rows.slice(h + 1).filter((r) => !r.every((v) => v.trim() === ''));
  // Wise writes DD-MM-YYYY (dashes) or YYYY-MM-DD; both are read as such.
  // Slash dates only appear in files re-saved in a spreadsheet, whose order
  // depends on the spreadsheet, so those are checked.
  const native = (v) => /^\d{1,2}-\d{1,2}-\d{4}$/.test(v.trim()) || /^\d{4}-\d{2}-\d{2}/.test(v.trim());
  const reSaved = data.map((r) => cell(r, c.date)).filter((v) => v && !native(v));
  const dOrder = reSaved.length ? resolveDateOrder(reSaved, options, warnings, 'this Wise file', { order: 'dmy', reason: 'Wise writes day/month/year' }) : 'dmy';
  // A blank Currency cell takes the file's own currency (each Wise statement
  // is one balance); only with no currency anywhere is a default used, and
  // either way a warning says so.
  const curCounts = new Map();
  for (const r of data) { const k = cell(r, c.currency).toUpperCase(); if (/^[A-Z]{3}$/.test(k)) curCounts.set(k, (curCounts.get(k) || 0) + 1); }
  const fileCur = [...curCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  let blankCur = 0;
  const txns = [];
  let read = 0, skipped = 0, zero = 0;
  for (const row of data) {
    read++;
    const dateRaw = cell(row, c.date);
    // Wise writes DD-MM-YYYY; a re-saved file may show YYYY-MM-DD, which parses the same way.
    const date = parseDate(dateRaw, native(dateRaw) ? 'dmy' : dOrder);
    if (!date) { skipped++; warnings.push(`Skipped a Wise row with an unreadable date "${dateRaw}".`); continue; }
    const amount = num(cell(row, c.amount));
    if (amount === null) { skipped++; warnings.push(`Skipped a Wise row dated ${dateRaw}: unreadable amount "${cell(row, c.amount)}".`); continue; }
    if (amount === 0) { skipped++; zero++; continue; }
    const id = cell(row, c.id);
    const desc = cleanText(cell(row, c.description));
    const who = cleanText(cell(row, c.merchant)) || cleanText(amount < 0 ? cell(row, c.payee) : cell(row, c.payer));
    const ref = cleanText(cell(row, c.reference));
    const description = [desc || who || 'Wise transaction', ref && !desc.includes(ref) ? ref : ''].filter(Boolean).join(' - ');
    const type = mapType(id, desc, amount);
    const t = {
      date, description, amountCents: amount, currency: (cell(row, c.currency) || ((blankCur++, fileCur || options.currency || 'USD'))).toUpperCase(),
      id: id || undefined, type, counterparty: who || undefined, raw: rawObject(header, row),
    };
    if (type === 'refund') t.refundSide = 'purchase';
    t._balance = num(cell(row, c.balance));
    txns.push(t);
  }
  if (zero) warnings.push(`Left out ${zero} Wise row(s) with a zero amount.`);
  if (blankCur) warnings.push(`${blankCur} Wise row(s) have no currency; they are treated as ${(fileCur || options.currency || 'USD').toUpperCase()}${fileCur ? ', the currency of the rest of this statement' : ', because the file names no currency at all'}. Check them in the preview.`);
  if (curCounts.size > 1) warnings.push(`This Wise file mixes currencies (${[...curCounts.keys()].sort().join(', ')}). Each Wise statement normally covers one currency balance; each converted file keeps one currency and leaves the others out.`);
  // File is newest first. Check the running balance from oldest to newest.
  const chrono = txns.reverse();
  let breaks = 0;
  for (let i = 1; i < chrono.length; i++) {
    const prev = chrono[i - 1], cur = chrono[i];
    if (prev._balance === null || cur._balance === null || prev.currency !== cur.currency) continue;
    if (prev._balance + cur.amountCents !== cur._balance) breaks++;
  }
  const meta = {};
  if (chrono.length && chrono[0]._balance !== null && chrono[chrono.length - 1]._balance !== null && new Set(chrono.map((t) => t.currency)).size === 1) {
    meta.openingBalance = (chrono[0]._balance - chrono[0].amountCents) / 100;
    meta.closingBalance = chrono[chrono.length - 1]._balance / 100;
    meta.reconciled = breaks === 0;
  }
  if (breaks) warnings.push(`The Running Balance column does not follow from the amounts in ${breaks} place(s). Rows may be missing from this export, or several rows share a time and are listed in a different order. Check the totals against Wise.`);
  const out = chrono.map(({ _balance, ...t }) => makeTxn(t));
  const sorted = sortByDate(out);
  return { transactions: sorted, warnings, meta: finishMeta(sorted, read, skipped, { timeZone: 'as exported', ...meta }) };
}
