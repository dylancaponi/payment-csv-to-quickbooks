// eBay Seller Hub transaction report CSV (Seller Hub > Payments > Reports >
// Transaction report > Create report). Sources for every rule: FORMATS.md
// Appendix E and research/2026-11-06-ebay-transaction-report-format.md.
//
// Layout (real 2026 US and UK-site files): UTF-8 with BOM, a "--,--,..."
// first line and a Notes / report block, then the header row whose first
// cell is "Transaction creation date". Empty cells are "--". Amounts: no
// symbol, minus for negatives, comma thousands inside quotes, trailing zeros
// dropped. Dates: "May 20, 2026" (US), "24 Sept 2026" (UK site). Signs are
// the effect on the eBay balance: orders positive, their fee columns
// negative; refunds negative, fees credited positive; Payout rows negative.
// Net amount is in the payout currency; gross and fee columns are in the
// transaction currency. eBay collected tax is in neither gross nor net.
// Multi-item orders: one order-level row carries Net and Gross, then one row
// per item (Net "--") carries that item's subtotal, shipping and fees.
//
// Output: per payout, one transaction per named line (sales, shipping,
// refunds, each fee type, ads, labels, claims, holds...) plus the payout,
// dated on the payout date, payoutId = eBay Payout ID. Rows with no payout
// yet are left out and counted.
import { fail } from '../errors.js';
import { parseMoney, formatCents } from '../money.js';
import { parseDate } from '../dates.js';
import { resolveDecimal } from '../locale.js';
import { columnMap, pick, cell, rawObject, makeTxn, finishMeta, findHeaderRow, norm, fundingKind } from '../util.js';

const REQUIRED = ['Transaction creation date', 'Type', 'Net amount', 'Payout currency', 'Payout ID', 'Gross transaction amount', 'Transaction currency'];
const PATH = 'In Seller Hub open the Payments tab, select Reports in the menu on the left, select Transaction report in the download section, choose the dates and select Create report';

// German eBay.de transaction report (semicolon, decimal comma, German
// headers and type names): seen in one real file, refused by name because
// only one German type value is sourced.
const GERMAN = ['Datum der Transaktionserstellung', 'Typ'];
// Payout report: column names from eBay UK's glossary only (no real file).
const PAYOUT_REPORT = ['Payout date', 'Payout ID', 'Payout method', 'Payout type'];

const GERMAN_MSG = `This is an eBay transaction report with German column names (eBay.de). This converter reads the English report only for now, because the German transaction type names are not confirmed. If you can, switch Seller Hub to English, or use the eBay.com or eBay.co.uk site, and download the report again: ${PATH}.`;
const PAYOUT_MSG = `This looks like an eBay payout report (one row per payout). It does not list the sales, fees and refunds inside each payout, so it cannot be turned into a payout journal entry. Download the transaction report instead: ${PATH}.`;

export function wrongExport(rows) {
  if (findHeaderRow(rows, GERMAN, 20) >= 0 || findSemicolonGerman(rows)) return GERMAN_MSG;
  if (findHeaderRow(rows, PAYOUT_REPORT, 20) >= 0 && findHeaderRow(rows, ['Transaction creation date'], 20) < 0) return PAYOUT_MSG;
  return null;
}

// The German file is semicolon-delimited while its first line is commas, so
// the CSV reader may pick commas: look for the header text in any cell.
function findSemicolonGerman(rows) {
  const lim = Math.min(rows.length, 20);
  for (let i = 0; i < lim; i++) if (rows[i].some((v) => /Datum der Transaktionserstellung/.test(String(v)))) return true;
  return false;
}

export function detect(rows) {
  if (findHeaderRow(rows, REQUIRED, 20) >= 0) return { score: 0.97, reason: 'Found eBay transaction report columns (Transaction creation date, Net amount, Payout ID, Gross transaction amount).' };
  return { score: 0 };
}

const n2 = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const v = (r, i) => { const x = cell(r, i); return x === '--' ? '' : x; };

