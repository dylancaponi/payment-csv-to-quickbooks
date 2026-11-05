// Cash App CSV (cash.app/account > Activity/Statements > Export CSV).
// Two known column orders (Transaction ID first until about 2024-08, Date
// first after). No preamble, no footer, rows newest first.
import { fail } from '../errors.js';
import { parseMoney } from '../money.js';
import { parseDate } from '../dates.js';
import { resolveDateOrder } from '../locale.js';
import { columnMap, pick, cell, cleanText, rawObject, makeTxn, finishMeta, sortByDate, findHeaderRow, fundingKind, pendingNote, unclearFundingNote } from '../util.js';

const REQUIRED = ['Transaction ID', 'Date', 'Transaction Type', 'Amount', 'Net Amount'];

// Transaction ID / Date / Amount / Net Amount are generic names, so a Cash App
// specific column is required as well.
function headerIndex(rows) {
  const h = findHeaderRow(rows, REQUIRED, 5);
  if (h < 0) return -1;
  const map = columnMap(rows[h]);
  return map.has('name of sender/receiver') || map.has('asset type') ? h : -1;
}

export function detect(rows) {
  const h = headerIndex(rows);
  if (h < 0) return { score: 0 };
  return { score: 0.98, reason: 'Found Cash App columns (Transaction Type, Net Amount, Name of sender/receiver).' };
}

function mapType(type, status, amount) {
  const t = type.toLowerCase();
  const s = status.toLowerCase();
  if (s.includes('reversed') || s.includes('refunded') || t.includes('refund')) {
    // A received payment marked refunded is the original sale row; a sent
    // payment or card purchase marked refunded is the original spend row.
    if (t.includes('received') && amount > 0) return 'payment';
    if ((t.includes('sent') || t.includes('card')) && amount < 0 && !t.includes('refund')) return 'payment';
    return 'refund';
  }
  if (t.includes('direct deposit')) return 'other'; // payroll and similar: income, but not a sale
  if (/withdrawal|cash out|cash in|deposits?$|add cash|savings|transfer/.test(t)) return 'transfer';
  if (/fee/.test(t)) return 'fee';
  if (/p2p|card|payment|boost|atm/.test(t)) return 'payment';
  return 'other';
}

const SKIP_STATUS = /failed|declined|canceled|cancelled|pending|waiting/i;

export function parse(rows, options = {}, warnings = []) {
  const h = headerIndex(rows);
  if (h < 0) fail('WRONG_SOURCE', "This doesn't look like a Cash App export: we couldn't find the \"Transaction Type\" and \"Net Amount\" columns. In Cash App on the web, open Activity (or Statements) and click Export CSV.");
  const header = rows[h];
  const map = columnMap(header);
  const c = {
    id: pick(map, 'Transaction ID'), date: pick(map, 'Date'), type: pick(map, 'Transaction Type'),
    currency: pick(map, 'Currency'), amount: pick(map, 'Amount'), fee: pick(map, 'Fee'), net: pick(map, 'Net Amount'),
    status: pick(map, 'Status'), notes: pick(map, 'Notes'), name: pick(map, 'Name of sender/receiver'), account: pick(map, 'Account'),
    assetType: pick(map, 'Asset Type'),
  };
  const txns = [];
  let read = 0;
  let skipped = 0;
  let zero = 0;
  let failed = 0;
  const pending = [];
  const reSaved = rows.slice(h + 1).map((r) => cell(r, c.date)).filter((v) => /^\d{1,2}[\/.-]/.test(v));
  const dOrder = reSaved.length ? resolveDateOrder(reSaved, options, warnings, 'this Cash App file', { order: 'mdy', reason: 'Cash App exports and US spreadsheets write month/day/year' }) : 'mdy';
  const unclear = new Set();
  for (let r = h + 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.every((v) => v.trim() === '')) continue;
    read++;
    const status = cell(row, c.status);
    const dateRaw = cell(row, c.date);
    // Cash App always writes YYYY-MM-DD; the order only matters for re-saved files.
    const date = parseDate(dateRaw, dOrder);
    if (SKIP_STATUS.test(status)) {
      skipped++; failed++;
      const typeRawP = cell(row, c.type);
      const amtP = parseMoney(cell(row, c.net)) ?? parseMoney(cell(row, c.amount));
      if (/pending|waiting/i.test(status) && date && amtP && !Number.isNaN(amtP) && mapType(typeRawP, '', amtP) === 'transfer') pending.push({ date, amount: amtP / 100, description: typeRawP || 'Transfer' });
      continue;
    }
    if (!date) { skipped++; warnings.push(`Skipped a Cash App row with an unreadable date "${dateRaw}".`); continue; }
    const gross = parseMoney(cell(row, c.amount));
    let net = parseMoney(cell(row, c.net));
    const feeRaw = parseMoney(cell(row, c.fee));
    if (net === null || Number.isNaN(net)) net = gross;
    if (net === null || Number.isNaN(net)) { skipped++; warnings.push(`Skipped a Cash App row dated ${dateRaw}: unreadable amount "${cell(row, c.amount)}".`); continue; }
    if (net === 0) { skipped++; zero++; continue; }
    const typeRaw = cell(row, c.type);
    const type = mapType(typeRaw, status, net);
    const name = cleanText(cell(row, c.name));
    const notes = cleanText(cell(row, c.notes));
    const description = [name, notes].filter(Boolean).join(' - ') || typeRaw || 'Cash App transaction';
    const t = {
      date, description, amountCents: net, currency: cell(row, c.currency) || 'USD',
      id: cell(row, c.id) || undefined, type, counterparty: name || undefined, raw: rawObject(header, row),
    };
    if (type === 'transfer') {
      const acc = cell(row, c.account);
      // A Cash Out goes to the user's linked bank unless the file names a card;
      // the Account column on cash outs often just says "Cash Balance".
      const cashOut = /withdrawal|cash out/i.test(typeRaw);
      t.transferAccount = fundingKind(acc, cashOut && /cash balance/i.test(acc) ? null : unclear);
    }
    if (type === 'refund') t.refundSide = /received/i.test(typeRaw) ? 'sale' : /sent|card/i.test(typeRaw) ? 'purchase' : undefined;
    if (gross !== null && !Number.isNaN(gross) && (gross !== net || (feeRaw && !Number.isNaN(feeRaw)))) {
      t.grossCents = gross;
      t.feeCents = gross - net; // positive = fee paid
      t.netCents = net;
    }
    txns.push(makeTxn(t));
  }
  const un = unclearFundingNote(unclear, 'Cash App');
  if (un) warnings.push(un);
  const pn = pendingNote(pending, 'Cash App');
  if (pn) warnings.push(pn);
  if (failed) warnings.push(`Left out ${failed} Cash App row(s) marked failed, declined, canceled or pending; they never moved money.`);
  if (zero) warnings.push(`Left out ${zero} zero-amount Cash App row(s) (notifications and similar).`);
  // File is newest first: reverse so same-day order is chronological.
  const sorted = sortByDate(txns.reverse());
  return { transactions: sorted, warnings, meta: finishMeta(sorted, read, skipped, { timeZone: 'as exported (local time shown in the file)', ...(pending.length ? { pendingTransfers: pending } : {}) }) };
}
