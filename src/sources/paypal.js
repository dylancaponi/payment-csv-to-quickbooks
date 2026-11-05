// PayPal activity download CSV (Activity > Download / Reports > Activity download).
// Columns are user-customizable, so everything is mapped by header name.
// Dates and number formats follow the account's locale; both are sniffed.
import { fail } from '../errors.js';
import { parseMoney } from '../money.js';
import { parseDate } from '../dates.js';
import { resolveDecimal, resolveDateOrder } from '../locale.js';
import { columnMap, pick, cell, cleanText, rawObject, makeTxn, finishMeta, sortByDate, findHeaderRow , pendingNote } from '../util.js';

const REQUIRED = ['Date', 'Name', 'Type', 'Status', 'Currency', 'Gross', 'Fee', 'Net'];

// Date, Name, Type, Gross, Fee, Net are generic; PayPal's own "TimeZone" or
// "Balance Impact" column must be present too.
function headerIndex(rows) {
  const h = findHeaderRow(rows, REQUIRED, 5);
  if (h < 0) return -1;
  const map = columnMap(rows[h]);
  return map.has('timezone') || map.has('balance impact') ? h : -1;
}

export function detect(rows) {
  const h = headerIndex(rows);
  if (h < 0) {
    // Localized (non-English) PayPal export: recognize it so we can explain.
    const first = (rows[0] || []).map((v) => v.toLowerCase());
    if (first.includes('datum') && first.includes('brutto')) return { score: 0.5, reason: 'Looks like a PayPal export in German. Switch your PayPal language to English and download again.' };
    return { score: 0 };
  }
  const map = columnMap(rows[h]);
  let score = 0.9;
  if (map.has('timezone') && map.has('transaction id')) score = 0.97;
  if (map.has('balance impact') && map.has('timezone')) score = 0.98;
  return { score, reason: 'Found PayPal activity columns (TimeZone, Gross, Fee, Net, Transaction ID).' };
}

const US_ZONES = /^(PST|PDT|MST|MDT|CST|CDT|EST|EDT|AKST|AKDT|HST)$/i;
const DAY_FIRST_ZONES = /^(CET|CEST|BST|WET|WEST|EET|EEST|AEST|AEDT|ACST|ACDT|AWST|NZST|NZDT|SAST|MSK)$/i;

function mapType(type, grossCents) {
  const t = type.toLowerCase();
  if (t.includes('refund') || t.includes('reversal') && !t.includes('hold') || t.includes('chargeback') && !t.includes('fee')) return 'refund';
  if (t.includes('fee')) return 'fee';
  if (t.includes('withdrawal') || t.includes('transfer') || t.includes('deposit') || t.includes('add funds')) return 'transfer';
  if (t.includes('currency conversion')) return 'other';
  if (t.includes('payment') || t.includes('donation') || t.includes('checkout') || t.includes('subscription') || t.includes('invoice')) return 'payment';
  void grossCents;
  return 'other';
}

// Holds, their releases and authorizations do not change the real balance.
const HOLD = /\bhold\b|authori[sz]ation|\brelease\b|^order$/i;
const NOT_DONE = /^(pending|denied|failed|canceled|cancelled|voided|expired|unclaimed|placed|held)$/i;