// Named lines. kind: sale (sales bucket), refund (refunds), fee (fees),
// tax, other (adjustment), transfer, purchase.
const L = {
  sales: { kind: 'sale', line: 'Item sales' },
  shipping: { kind: 'sale', line: 'Shipping charged to buyers' },
  refunds: { kind: 'refund', line: 'Refunds to buyers' },
  fvf: { kind: 'fee', line: 'eBay final value fees' },
  rof: { kind: 'fee', line: 'eBay regulatory operating fee' },
  perf: { kind: 'fee', line: 'eBay performance fees (below standard, item not as described)' },
  intl: { kind: 'fee', line: 'eBay international fee' },
  deposit: { kind: 'fee', line: 'eBay deposit processing fee' },
  residual: { kind: 'other', line: 'Other amounts on orders and refunds (difference between Net and Gross plus fees)' },
  fx: { kind: 'other', line: 'Orders and refunds in another currency (net, converted by eBay)' },
  tax: { kind: 'tax', line: 'Sales tax or VAT you collected (Seller collected tax)', account: 'taxesPayable' },
  labels: { kind: 'fee', line: 'Shipping labels bought on eBay', account: 'fulfillmentFees' },
  ads: { kind: 'fee', line: 'Promoted listings and ad fees', account: 'advertising' },
  subscription: { kind: 'fee', line: 'eBay Store subscription' },
  otherFees: { kind: 'fee', line: 'Other eBay fees (listing upgrades and similar)' },
  claims: { kind: 'refund', line: 'Claims and payment disputes' },
  holds: { kind: 'other', line: 'Funds held by eBay (placed and released)', account: 'reserve' },
  purchases: { kind: 'purchase', line: 'Purchases paid with eBay funds' },
};

function dateOf(raw) {
  const s = String(raw || '').trim();
  if (/^[A-Za-z]{3,9}\.? \d{1,2}, \d{4}$/.test(s) || /^\d{1,2} [A-Za-z]{3,9}\.? \d{4}$/.test(s)) return parseDate(s);
  return null;
}

