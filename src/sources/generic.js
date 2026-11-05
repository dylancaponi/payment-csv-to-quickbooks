// Generic bank CSV with column auto-mapping. Finds a header row (skipping
// preamble lines such as account numbers), then maps date, description and
// either a signed amount column or separate debit/credit columns.
// options.mapping = { date, description, amount, debit, credit, id } (header
// names or zero-based indexes) overrides the auto-mapping.
// options.invertSign = true flips signs (for card exports that show
// purchases as positive numbers).
import { fail } from '../errors.js';
import { parseMoney } from '../money.js';
import { parseDate } from '../dates.js';
import { resolveDecimal, resolveDateOrder } from '../locale.js';
import { columnMap, cell, cleanText, rawObject, makeTxn, finishMeta, sortByDate, norm } from '../util.js';

const DATE_NAMES = ['date', 'transaction date', 'trans date', 'trans. date', 'posted date', 'posting date', 'post date', 'value date', 'booking date', 'effective date', 'datum', 'fecha', 'date posted', 'settlement date', 'created', 'completed date', 'buchungstag', 'buchungsdatum', 'transactiedatum', 'boekdatum', 'date opération', 'date operation', 'data', 'fecha operación'];
const DESC_NAMES = ['description', 'transaction description', 'details', 'narrative', 'memo', 'payee', 'name', 'merchant', 'merchant name', 'transaction details', 'particulars', 'reference', 'description 1', 'remarks', 'counterparty', 'beneficiary', 'item', 'omschrijving', 'naam / omschrijving', 'mededelingen', 'verwendungszweck', 'buchungstext', 'beschreibung', 'libellé', 'libelle', 'concepto', 'descrizione'];
const AMOUNT_NAMES = ['amount', 'transaction amount', 'amount (usd)', 'amount usd', 'net amount', 'value', 'betrag', 'importe', 'montant', 'amount ($)', 'total', 'bedrag', 'bedrag (eur)', 'betrag (eur)', 'umsatz', 'importo', 'net', 'gross'];
const DEBIT_NAMES = ['debit', 'debits', 'debit amount', 'withdrawal', 'withdrawals', 'withdrawal amount', 'money out', 'paid out', 'out', 'charges', 'debit (usd)', 'amount debit', 'outflow', 'spent'];
const CREDIT_NAMES = ['credit', 'credits', 'credit amount', 'deposit', 'deposits', 'deposit amount', 'money in', 'paid in', 'in', 'payments', 'credit (usd)', 'amount credit', 'inflow', 'received'];
const ID_NAMES = ['transaction id', 'reference number', 'ref', 'reference no', 'id', 'check number', 'cheque number', 'check or slip #', 'fitid'];
const DRCR_NAMES = ['type', 'transaction type', 'cr/dr', 'dr/cr', 'debit/credit', 'credit/debit indicator', 'details'];

function findCol(map, names, exclude = new Set()) {
  for (const n of names) { const i = map.get(n); if (i !== undefined && !exclude.has(i)) return i; }
  // Prefix fuzzy: "Amount (CAD)", "Posting Date 2"
  for (const [k, i] of map) if (!exclude.has(i) && names.some((n) => k.startsWith(n + ' ') || k.startsWith(n + '('))) return i;
  return -1;
}

function resolve(map, header, v) {
  if (v === undefined || v === null || v === '') return -1;
  if (typeof v === 'number') return v < header.length ? v : -1;
  const i = map.get(norm(v));
  return i === undefined ? -1 : i;
}

export function mapColumns(rows, mapping) {
  const lim = Math.min(rows.length, 40);
  for (let h = 0; h < lim; h++) {
    const header = rows[h];
    const map = columnMap(header);
    let m;
    if (mapping) {
      m = { date: resolve(map, header, mapping.date), description: resolve(map, header, mapping.description), amount: resolve(map, header, mapping.amount), debit: resolve(map, header, mapping.debit), credit: resolve(map, header, mapping.credit), id: resolve(map, header, mapping.id), drcr: resolve(map, header, mapping.drcr) };
      if (m.date < 0 || (m.amount < 0 && m.debit < 0 && m.credit < 0)) continue;
    } else {
      const used = new Set();
      const date = findCol(map, DATE_NAMES); if (date < 0) continue; used.add(date);
      const amount = findCol(map, AMOUNT_NAMES, used);
      if (amount >= 0) used.add(amount);
      const debit = amount < 0 ? findCol(map, DEBIT_NAMES, used) : -1; if (debit >= 0) used.add(debit);
      const credit = amount < 0 ? findCol(map, CREDIT_NAMES, used) : -1; if (credit >= 0) used.add(credit);
      if (amount < 0 && debit < 0 && credit < 0) continue;
      const description = findCol(map, DESC_NAMES, used); if (description >= 0) used.add(description);
      const id = findCol(map, ID_NAMES, used);
      const drcr = amount >= 0 ? findCol(map, DRCR_NAMES, used) : -1;
      m = { date, description, amount, debit, credit, id, drcr };
      // Fee and Net columns next to Amount: Net is what hit the account.
      const net = map.get('net');
      if (amount >= 0 && net !== undefined && net !== amount && map.has('fee')) {
        return { h, header, m: { ...m, amount: net }, usedNet: { amount } };
      }
    }
    return { h, header, m };
  }
  return null;
}

