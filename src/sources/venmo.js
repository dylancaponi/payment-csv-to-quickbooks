// Venmo account statement CSV (venmo.com > Statements > Download CSV).
// Personal layout: 2 preamble lines, header with an empty first column,
// a beginning-balance row, data rows, then an ending-balance footer whose
// Disclaimer cell is a multi-line quoted paragraph. Business layout:
// header on line 1 with Transaction ID, Date, Time (UTC), Amount (net).
import { fail } from '../errors.js';
import { parseMoney } from '../money.js';
import { parseDate } from '../dates.js';
import { utcDateReader, resolveDateOrder } from '../locale.js';
import { columnMap, pick, cell, cleanText, rawObject, makeTxn, finishMeta, sortByDate, norm, fundingKind, pendingNote, unclearFundingNote } from '../util.js';

function headerIndex(rows) {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const set = new Set(rows[i].map(norm));
    if ((set.has('id') || set.has('transaction id')) && set.has('amount (total)')) return i;
  }
  return -1;
}

export function detect(rows) {
  const h = headerIndex(rows);
  if (h < 0) return { score: 0 };
  const set = new Set(rows[h].map(norm));
  let score = 0.85;
  if (set.has('funding source') && set.has('destination')) score = 0.97;
  if (rows[0] && /^Account Statement - \(@/.test(rows[0][0] || '')) score = 0.99;
  return { score, reason: 'Found Venmo statement columns (ID, Amount (total), Funding Source).' };
}

const TYPE_MAP = {
  'payment': 'payment',
  'charge': 'payment',
  'merchant transaction': 'payment',
  'refunded transaction': 'refund',
  'refund': 'refund',
  'standard transfer': 'transfer',
  'instant transfer': 'transfer',
  'credit card payment': 'transfer',
  'add funds': 'transfer',
  'credit card reward': 'other',
};

const OK_STATUS = new Set(['complete', 'completed', 'issued', 'cleared', '']);

function isVenmoBalance(s) {
  return /venmo balance/i.test(s);
}

export function parse(rows, options = {}, warnings = []) {
  const h = headerIndex(rows);
  if (h < 0) {
    fail('WRONG_SOURCE', "This doesn't look like a Venmo statement: we couldn't find the \"ID\" and \"Amount (total)\" columns. On venmo.com open Statements, pick the month, and click Download CSV.");
  }
  const header = rows[h];
  const map = columnMap(header);
  const c = {
    id: pick(map, 'ID', 'Transaction ID'),
    datetime: pick(map, 'Datetime'),
    date: pick(map, 'Date'),
    type: pick(map, 'Type'),
    status: pick(map, 'Status'),
    note: pick(map, 'Note'),
    from: pick(map, 'From'),
    to: pick(map, 'To'),
    total: pick(map, 'Amount (total)'),
    fee: pick(map, 'Amount (fee)'),
    net: pick(map, 'Amount (net)'),
    funding: pick(map, 'Funding Source'),
    dest: pick(map, 'Destination'),
    begin: pick(map, 'Beginning Balance'),
    end: pick(map, 'Ending Balance'),
  };
  const pairExternal = options.externalFunding !== 'ignore';
  const txns = [];
  let read = 0;
  let skipped = 0;
  let opening = null;
  let closing = null;
  let feeRows = 0;
  let paired = 0;
  let cardRows = 0;
  const unclear = new Set();
  const pending = [];
  const meta = {};
  const utcDate = utcDateReader(options, warnings, meta, 'Venmo', c.datetime >= 0 ? rows.slice(h + 1).map((r) => cell(r, c.datetime)).filter((v) => /\d/.test(v)) : []);
  const bizVals = c.datetime < 0 ? rows.slice(h + 1).map((r) => cell(r, c.date)).filter((v) => /^\d{1,2}[\/.-]/.test(v)) : [];
  const bizOrder = bizVals.length ? resolveDateOrder(bizVals, options, warnings, 'this Venmo file', { order: 'mdy', reason: 'Venmo exports and US spreadsheets write month/day/year' }) : 'mdy';
  const c_time = pick(map, 'Time (UTC)');
  // The account holder is the name that appears most often in From/To.
  const nameCounts = new Map();
  for (let r = h + 1; r < rows.length; r++) {
    for (const i of [c.from, c.to]) {
      const v = cleanText(cell(rows[r], i));
      if (v) nameCounts.set(v, (nameCounts.get(v) || 0) + 1);
    }
  }
  let holder = options.accountHolder || '';
  if (!holder) { let best = 1; for (const [k, v] of nameCounts) if (v > best) { best = v; holder = k; } }
  for (let r = h + 1; r < rows.length; r++) {
    const row = rows[r];
    const id = cell(row, c.id).replace(/"/g, '');
    if (!/^\d+$/.test(id)) {
      // Balance rows, footer, crypto summary, blank lines.
      const b = parseMoney(cell(row, c.begin));
      const e = parseMoney(cell(row, c.end));
      if (b !== null && !Number.isNaN(b) && opening === null) opening = b;
      if (e !== null && !Number.isNaN(e)) closing = e;
      continue;
    }
    read++;
    const status = cell(row, c.status).toLowerCase();
    let dtRaw;
    if (c.datetime >= 0) dtRaw = cell(row, c.datetime);
    else {
      // Business layout: Date (MM/DD/YYYY) plus Time (UTC).
      const d = parseDate(cell(row, c.date), bizOrder);
      dtRaw = d ? (cell(row, c_time) ? `${d} ${cell(row, c_time)}` : d) : cell(row, c.date);
    }
    const date = utcDate(dtRaw);
    if (!OK_STATUS.has(status)) {
      skipped++;
      const tt = TYPE_MAP[cell(row, c.type).toLowerCase()];
      const amt = parseMoney(cell(row, c.total));
      if (/pending/.test(status) && tt === 'transfer' && date && amt && !Number.isNaN(amt)) pending.push({ date, amount: amt / 100, description: cell(row, c.type) });
      else warnings.push(`Skipped Venmo transaction ${id} with status "${cell(row, c.status)}".`);
      continue;
    }
    if (!date) { skipped++; warnings.push(`Skipped Venmo transaction ${id}: unreadable date "${dtRaw}".`); continue; }
    const total = parseMoney(cell(row, c.total));
    const net = c.net >= 0 ? parseMoney(cell(row, c.net)) : null;
    let amount = net !== null && !Number.isNaN(net) && net !== 0 ? net : total;
    if (amount === null || Number.isNaN(amount)) { skipped++; warnings.push(`Skipped Venmo transaction ${id}: unreadable amount "${cell(row, c.total)}".`); continue; }
    if (amount === 0) { skipped++; continue; }
    const feeVal = parseMoney(cell(row, c.fee));
    const fee = feeVal && !Number.isNaN(feeVal) ? feeVal : 0; // positive = fee paid; a negative value (fee returned) keeps its sign
    const typeRaw = cell(row, c.type);
    const type = TYPE_MAP[typeRaw.toLowerCase()] || 'other';
    const from = cleanText(cell(row, c.from));
    const to = cleanText(cell(row, c.to));
    const note = cleanText(cell(row, c.note));
    const funding = cell(row, c.funding);
    const dest = cell(row, c.dest);
    let counterparty;
    if (holder && from === holder) counterparty = to;
    else if (holder && to === holder) counterparty = from;
    else counterparty = amount > 0 ? from : to;
    let description;
    if (type === 'transfer') description = [typeRaw, dest || funding].filter(Boolean).join(' to ');
    else description = [counterparty, note].filter(Boolean).join(' - ') || typeRaw;
    const t = {
      date, description, amountCents: amount, currency: 'USD', id, type, counterparty,
      raw: rawObject(header, row),
    };
    if (type === 'transfer') {
      // Credit Card Payment pays the Venmo credit card: money goes to a card.
      const where = typeRaw.toLowerCase() === 'credit card payment' ? 'Venmo Credit Card' : amount < 0 ? dest : funding;
      t.transferAccount = fundingKind(where, unclear);
      if (t.transferAccount === 'card') cardRows++;
    }
    if (fee) {
      feeRows++;
      // Amount (total) is treated as the net effect on the balance; gross adds the fee back.
      t.feeCents = fee;
      t.grossCents = amount + fee;
      t.netCents = amount;
    }
    txns.push(makeTxn(t));
    // Payments funded from (or paid into) an outside bank or card do not move
    // the Venmo balance. Add the offsetting transfer so the account reconciles.
    if (pairExternal && type !== 'transfer') {
      if (amount < 0 && funding && !isVenmoBalance(funding)) {
        paired++;
        const k = fundingKind(funding, unclear); if (k === 'card') cardRows++;
        txns.push(makeTxn({ date, description: `Funded by ${funding}`, amountCents: -amount, currency: 'USD', id: `${id}:funding`, type: 'transfer', transferAccount: k, counterparty: funding, raw: { generatedFrom: id, reason: 'external funding source' } }));
      } else if (amount > 0 && dest && !isVenmoBalance(dest)) {
        paired++;
        const k = fundingKind(dest, unclear); if (k === 'card') cardRows++;
        txns.push(makeTxn({ date, description: `Sent to ${dest}`, amountCents: -amount, currency: 'USD', id: `${id}:destination`, type: 'transfer', transferAccount: k, counterparty: dest, raw: { generatedFrom: id, reason: 'external destination' } }));
      }
    } else if (type === 'transfer' && typeRaw.toLowerCase() === 'credit card payment' && funding && !isVenmoBalance(funding)) {
      if (pairExternal) {
        paired++;
        txns.push(makeTxn({ date, description: `Funded by ${funding}`, amountCents: -amount, currency: 'USD', id: `${id}:funding`, type: 'transfer', transferAccount: fundingKind(funding, unclear), counterparty: funding, raw: { generatedFrom: id, reason: 'external funding source' } }));
      }
    }
  }
  const un = unclearFundingNote(unclear, 'Venmo');
  if (un) warnings.push(un);
  const pn = pendingNote(pending, 'Venmo');
  if (pn) warnings.push(pn);
  if (cardRows) warnings.push(`${cardRows} Venmo row(s) were funded by, or paid to, a card or another source that is not recognisably your bank. They are marked as card funding, so payout journal entries book them to a separate card account instead of your bank.`);
  if (feeRows) warnings.push(`${feeRows} Venmo row(s) carry a fee. We treat "Amount (total)" as the amount that actually hit your balance (after the fee); check one against the Venmo app before importing.`);
  if (paired) warnings.push(`${paired} Venmo payment(s) were paid from or into an outside bank or card, not your Venmo balance. We added a matching transfer line for each so your Venmo account balance stays correct. Set externalFunding to "ignore" to turn this off.`);
  const sorted = sortByDate(txns);
  let sum = 0;
  for (const t of sorted) sum += Math.round(t.amount * 100);
  const extra = {};
  if (opening !== null) extra.openingBalance = opening / 100;
  if (closing !== null) extra.closingBalance = closing / 100;
  if (opening !== null && closing !== null) {
    const diff = opening + sum - closing;
    extra.reconciled = diff === 0;
    if (diff !== 0) warnings.push(`Heads up: beginning balance plus these transactions does not equal Venmo's ending balance (off by ${(diff / 100).toFixed(2)}). Some activity may be missing from this statement.`);
  }
  return { transactions: sorted, warnings, meta: finishMeta(sorted, read, skipped, Object.assign(extra, meta, pending.length ? { pendingTransfers: pending } : {})) };
}