export function parse(rows, options = {}, warnings = []) {
  const h = findHeaderRow(rows, REQUIRED, 20);
  if (h < 0) {
    const w = wrongExport(rows);
    if (w) fail('WRONG_SOURCE', w);
    fail('WRONG_SOURCE', `This doesn't look like an eBay transaction report: we couldn't find the "Transaction creation date", "Net amount", "Payout ID" and "Gross transaction amount" columns. ${PATH}, then upload the downloaded CSV as it is.`);
  }
  const header = rows[h];
  const map = columnMap(header);
  const c = {
    date: pick(map, 'Transaction creation date'), type: pick(map, 'Type'), order: pick(map, 'Order number'), net: pick(map, 'Net amount'),
    payCur: pick(map, 'Payout currency'), payDate: pick(map, 'Payout date'), payId: pick(map, 'Payout ID'), status: pick(map, 'Payout status'),
    itemId: pick(map, 'Item ID'), subtotal: pick(map, 'Item subtotal'), shipping: pick(map, 'Shipping and handling', 'Postage and packaging'),
    sellerTax: pick(map, 'Seller collected tax'), ebayTax: pick(map, 'eBay collected tax'),
    fvfFixed: pick(map, 'Final Value Fee - fixed', 'Final value fee – fixed', 'Final value fee - fixed'),
    fvfVar: pick(map, 'Final Value Fee - variable', 'Final value fee – variable', 'Final value fee - variable'),
    rof: pick(map, 'Regulatory operating fee'),
    inad: pick(map, 'Very high "item not as described" fee', 'Very high \'item not as described\' fee'),
    below: pick(map, 'Below standard performance fee'), intl: pick(map, 'International fee'),
    charity: pick(map, 'Charity donation'), depositFee: pick(map, 'Deposit processing fee'),
    gross: pick(map, 'Gross transaction amount'), txCur: pick(map, 'Transaction currency'), rate: pick(map, 'Exchange rate'),
    desc: pick(map, 'Description'), ref: pick(map, 'Reference ID'),
  };
  const data = rows.slice(h + 1).filter((r) => !r.every((x) => x.trim() === '' || x.trim() === '--'));
  const moneyCols = [c.net, c.gross, c.subtotal, c.shipping, c.sellerTax, c.ebayTax, c.fvfFixed, c.fvfVar, c.rof, c.inad, c.below, c.intl, c.charity, c.depositFee].filter((i) => i >= 0);
  const decimal = resolveDecimal(data.flatMap((r) => moneyCols.map((i) => v(r, i))).filter(Boolean), options, warnings, 'this eBay transaction report', '.');
  const m = (r, i) => {
    if (i < 0) return 0;
    const x = v(r, i);
    if (!x) return 0;
    const cents = parseMoney(x, decimal);
    return cents === null || Number.isNaN(cents) ? NaN : cents;
  };

  // 1. Classify rows. Rows with no Payout ID are not paid out yet.
  let read = 0; let skipped = 0;
  const notPaid = { count: 0, byCur: new Map() };
  const payouts = new Map(); // id -> { id, currency, payoutRow, date, rows: [] , orders: Map }
  const getP = (id) => { if (!payouts.has(id)) payouts.set(id, { id, payoutRows: [], rows: [], declared: null, currencies: new Set() }); return payouts.get(id); };
  const unknownTypes = new Map();
  let bad = 0;
  for (const row of data) {
    read++;
    const type = cell(row, c.type);
    const pid = v(row, c.payId);
    const netRaw = v(row, c.net);
    const net = netRaw ? parseMoney(netRaw, decimal) : null;
    if (netRaw && (net === null || Number.isNaN(net))) { bad++; skipped++; warnings.push(`WARNING: an eBay ${type || ''} row dated ${cell(row, c.date)} has a Net amount we cannot read ("${netRaw}"). It was left out; the payout check shows the gap.`); continue; }
    const date = dateOf(cell(row, c.date));
    if (!date) { bad++; skipped++; warnings.push(`WARNING: an eBay ${type || ''} row has a Transaction creation date we cannot read ("${cell(row, c.date)}"). It was left out; the payout check shows the gap.`); continue; }
    if (!pid) {
      skipped++;
      if (net) { notPaid.count++; const cur = (v(row, c.payCur) || v(row, c.txCur) || '?').toUpperCase(); notPaid.byCur.set(cur, (notPaid.byCur.get(cur) || 0) + net); }
      continue;
    }
    const p = getP(pid);
    const cur = v(row, c.payCur).toUpperCase();
    if (cur) p.currencies.add(cur);
    const pd = dateOf(v(row, c.payDate));
    if (pd && (!p.declared || pd > p.declared)) p.declared = pd;
    if (norm(type) === 'payout') p.payoutRows.push({ row, net, date });
    else p.rows.push({ row, net, date, type });
  }

  if (data.length && bad === data.length) fail('BAD_FILE', `None of the dates or amounts in this eBay report could be read (for example "${cell(data[0], c.date)}"). This happens when the file was opened and saved again in a spreadsheet, which rewrites the dates. Upload the original download from Seller Hub instead.`);
  // 2. Each payout into named lines.
  const txns = [];
  const checks = [];
  const fxRows = { count: 0 };
  let ebayTaxCents = 0;
  let expressFees = 0;
  let residualCount = 0; let unchecked = 0; let mismatched = 0; let multiPayoutRows = 0;
  for (const p of payouts.values()) {
    if (p.currencies.size !== 1) fail('BAD_FILE', `eBay payout ${p.id} lists ${p.currencies.size ? `more than one payout currency (${[...p.currencies].join(', ')})` : 'no payout currency'}. We do not convert it rather than add amounts across currencies; please report this file.`);
    const currency = [...p.currencies][0];
    if (!/^[A-Z]{3}$/.test(currency)) fail('BAD_FILE', `eBay payout ${p.id} has payout currency "${currency}", which is not a 3-letter currency code.`);
    if (p.payoutRows.length > 1) { multiPayoutRows++; fail('BAD_FILE', `eBay payout ${p.id} has ${p.payoutRows.length} Payout rows, so the same report looks pasted in more than once. Upload one transaction report per file, as downloaded.`); }
    const lines = new Map();
    const add = (key, cents, overrideLine) => {
      if (!cents) return;
      const def = L[key];
      const k = overrideLine ? `${key}|${overrideLine}` : key;
      if (!lines.has(k)) lines.set(k, { ...def, line: overrideLine || def.line, cents: 0 });
      lines.get(k).cents += cents;
    };
    let rowsCents = 0;
    // Orders and refunds grouped by type + order number, so the order-level
    // row and its item rows are read together and never counted twice.
    const groups = new Map();
    for (const r of p.rows) {
      if (r.net !== null) rowsCents += r.net;
      const t = norm(r.type);
      if (t === 'order' || t === 'refund') {
        const k = `${t}|${cell(r.row, c.order)}`;
        if (!groups.has(k)) groups.set(k, { type: t, rows: [] });
        groups.get(k).rows.push(r);
        continue;
      }
      if (r.net === null || !r.net) continue;
      const desc = v(r.row, c.desc);
      if (t === 'shipping label' || t === 'postage label') add('labels', r.net);
      else if (t === 'other fee') {
        if (/promoted|ad fee/i.test(desc)) add('ads', r.net);
        else if (/subscription/i.test(desc)) add('subscription', r.net);
        else add('otherFees', r.net);
      } else if (t === 'claim' || t === 'payment dispute') add('claims', r.net);
      else if (t === 'hold') add('holds', r.net);
      else if (t === 'purchase') add('purchases', r.net);
      else if (t === 'charge') {
        // Money eBay took from your bank or card into the eBay balance.
        const kind = fundingKind(desc);
        const key = `charge|${kind}`;
        if (!lines.has(key)) lines.set(key, { kind: 'transfer', transferAccount: kind, line: kind === 'card' ? 'Charged by eBay to your card' : 'Charged by eBay to your bank', cents: 0 });
        lines.get(key).cents += r.net;
      } else {
        const label = `Other eBay amounts: ${r.type || '(blank)'}`;
        const u = unknownTypes.get(r.type || '(blank)') || { count: 0, cents: 0, currency };
        u.count++; u.cents += r.net; unknownTypes.set(r.type || '(blank)', u);
        add('residual', r.net, label);
      }
    }
    for (const g of groups.values()) {
      const netRows = g.rows.filter((r) => r.net !== null);
      const itemRows = g.rows.filter((r) => r.net === null);
      if (!netRows.length) continue; // item rows of an order whose order-level row is not in this file: no money
      const net = netRows.reduce((s, r) => s + r.net, 0);
      const txCur = (v(netRows[0].row, c.txCur) || currency).toUpperCase();
      for (const r of netRows) ebayTaxCents += (txCur === currency ? m(r.row, c.ebayTax) || 0 : 0);
      if (txCur !== currency) { fxRows.count++; add('fx', net); continue; }
      const gross = netRows.reduce((s, r) => s + m(r.row, c.gross), 0);
      const src = itemRows.length ? itemRows : netRows;
      const sum = (i) => src.reduce((s, r) => s + m(r.row, i), 0);
      const fees = { fvf: sum(c.fvfFixed) + sum(c.fvfVar), rof: sum(c.rof), perf: sum(c.inad) + sum(c.below), intl: sum(c.intl), deposit: sum(c.depositFee) };
      const shipping = sum(c.shipping);
      const sellerTax = netRows.reduce((s, r) => s + m(r.row, c.sellerTax), 0) || sum(c.sellerTax);
      const vals = [gross, shipping, sellerTax, ...Object.values(fees)];
      if (vals.some((x) => Number.isNaN(x))) {
        // A money cell we cannot read: keep the net, unsplit, and say so.
        add('residual', net);
        residualCount++;
        continue;
      }
      const feeTotal = Object.values(fees).reduce((s, x) => s + x, 0);
      // Seller collected tax is moved out of sales only when the row shows
      // it inside gross (gross = subtotal + shipping + tax); otherwise it
      // stays in sales and is named in a warning.
      const subtotal = src.reduce((s, r) => s + (m(r.row, c.subtotal) || 0), 0);
      const taxInGross = sellerTax && gross === subtotal + shipping + sellerTax;
      const goods = gross - shipping - (taxInGross ? sellerTax : 0);
      if (g.type === 'order') { add('sales', goods); add('shipping', shipping); }
      else add('refunds', goods + shipping);
      if (taxInGross) add('tax', sellerTax);
      for (const [k, x] of Object.entries(fees)) add(k, x);
      const residual = net - gross - feeTotal;
      if (residual) { residualCount++; add('residual', residual); }
    }
    // Payout amount and the check.
    const payoutRow = p.payoutRows[0];
    const date = p.declared || (payoutRow && payoutRow.date) || p.rows.reduce((d, r) => (!d || r.date > d ? r.date : d), null);
    const base = { date, currency, payoutId: p.id, payoutDate: date };
    let n = 0;
    const ORDER = Object.keys(L);
    const rank = (k) => { const i = ORDER.indexOf(k.split('|')[0]); return i < 0 ? ORDER.length : i; };
    const sortedLines = [...lines.entries()].sort((x, y) => rank(x[0]) - rank(y[0]) || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).map((e) => e[1]);
    for (const l of sortedLines) {
      if (!l.cents) continue;
      n++;
      const t = { ...base, id: `${p.id}:${n}`, description: `eBay payout ${p.id}: ${l.line}`, amountCents: l.cents, raw: { 'Payout ID': p.id, line: l.line } };
      if (l.kind === 'sale') { t.type = l.cents >= 0 ? 'payment' : 'refund'; if (l.cents < 0) t.refundSide = 'sale'; }
      else if (l.kind === 'refund') { t.type = 'refund'; t.refundSide = 'sale'; }
      else if (l.kind === 'fee') t.type = 'fee';
      else if (l.kind === 'tax') { t.type = 'other'; t.taxCents = l.cents; }
      else if (l.kind === 'transfer') { t.type = 'transfer'; t.transferAccount = l.transferAccount; }
      else if (l.kind === 'purchase') { t.type = l.cents < 0 ? 'payment' : 'refund'; if (l.cents > 0) t.refundSide = 'purchase'; }
      else t.type = 'other';
      const txn = makeTxn(t);
      if (l.kind !== 'transfer') {
        txn.journalLine = l.line;
        if (l.account) txn.journalAccount = l.account;
      }
      txns.push(txn);
    }
    if (payoutRow) {
      const amount = -payoutRow.net; // the Payout row is negative: money left the eBay balance
      // Express payouts: the Payout row's Net is the amount before the fee;
      // its description says "Express payout fee $2.0 deducted,$140.35
      // sent" (real US reports). Book the fee; the bank gets what was sent.
      const pdesc = v(payoutRow.row, c.desc);
      let sentCents = amount;
      if (/fee/i.test(pdesc) && /deducted/i.test(pdesc)) {
        const fm = /fee\s*[^\d-]{0,3}(\d[\d,]*(?:\.\d+)?)\s*deducted/i.exec(pdesc);
        const sm = /deducted\s*,?\s*[^\d-]{0,3}(\d[\d,]*(?:\.\d+)?)\s*sent/i.exec(pdesc);
        const feeC = fm ? parseMoney(fm[1], '.') : null;
        const sentC = sm ? parseMoney(sm[1], '.') : null;
        if (feeC !== null && sentC !== null && !Number.isNaN(feeC) && !Number.isNaN(sentC) && feeC + sentC === amount) {
          sentCents = sentC;
          expressFees++;
          const ft = makeTxn({ ...base, id: `${p.id}:payoutfee`, description: `eBay payout ${p.id}: eBay express payout fee`, amountCents: -feeC, type: 'fee', raw: { 'Payout ID': p.id, line: 'eBay express payout fee' } });
          ft.journalLine = 'eBay express payout fee';
          txns.push(ft);
        } else {
          warnings.push(`WARNING: eBay payout ${p.id} says a fee was deducted ("${pdesc}"), but we could not read the fee and the amount sent so that they add up to the payout of ${formatCents(amount)} ${currency}. The bank line uses ${formatCents(amount)}, which is more than reached your bank. Correct that payout's bank line by hand.`);
        }
      }
      // A zero Payout row is only written when the rows do not add up, so the
      // journal shows the gap instead of a 0.00 bank line.
      if (amount || rowsCents) txns.push(makeTxn({ ...base, id: `${p.id}:payout`, description: amount < 0 ? `eBay payout ${p.id}: taken from your bank` : `eBay payout ${p.id}: sent to your bank`, amountCents: -sentCents, type: 'payout', raw: rawObject(header, payoutRow.row) }));
      const diff = rowsCents - amount;
      if (diff) { mismatched++; warnings.push(`WARNING: eBay payout ${p.id} does not add up. Its rows in this file total ${formatCents(rowsCents)} ${currency}, but the Payout row says ${formatCents(amount)} (difference ${formatCents(diff)}). This happens when some of the payout's sales or fees fall before the start date of the report; download a report that starts earlier. The payout is booked at ${formatCents(amount)} and the difference goes to the clearing account.`); }
      checks.push({ payoutId: p.id, currency, rows: rowsCents / 100, payout: amount / 100, reconciled: diff === 0 });
    } else {
      unchecked++;
      // No Payout row in this file (it was created after the report's end
      // date): the bank amount is the sum of the rows, unchecked.
      txns.push(makeTxn({ ...base, id: `${p.id}:payout`, description: `eBay payout ${p.id}: sent to your bank (not in this report, not checked)`, amountCents: -rowsCents, type: 'payout', raw: { 'Payout ID': p.id } }));
      checks.push({ payoutId: p.id, currency, rows: rowsCents / 100, payout: null, reconciled: false });
    }
  }

  if (expressFees) warnings.push(`${n2(expressFees, 'eBay payout was an express payout', 'eBay payouts were express payouts')}: the express payout fee from the Payout row description is booked on its own fee line, and the bank line is the amount eBay says it sent.`);
  if (unchecked) warnings.push(`WARNING: ${n2(unchecked, 'eBay payout has', 'eBay payouts have')} sales or fees in this file but no Payout row (the payout happened after the report's end date), so their bank amount is the sum of their rows and could not be checked against eBay. Download a report that ends later to check them.`);
  const unpaidTotal = [...notPaid.byCur.entries()].map(([k, x]) => `${formatCents(x)} ${k}`).join(', ');
  if (notPaid.count) warnings.push(`Left out ${n2(notPaid.count, 'eBay row that is', 'eBay rows that are')} not part of a payout yet (no Payout ID: funds on hold or still processing), totalling ${unpaidTotal}. They will appear with their payout in a later report.`);
  if (fxRows.count) warnings.push(`${n2(fxRows.count, 'eBay order or refund was', 'eBay orders or refunds were')} in another currency than the payout. Their gross and fees are in the sale currency, so only the converted Net amount is booked, on its own line, and their fees are not split out.`);
  if (residualCount) warnings.push(`${n2(residualCount, 'eBay order or refund has', 'eBay orders or refunds have')} a Net amount that is not Gross plus the fee columns we read (for example a charity donation, or a money cell we could not read). The difference is kept on its own line ("Other amounts on orders and refunds") and booked to Uncategorized Income or Expense in a journal entry. Check them in Seller Hub.`);
  const unknownList = [...unknownTypes.entries()].map(([k, u]) => `${k} (${n2(u.count, 'row', 'rows')}, ${formatCents(u.cents)} ${u.currency})`).join('; ');
  if (unknownTypes.size) warnings.push(`Some eBay rows have a type this converter does not recognise yet: ${unknownList}. They are kept on their own line named after the type and booked to Uncategorized Income or Expense in a journal entry. Check them in the preview.`);
  if (ebayTaxCents) warnings.push(`eBay collected and paid ${formatCents(Math.abs(ebayTaxCents))} of sales tax or VAT for you (eBay collected tax). That money never reached your payouts, so it is not booked as income or anywhere else.`);
  const holds = txns.filter((t) => t.journalAccount === 'reserve').reduce((s, t) => s + Math.round(t.amount * 100), 0);
  if (holds) warnings.push(`eBay holds total ${formatCents(holds)}: money eBay held back (negative) or released (positive). It is still yours, so it is never income or expense: it stays in your eBay clearing account (in a journal entry, "Uncategorized Asset" unless you set a reserve account).`);
  if (txns.some((t) => t.journalAccount === 'taxesPayable')) warnings.push('Sales tax or VAT you collected yourself (Seller collected tax) is on its own line. In a journal entry it is booked to "Sales Tax / VAT Payable" (a liability, not income) unless you set your own sales tax or VAT account; that account must exist in your books.');
  if (txns.some((t) => t.type === 'transfer')) warnings.push('eBay took money from your bank or card for some payouts (Charge rows). They are booked as money moved from your bank (or card) into eBay, never as income.');
  const negative = txns.filter((t) => t.type === 'payout' && t.amount > 0).length;
  if (negative) warnings.push(`${n2(negative, 'eBay payout is', 'eBay payouts are')} negative: eBay took money from you instead of paying out.`);
  if (!payouts.size && notPaid.count) warnings.push('Nothing in this file has been paid out yet, so there is no payout to convert.');

  const meta = finishMeta(txns, read, skipped, { timeZone: 'as written by eBay; every line is dated on its payout date', payouts: checks, payoutCount: payouts.size, notPaidOut: notPaid.count, reconciled: !mismatched && !unchecked });
  return { transactions: txns.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)), warnings, meta };
}