export function detect(rows) {
  const r = mapColumns(rows);
  if (!r) return { score: 0 };
  // Confirm at least one data row parses.
  const sample = rows.slice(r.h + 1, r.h + 6).filter((row) => parseDate(cell(row, r.m.date)));
  if (!sample.length) return { score: 0.1 };
  const cols = [r.header[r.m.date], r.m.description >= 0 ? r.header[r.m.description] : null, r.m.amount >= 0 ? r.header[r.m.amount] : `${r.header[r.m.debit] || ''}/${r.header[r.m.credit] || ''}`].filter(Boolean);
  return { score: 0.4, reason: `Generic bank CSV: mapped columns ${cols.map((x) => `"${String(x).trim()}"`).join(', ')}.` };
}

export function parse(rows, options = {}, warnings = []) {
  const r = mapColumns(rows, options.mapping);
  if (!r) fail('NO_COLUMNS', "We couldn't find a date column and an amount column (or debit and credit columns) in this file. Check that the file has a header row, or tell us which columns hold the date, description and amount.");
  const { h, header, m } = r;
  const data = rows.slice(h + 1).filter((row) => !row.every((v) => v.trim() === ''));
  const amountCols = [m.amount, m.debit, m.credit].filter((i) => i >= 0);
  const decimal = resolveDecimal(data.flatMap((row) => amountCols.map((i) => cell(row, i))), options, warnings, 'this file');
  const sn = { order: resolveDateOrder(data.map((row) => cell(row, m.date)), options, warnings, 'this file') };
  if (r.usedNet) warnings.push(`This file has "${String(header[r.usedNet.amount]).trim()}", "Fee" and "Net" columns; we used Net (what actually reached the account) as the amount.`);
  const flip = options.invertSign ? -1 : 1;
  const currency = (options.currency || 'USD').toUpperCase();
  const txns = [];
  let read = 0;
  let skipped = 0;
  let trailing = 0;
  for (const row of data) {
    const dateRaw = cell(row, m.date);
    const date = parseDate(dateRaw, sn.order);
    if (!date) {
      // A value shaped like a date that is not a real date under the settled
      // order is an error, never a silently dropped row.
      if (/^\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}\b|^\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}\b/.test(dateRaw)) {
        fail('UNREADABLE_DATE', `Line ${rows.indexOf(row) + 1} has the date "${dateRaw}", which is not a real date when read as ${sn.order === 'mdy' ? 'month/day/year' : 'day/month/year'}. Fix that line, or check the date order, and upload again.`, { line: rows.indexOf(row) + 1, value: dateRaw, dateOrder: sn.order });
      }
      // Footer lines (totals, closing balance, disclaimers) have no date.
      trailing++;
      continue;
    }
    read++;
    let amount = null;
    if (m.amount >= 0) {
      amount = parseMoney(cell(row, m.amount), decimal);
      if (m.drcr >= 0 && amount !== null && !Number.isNaN(amount)) {
        const ind = cell(row, m.drcr).toLowerCase();
        if (/^(dr|debit|d|withdrawal)$/.test(ind)) amount = -Math.abs(amount);
        else if (/^(cr|credit|c|deposit)$/.test(ind)) amount = Math.abs(amount);
      }
    } else {
      const d = m.debit >= 0 ? parseMoney(cell(row, m.debit), decimal) : null;
      const cr = m.credit >= 0 ? parseMoney(cell(row, m.credit), decimal) : null;
      if ((d !== null && Number.isNaN(d)) || (cr !== null && Number.isNaN(cr))) amount = NaN;
      else if (d === null && cr === null) amount = null;
      else amount = (cr ? Math.abs(cr) : 0) - (d ? Math.abs(d) : 0);
    }
    if (amount === null) { skipped++; warnings.push(`Skipped a row dated ${dateRaw} with no amount.`); continue; }
    if (Number.isNaN(amount)) { skipped++; warnings.push(`Skipped a row dated ${dateRaw}: we could not read the amount.`); continue; }
    if (amount === 0) { skipped++; continue; }
    const description = m.description >= 0 ? cleanText(cell(row, m.description)) : '';
    txns.push(makeTxn({
      date, description: description || 'Bank transaction', amountCents: amount * flip, currency,
      id: m.id >= 0 ? cell(row, m.id) || undefined : undefined, type: 'other', raw: rawObject(header, row),
    }));
  }
  if (!txns.length && read === 0) fail('NO_ROWS', 'We found the column headers but no rows with a readable date under them. Check that the file is not empty and that the dates are real dates.');
  if (trailing > 0 && trailing <= 5) warnings.push(`Ignored ${trailing} line(s) without a date (usually totals or balance lines at the end).`);
  else if (trailing > 5) warnings.push(`Ignored ${trailing} lines without a readable date. If that is more than the footer, the date column may be wrong.`);
  const positive = txns.filter((t) => t.amount > 0).length;
  if (!options.invertSign && txns.length >= 5 && positive / txns.length >= 0.9) {
    warnings.push(`${positive} of ${txns.length} amounts are positive (money in). If this is a credit card export that lists purchases as positive numbers, turn on "invert sign" so purchases become money out.`);
  }
  const desc = txns.length > 1 && txns[0].date > txns[txns.length - 1].date;
  const sorted = sortByDate(desc ? txns.reverse() : txns);
  const mappingUsed = {};
  for (const k of Object.keys(m)) if (m[k] >= 0) mappingUsed[k] = String(header[m[k]]).trim();
  return { transactions: sorted, warnings, meta: finishMeta(sorted, read, skipped, { mapping: mappingUsed, dateOrder: sn.order, timeZone: 'as exported' }) };
}
