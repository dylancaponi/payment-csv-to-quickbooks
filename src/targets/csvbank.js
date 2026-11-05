// Bank-statement CSV writers:
//  qbo-csv-3: QuickBooks Online, Date,Description,Amount
//  qbo-csv-4: QuickBooks Online, Date,Description,Credit,Debit
//  xero-csv:  Xero statement template, *Date,*Amount,Payee,Description,Reference,Check Number
import { fail } from '../errors.js';
import { formatCents } from '../money.js';
import { formatDate, DATE_FORMATS } from '../dates.js';
import { writeCSV } from '../csv.js';
import { noteSplit, validateTxns, selectCurrency, toLines, asciiText, unicodeText, truncate, dateRange, slug, checkAmountDigits, csvSafe } from './common.js';
import { splitLines, QBO_ONLINE_MAX_ROWS, QBO_ONLINE_MAX_BYTES } from './ofx.js';

function dateFmt(options, def) {
  const f = options.dateFormat || def;
  if (typeof f !== 'string') fail('BAD_OPTION', `Unsupported date format. Use one of: ${DATE_FORMATS.join(', ')}.`);
  if (!DATE_FORMATS.includes(f)) fail('BAD_OPTION', `Unsupported date format "${f}". Use one of: ${DATE_FORMATS.join(', ')}.`);
  return f;
}

// QuickBooks: "Remove numbers from cells in the Description column" and
// special characters can block the import.
function qboDescription(s) {
  let d = asciiText(s).replace(/[^A-Za-z0-9 .,:;'"()\/&@#%+\-_*!?]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!d) d = 'Transaction';
  if (/^[\d\s.,\-+#]+$/.test(d)) d = `Ref ${d}`;
  return truncate(d, 1000);
}

function qboDescriptionFor(l) {
  const parts = [];
  if (l.name && l.memo && !l.memo.includes(l.name)) parts.push(l.name, l.memo);
  else parts.push(l.memo || l.name);
  return csvSafe(qboDescription(parts.filter(Boolean).join(' - ')));
}

export function writeQboCsv(targetId, transactions, options = {}) {
  const warnings = [];
  transactions = validateTxns(transactions);
  const { kept } = selectCurrency(transactions, options, warnings);
  let lines = toLines(kept, options);
  noteSplit(options, warnings);
  checkAmountDigits(lines);
  const zero = lines.filter((l) => l.cents === 0).length;
  if (zero) { lines = lines.filter((l) => l.cents !== 0); warnings.push(`Left out ${zero} zero-amount line(s); QuickBooks asks for zero cells to be blank.`); }
  if (!lines.length) fail('NO_TRANSACTIONS', 'There are no non-zero transactions to write.');
  const fmt = dateFmt(options, 'MM/DD/YYYY');
  const four = targetId === 'qbo-csv-4';
  const head = four ? ['Date', 'Description', 'Credit', 'Debit'] : ['Date', 'Description', 'Amount'];
  const rowFor = (l) => {
    const d = formatDate(l.date, fmt);
    const desc = qboDescriptionFor(l);
    if (!four) return [d, desc, formatCents(l.cents)];
    return l.cents > 0 ? [d, desc, formatCents(l.cents), ''] : [d, desc, '', formatCents(-l.cents)];
  };
  const render = (chunk) => writeCSV([head, ...chunk.map(rowFor)]);
  const content = render(lines);
  if (four && !lines.some((l) => l.cents > 0)) warnings.push('This file has only money-out rows. QuickBooks can reject a 4-column file with an empty Credit column; use the 3-column layout if the import fails.');
  const { from, to } = dateRange(lines);
  const base = `${slug(options.filenameBase || options.sourceId || 'transactions')}-${from}-to-${to}-quickbooks-${four ? '4col' : '3col'}`;
  const result = { filename: `${base}.csv`, mime: 'text/csv', content, warnings };
  warnings.push(`Dates are written as ${fmt}. When QuickBooks asks for the date format during the upload, pick the same one.`);
  const bytes = new TextEncoder().encode(content).length;
  if (lines.length > QBO_ONLINE_MAX_ROWS || bytes > QBO_ONLINE_MAX_BYTES) {
    const parts = splitLines(lines, render, QBO_ONLINE_MAX_ROWS, QBO_ONLINE_MAX_BYTES);
    result.parts = parts.map((c, i) => ({ filename: `${base}-part${i + 1}of${parts.length}.csv`, content: c }));
    warnings.push(`QuickBooks Online accepts at most ${QBO_ONLINE_MAX_ROWS} rows and 350 KB per upload, so this file is also provided as ${parts.length} smaller files. Upload them one at a time.`);
  }
  return result;
}

export function writeXeroCsv(transactions, options = {}) {
  const warnings = [];
  transactions = validateTxns(transactions);
  const { kept } = selectCurrency(transactions, options, warnings);
  let lines = toLines(kept, options);
  noteSplit(options, warnings);
  const zero = lines.filter((l) => l.cents === 0).length;
  if (zero) { lines = lines.filter((l) => l.cents !== 0); warnings.push(`Left out ${zero} zero-amount line(s).`); }
  if (!lines.length) fail('NO_TRANSACTIONS', 'There are no non-zero transactions to write.');
  if (lines.length > 100000) fail('TOO_MANY_ROWS', `Xero cannot import more than 100,000 rows in one file; this one has ${lines.length}. Export a shorter date range.`);
  if (options.region !== undefined && typeof options.region !== 'string') fail('BAD_OPTION', 'The region option must be a country code such as "US" or "GB".');
  checkAmountDigits(lines);
  const us = (options.region || 'US').toUpperCase() === 'US';
  const fmt = dateFmt(options, us ? 'MM/DD/YYYY' : 'DD/MM/YYYY');
  const head = ['*Date', '*Amount', 'Payee', 'Description', 'Reference', us ? 'Check Number' : 'Cheque Number'];
  const rows = lines.map((l) => {
    const payee = truncate(unicodeText(l.txn.counterparty || (l.kind === 'fee' ? 'Fee' : '')), 255);
    const description = truncate(unicodeText(l.memo || l.name || 'Transaction'), 255);
    const ref = truncate(unicodeText(l.txn.id ? l.txn.id + (l.kind === 'fee' ? ' fee' : '') : ''), 255);
    return [formatDate(l.date, fmt), formatCents(l.cents), csvSafe(l.kind === 'fee' ? 'Fee' : payee), csvSafe(description), csvSafe(ref), ''];
  });
  const content = writeCSV([head, ...rows]);
  const { from, to } = dateRange(lines);
  warnings.push(`Dates are written as ${fmt}. If Xero asks you to confirm the date format, choose ${fmt}.`);
  return {
    filename: `${slug(options.filenameBase || options.sourceId || 'transactions')}-${from}-to-${to}-xero.csv`,
    mime: 'text/csv', content, warnings,
  };
}