export function parse(rows, options = {}, warnings = []) {
  const h = headerIndex(rows);
  if (h < 0) fail('WRONG_SOURCE', "This doesn't look like a PayPal activity download: we couldn't find the Date, Gross, Fee and Net columns. In PayPal go to Activity, click the Download icon, choose CSV, and make sure your PayPal language is English.");
  const header = rows[h];
  const map = columnMap(header);
  const c = {
    date: pick(map, 'Date'), time: pick(map, 'Time'), tz: pick(map, 'TimeZone', 'Time Zone'), name: pick(map, 'Name'),
    type: pick(map, 'Type'), status: pick(map, 'Status'), currency: pick(map, 'Currency'), gross: pick(map, 'Gross'),
    fee: pick(map, 'Fee'), net: pick(map, 'Net'), from: pick(map, 'From Email Address'), to: pick(map, 'To Email Address'),
    id: pick(map, 'Transaction ID'), ref: pick(map, 'Reference Txn ID'), title: pick(map, 'Item Title'),
    subject: pick(map, 'Subject'), note: pick(map, 'Note'), impact: pick(map, 'Balance Impact'),
  };
  const data = rows.slice(h + 1).filter((r) => !r.every((v) => v.trim() === ''));
  const decimal = resolveDecimal(data.flatMap((r) => [cell(r, c.gross), cell(r, c.fee), cell(r, c.net)]), options, warnings, 'this PayPal file');
  const tzs = [...new Set(data.map((r) => cell(r, c.tz)).filter(Boolean))];
  let hint = null;
  if (tzs.length && tzs.every((z) => US_ZONES.test(z))) hint = { order: 'mdy', reason: `the file's time zone (${tzs.join(', ')}) is a US one and US PayPal accounts write month/day/year` };
  else if (tzs.length && tzs.every((z) => DAY_FIRST_ZONES.test(z))) hint = { order: 'dmy', reason: `the file's time zone (${tzs.join(', ')}) is used by PayPal accounts that write day/month/year` };
  const order = resolveDateOrder(data.map((r) => cell(r, c.date)), options, warnings, 'this PayPal file', hint);
  const byId = new Map();
  for (const r of data) { const id = cell(r, c.id); if (id) byId.set(id, r); }
  const txns = [];
  let read = 0;
  let skipped = 0;
  let memo = 0;
  let holds = 0;
  let notDone = 0;
  const pending = [];
  for (const row of data) {
    read++;
    const typeRaw = cell(row, c.type);
    const status = cell(row, c.status);
    const impact = cell(row, c.impact).toLowerCase();
    if (c.impact >= 0 && impact === 'memo') { skipped++; memo++; continue; }
    if (HOLD.test(typeRaw)) { skipped++; holds++; continue; }
    const dateRaw = cell(row, c.date);
    const date = parseDate(dateRaw, order);
    if (NOT_DONE.test(status)) {
      skipped++; notDone++;
      const amt = parseMoney(cell(row, c.net), decimal) ?? parseMoney(cell(row, c.gross), decimal);
      if (/pending/i.test(status) && mapType(typeRaw, null) === 'transfer' && date && amt && !Number.isNaN(amt)) pending.push({ date, amount: amt / 100, description: typeRaw });
      continue;
    }
    if (!date) { skipped++; warnings.push(`Skipped a PayPal row with an unreadable date "${dateRaw}".`); continue; }
    const gross = parseMoney(cell(row, c.gross), decimal);
    let net = parseMoney(cell(row, c.net), decimal);
    if (net === null || Number.isNaN(net)) net = gross;
    if (net === null || Number.isNaN(net)) { skipped++; warnings.push(`Skipped a PayPal row dated ${dateRaw}: unreadable amount "${cell(row, c.gross)}".`); continue; }
    if (net === 0 && (gross === 0 || gross === null)) { skipped++; continue; }
    let name = cleanText(cell(row, c.name));
    const title = cleanText(cell(row, c.title));
    let description;
    let counterparty = name || undefined;
    const isConversion = /currency conversion/i.test(typeRaw);
    let type = mapType(typeRaw, gross);
    if (isConversion) {
      // Pair with the payment it converts so the payee survives in the books.
      const ref = cell(row, c.ref);
      const orig = ref ? byId.get(ref) : null;
      const origName = orig ? cleanText(cell(orig, c.name)) : '';
      const origAmt = orig ? `${cell(orig, c.currency)} ${cell(orig, c.gross).replace(/^-/, '')}` : '';
      description = origName ? `Currency conversion for ${origName} (${origAmt})` : 'Currency conversion';
      counterparty = origName || undefined;
      // The leg in the other currency is what the purchase (or sale) really
      // cost (or brought) in this currency, so it takes the original's type.
      // The leg in the original's own currency just offsets that payment.
      if (orig && cell(orig, c.currency) !== cell(row, c.currency)) type = mapType(cell(orig, c.type), null);
    } else {
      const kind = mapType(typeRaw, gross) === 'payment' && name ? '' : typeRaw;
      description = [name, kind, title || cleanText(cell(row, c.subject)) || cleanText(cell(row, c.note))].filter(Boolean).join(' - ') || typeRaw;
    }
    const t = {
      date, description, amountCents: net, currency: cell(row, c.currency) || 'USD',
      id: cell(row, c.id) || undefined, type, counterparty, raw: rawObject(header, row),
    };
    if (type === 'transfer') t.transferAccount = /card/i.test(typeRaw) ? 'card' : /withdrawal|bank/i.test(typeRaw) ? 'bank' : 'card';
    if (type === 'refund') {
      // Chargebacks, won chargebacks and disputes are always about the user's sales.
      if (/chargeback|dispute/i.test(typeRaw)) t.refundSide = 'sale';
    }
    if (gross !== null && !Number.isNaN(gross)) {
      t.grossCents = gross;
      t.feeCents = gross - net;
      t.netCents = net;
    }
    txns.push(makeTxn(t));
  }
  if (memo) warnings.push(`Left out ${memo} PayPal "Memo" row(s): PayPal lists them for information but they did not change your balance.`);
  if (holds) warnings.push(`Left out ${holds} PayPal hold or authorization row(s); holds and their releases cancel out and are not real income or spending.`);
  const pn = pendingNote(pending, 'PayPal');
  if (pn) warnings.push(pn);
  if (notDone) warnings.push(`Left out ${notDone} PayPal row(s) that were not completed (pending, denied, canceled and similar).`);
  const currencies = new Set(txns.map((t) => t.currency));
  if (currencies.size > 1) warnings.push(`This PayPal file has more than one currency (${[...currencies].sort().join(', ')}). Each currency is a separate PayPal balance; pick one currency when you download the import file.`);
  // PayPal downloads are usually newest first; detect and keep same-day order chronological.
  const descending = txns.length > 1 && txns[0].date > txns[txns.length - 1].date;
  const sorted = sortByDate(descending ? txns.reverse() : txns);
  return { transactions: sorted, warnings, meta: finishMeta(sorted, read, skipped, { timeZone: 'as exported (local time shown in the file)', ...(pending.length ? { pendingTransfers: pending } : {}) }) };
}
