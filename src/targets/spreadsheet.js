// Plain spreadsheet CSV (for Excel, Google Sheets, LibreOffice): one row per
// transaction, in the order of the source file, with every detail we have.
//   Date, Value date, Amount, Currency, Debit/Credit, Counterparty,
//   Counterparty account, Description, Reference, Balance
// style "comma" (default): comma separated, decimal point.
// style "semicolon": semicolon separated, decimal comma (what Excel expects
//   in Germany, the Netherlands, France and most of Europe).
// The file starts with a UTF-8 byte order mark so Excel shows accented
// names correctly. Text cells get the same formula guard as the other CSV
// targets. Balance is filled only when every row carries a running balance
// that follows from the amounts in this order; otherwise it is left blank.
import { fail } from '../errors.js';
import { formatCents, toCents } from '../money.js';
import { formatDate, DATE_FORMATS } from '../dates.js';
import { writeCSV } from '../csv.js';
import { validateTxns, selectCurrency, unicodeText, truncate, slug, csvSafe } from './common.js';

export function writeSpreadsheetCsv(transactions, options = {}) {
  const warnings = [];
  transactions = validateTxns(transactions);
  const { kept, currency } = selectCurrency(transactions, options, warnings);
  const style = options.style === undefined ? 'comma' : options.style;
  if (style !== 'comma' && style !== 'semicolon') fail('BAD_OPTION', 'The style option must be "comma" (1234.56 with commas between columns) or "semicolon" (1234,56 with semicolons between columns).');
  const fmt = options.dateFormat || 'YYYY-MM-DD';
  if (typeof fmt !== 'string' || !DATE_FORMATS.includes(fmt)) fail('BAD_OPTION', `Unsupported date format. Use one of: ${DATE_FORMATS.join(', ')}.`);
  const num = (c) => (style === 'semicolon' ? formatCents(c).replace('.', ',') : formatCents(c));
  const text = (s, n = 1000) => csvSafe(truncate(unicodeText(s), n));
  // Running balance: only when present on every row and consistent.
  let balances = kept.every((t) => typeof t.balance === 'number' && Number.isFinite(t.balance)) ? kept.map((t) => toCents(t.balance)) : null;
  if (balances) {
    for (let i = 1; i < kept.length; i++) {
      if (balances[i - 1] + toCents(kept[i].amount) !== balances[i]) { balances = null; break; }
    }
    if (!balances) warnings.push('The Balance column is left blank: the running balances in this file do not follow from the amounts in this order.');
  }
  const head = ['Date', 'Value date', 'Amount', 'Currency', 'Debit/Credit', 'Counterparty', 'Counterparty account', 'Description', 'Reference', 'Balance'];
  const rows = kept.map((t, i) => {
    const cents = toCents(t.amount);
    const vd = typeof t.valueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.valueDate) ? formatDate(t.valueDate, fmt) : '';
    return [
      formatDate(t.date, fmt), vd, num(cents), currency, cents < 0 ? 'Debit' : 'Credit',
      text(t.counterparty, 255), text(typeof t.counterpartyAccount === 'string' ? t.counterpartyAccount : '', 64),
      text(t.description), text(typeof t.reference === 'string' ? t.reference : t.id || '', 255),
      balances ? num(balances[i]) : '',
    ];
  });
  const content = '﻿' + writeCSV([head, ...rows], { delimiter: style === 'semicolon' ? ';' : ',' });
  let from = kept[0].date, to = kept[0].date;
  for (const t of kept) { if (t.date < from) from = t.date; if (t.date > to) to = t.date; }
  return {
    filename: `${slug(options.filenameBase || options.sourceId || 'transactions')}-${from}-to-${to}-spreadsheet.csv`,
    mime: 'text/csv', content, warnings,
  };
}
