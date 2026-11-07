// Amazon Seller Central settlement report, "Flat File V2"
// (GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2; Reports > Payments
// / All Statements > Download Flat File V2). Sources for every rule below:
// FORMATS.md, Amazon settlement report, and
// research/2026-11-06-amazon-settlement-format.md.
//
// Layout (SP-API report type docs + seven real 2024 files from US, UK, DE
// and FR): tab-delimited, one header row of 24 columns (older files lack
// promotion-id), then a summary row that fills only settlement-id,
// settlement-start-date, settlement-end-date, deposit-date, total-amount and
// currency, then one row per amount: transaction-type, amount-type,
// amount-description, amount. total-amount equals the sum of every amount in
// the settlement, reserve rows included: it is the deposit.
// Dates: "2024-10-09 14:28:38 UTC" (US) or "11.10.2024 08:59:52 UTC" (UK,
// DE, FR). Amounts: "95,00" in EUR files, "253.43" in US and UK files, no
// thousands separators, not always padded ("-18.3").
//
// Each settlement becomes one transaction per named line (sales, refunds,
// each kind of fee, tax, reserve...) plus the payout, all dated on the
// deposit date with payoutId = settlement id, so the Amazon balance nets to
// zero per settlement and the journal gets one entry per deposit.
import { fail } from '../errors.js';
import { parseMoney, formatCents } from '../money.js';
import { parseDate } from '../dates.js';
import { resolveDecimal } from '../locale.js';
import { columnMap, pick, cell, rawObject, makeTxn, finishMeta, findHeaderRow, norm } from '../util.js';

const REQUIRED = ['settlement-id', 'deposit-date', 'total-amount', 'currency', 'transaction-type', 'amount-type', 'amount-description', 'amount'];

// Date Range Reports > Transaction CSV: a different report (no deposit
// total per settlement), refused by name.
const DATE_RANGE = ['date/time', 'settlement id', 'type', 'order id', 'total'];

// The older Flat File (V1) settlement report: same settlement-id and
// total-amount columns, but money in price-type / price-amount and fee
// columns instead of amount-type / amount. Refused by name (review finding 3).
const V1A = ['settlement-id', 'total-amount', 'price-type'];
const V1B = ['settlement-id', 'total-amount', 'price-amount'];
const V1_MSG = 'This is Amazon\'s older settlement report (Flat File, also called V1), which this converter does not read. In Seller Central open Reports, then Payments, then All Statements, and click "Download Flat File V2" next to the settlement. Upload that .txt file instead.';

function isV1(rows) {
  return findHeaderRow(rows, REQUIRED, 5) < 0 && (findHeaderRow(rows, V1A, 5) >= 0 || findHeaderRow(rows, V1B, 5) >= 0);
}

export function wrongExport(rows) {
  if (findHeaderRow(rows, DATE_RANGE, 15) >= 0) return DATE_RANGE_MSG;
  if (isV1(rows)) return V1_MSG;
  return null;
}

const DATE_RANGE_MSG = 'This is an Amazon Date Range "Transaction" report. It does not carry the total of each settlement (the amount Amazon deposited), so its journal could not be checked against your bank. Download the settlement report instead: in Seller Central open Reports, then Payments, then All Statements, and click "Download Flat File V2" next to the settlement, then upload that .txt file.';

export function detect(rows) {
  if (findHeaderRow(rows, REQUIRED, 5) >= 0) return { score: 0.98, reason: 'Found Amazon settlement report columns (settlement-id, deposit-date, total-amount, amount-type, amount-description).' };
  return { score: 0 };
}

// Named lines. key: `${amountType}|${amountDescription}` (lower case) or
// `*|${amountDescription}`. kind decides the Txn type:
//   sale      payment (sales bucket), refundSide sale when negative
//   refund    refund on a sale (refunds bucket, both signs)
//   tax       part of amount that is tax (taxes bucket)
//   fee       fee (fees bucket, both signs)
//   other     adjustment (income or expense by sign) unless account given
// Every amount-description below was seen in a real file (FORMATS.md).
const FEE_SELLING = 'Amazon selling fees (referral, refund admin, holdback)';
const FEE_FBA = 'FBA fulfillment fees';
const TAX_IN = 'Sales tax or VAT charged to buyers';
const TAX_MF = 'Sales tax or VAT kept by Amazon (marketplace facilitator)';
const LINES = {
  'itemfees|commission': { kind: 'fee', line: FEE_SELLING },
  'itemfees|refundcommission': { kind: 'fee', line: FEE_SELLING },
  'itemfees|shippinghb': { kind: 'fee', line: FEE_SELLING },
  'itemfees|digitalservicesfee': { kind: 'fee', line: 'Digital services fee' },
  'itemfees|fbaperunitfulfillmentfee': { kind: 'fee', line: FEE_FBA, account: 'fulfillmentFees' },
  'itemfees|fbaweightbasedfee': { kind: 'fee', line: FEE_FBA, account: 'fulfillmentFees' },
  'itemfees|fbaperorderfulfillmentfee': { kind: 'fee', line: FEE_FBA, account: 'fulfillmentFees' },
  'itemfees|shippingchargeback': { kind: 'fee', line: 'Shipping chargebacks (shipping credit passed to Amazon)', account: 'fulfillmentFees' },
  'itemfees|liquidationsbrokeragefee': { kind: 'fee', line: 'FBA liquidation fees', account: 'fulfillmentFees' },
  'itemprice|tax': { kind: 'tax', line: TAX_IN },
  'itemprice|shippingtax': { kind: 'tax', line: TAX_IN },
  'itemwithheldtax|marketplacefacilitatortax-principal': { kind: 'tax', line: TAX_MF },
  'itemwithheldtax|marketplacefacilitatortax-shipping': { kind: 'tax', line: TAX_MF },
  'itemwithheldtax|marketplacefacilitatorvat-principal': { kind: 'tax', line: TAX_MF },
  'itemwithheldtax|marketplacefacilitatorvat-shipping': { kind: 'tax', line: TAX_MF },
  'cost of advertising|transactiontotalamount': { kind: 'fee', line: 'Advertising (Cost of Advertising)', account: 'advertising' },
  'other-transaction|previous reserve amount balance': { kind: 'other', line: 'Reserve released from the previous settlement', account: 'reserve' },
  'other-transaction|current reserve amount': { kind: 'other', line: 'Reserve held back by Amazon', account: 'reserve' },
  'other-transaction|storage fee': { kind: 'fee', line: 'FBA storage fees', account: 'fulfillmentFees' },
  'other-transaction|removalcomplete': { kind: 'fee', line: 'FBA removal and disposal fees', account: 'fulfillmentFees' },
  'other-transaction|disposalcomplete': { kind: 'fee', line: 'FBA removal and disposal fees', account: 'fulfillmentFees' },
  'fba inventory reimbursement|*': { kind: 'other', line: 'FBA inventory reimbursements', account: 'adjustmentsIncome' },
};

function classify(txType, amountType, desc) {
  const tt = norm(txType); const at = norm(amountType); const d = norm(desc);
  if (at === 'itemprice') {
    if (d === 'principal' || d === 'shipping') {
      const what = d === 'principal' ? 'Product sales' : 'Shipping charged to buyers';
      if (tt === 'order') return { kind: 'sale', line: what };
      if (tt === 'refund') return { kind: 'refund', line: `Refunds: ${what.toLowerCase()}` };
      if (tt === 'liquidations' && d === 'principal') return { kind: 'sale', line: 'FBA liquidation proceeds' };
      return null;
    }
    if (d === 'restockingfee' && tt === 'refund') return { kind: 'refund', line: 'Restocking fees kept from refunds' };
  }
  // Promotion / TaxDiscount cancels the tax on a promoted amount (real UK
  // files: ShippingTax 0.33 then TaxDiscount -0.33), so it is tax, not a
  // sales promotion (review finding 1).
  if (at === 'promotion' && d === 'taxdiscount' && (tt === 'order' || tt === 'refund')) return { kind: 'tax', line: TAX_IN };
  if (at === 'promotion' && (tt === 'order' || tt === 'refund')) return { kind: 'refund', line: 'Promotional rebates', account: 'sales' };
  return LINES[`${at}|${d}`] || LINES[`${at}|*`] || null;
}

function settlementDate(raw) {
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{1,2}-\d{1,2}(?:$|[T\s])/.test(s)) return parseDate(s, 'mdy');
  if (/^\d{1,2}\.\d{1,2}\.\d{4}(?:$|\s)/.test(s)) return parseDate(s, 'dmy');
  return null;
}

export function parse(rows, options = {}, warnings = []) {
  const h = findHeaderRow(rows, REQUIRED, 5);
  if (h < 0) {
    if (findHeaderRow(rows, DATE_RANGE, 15) >= 0) fail('WRONG_SOURCE', DATE_RANGE_MSG);
    if (isV1(rows)) fail('WRONG_SOURCE', V1_MSG);
    fail('WRONG_SOURCE', 'This doesn\'t look like an Amazon settlement report: we couldn\'t find the settlement-id, total-amount, amount-type, amount-description and amount columns. In Seller Central open Reports, then Payments, then All Statements, and click "Download Flat File V2" next to the settlement (a tab-separated .txt file).');
  }
  const header = rows[h];
  const map = columnMap(header);
  const c = {
    id: pick(map, 'settlement-id'), start: pick(map, 'settlement-start-date'), end: pick(map, 'settlement-end-date'), deposit: pick(map, 'deposit-date'),
    total: pick(map, 'total-amount'), currency: pick(map, 'currency'), txType: pick(map, 'transaction-type'), amountType: pick(map, 'amount-type'),
    desc: pick(map, 'amount-description'), amount: pick(map, 'amount'), order: pick(map, 'order-id'),
  };
  const data = rows.slice(h + 1).filter((r) => !r.every((v) => v.trim() === ''));
  const decimal = resolveDecimal(data.flatMap((r) => [cell(r, c.total), cell(r, c.amount)]).filter(Boolean), options, warnings, 'this Amazon settlement report', null);

  // 1. Split rows by settlement. A summary row has total-amount filled and
  // no transaction-type.
  const settlements = new Map();
  const get = (id) => {
    if (!settlements.has(id)) settlements.set(id, { id, summaries: [], rows: [] });
    return settlements.get(id);
  };
  let read = 0; let skipped = 0; let noId = 0;
  for (const row of data) {
    read++;
    const id = cell(row, c.id);
    if (!id) { noId++; skipped++; continue; }
    if (cell(row, c.total) !== '' && cell(row, c.txType) === '') get(id).summaries.push(row);
    else get(id).rows.push(row);
  }
  if (noId) warnings.push(`WARNING: ${noId} row(s) in this Amazon file have no settlement-id, so we cannot tell which settlement they belong to. They were left out; the settlement total check below shows whether money is missing.`);
  if (!settlements.size) fail('NO_TRANSACTIONS', 'This Amazon settlement report has a header row but no settlement rows.');
  for (const s of settlements.values()) {
    if (!s.summaries.length) fail('BAD_FILE', `Settlement ${s.id} in this file has no summary row (the row that holds total-amount, deposit-date and currency), so we cannot check its rows against the deposit. Upload the Flat File V2 report exactly as Amazon gave it, without removing rows.`);
    if (s.summaries.length > 1) fail('BAD_FILE', `Settlement ${s.id} appears ${s.summaries.length} times in this file (its summary row is repeated), so the same report looks pasted in more than once. Upload one settlement report per file, as downloaded.`);
  }

  // 2. One settlement per output: options.account picks it (the site shows
  // a menu); the default is the first one in the file.
  const ids = [...settlements.keys()];
  const describe = (s) => {
    const sum = s.summaries[0];
    return { account: s.id, currency: (cell(sum, c.currency) || '').toUpperCase(), transactions: s.rows.length };
  };
  let chosenId = ids[0];
  if (options.account !== undefined && options.account !== null && options.account !== '') {
    if (typeof options.account !== 'string') fail('BAD_OPTION', 'The settlement choice must be text, such as a settlement id.');
    const want = options.account.trim().split(/\s+/)[0];
    if (!settlements.has(want)) fail('BAD_OPTION', `This file has no settlement "${options.account}". It holds: ${ids.join(', ')}.`, { accounts: ids.map((id) => describe(settlements.get(id))) });
    chosenId = want;
  }
  if (ids.length > 1) warnings.push(`This file holds ${ids.length} Amazon settlements (${ids.join(', ')}). Only settlement ${chosenId} is converted, because each output holds one settlement and one deposit. Choose the settlement to convert the others one at a time.`);
  const s = settlements.get(chosenId);
  const sum = s.summaries[0];

  // 3. Summary facts.
  const currency = (cell(sum, c.currency) || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) fail('BAD_FILE', `Settlement ${s.id} has currency "${cell(sum, c.currency)}", which is not a 3-letter currency code.`);
  const depositRaw = cell(sum, c.deposit);
  const date = settlementDate(depositRaw);
  if (!date) fail('BAD_FILE', `Settlement ${s.id} has a deposit-date we cannot read ("${depositRaw}"). We read dates written as 2024-10-25 14:28:39 UTC or 25.10.2024 14:28:39 UTC.`);
  const totalCents = parseMoney(cell(sum, c.total), decimal);
  if (totalCents === null || Number.isNaN(totalCents)) fail('BAD_FILE', `Settlement ${s.id} has a total-amount we cannot read ("${cell(sum, c.total)}").`);
  const start = settlementDate(cell(sum, c.start));
  const end = settlementDate(cell(sum, c.end));

  // 4. Rows into named lines.
  const lines = new Map(); // key -> { kind, line, account, cents, count, raw }
  const unknown = new Map(); // label -> { count, cents }
  let rowCents = 0; let bad = 0; let otherCurrency = 0;
  for (const row of s.rows) {
    const rc = cell(row, c.currency).toUpperCase();
    if (rc && rc !== currency) { otherCurrency++; continue; }
    const raw = cell(row, c.amount);
    const cents = parseMoney(raw, decimal);
    if (cents === null || Number.isNaN(cents)) { bad++; skipped++; warnings.push(`WARNING: an Amazon row in settlement ${s.id} (${cell(row, c.txType)} ${cell(row, c.amountType)} ${cell(row, c.desc)}${cell(row, c.order) ? `, order ${cell(row, c.order)}` : ''}) has an amount we cannot read ("${raw}"). It was left out.`); continue; }
    rowCents += cents;
    if (!cents) continue;
    const txType = cell(row, c.txType); const amountType = cell(row, c.amountType); const desc = cell(row, c.desc);
    let m = classify(txType, amountType, desc);
    if (!m) {
      const label = `Other Amazon amounts: ${[txType, amountType, desc].filter(Boolean).join(' / ') || '(blank)'}`;
      const u = unknown.get(label) || { count: 0, cents: 0 };
      u.count++; u.cents += cents; unknown.set(label, u);
      m = { kind: 'other', line: label };
    }
    // A sale line can only be money in; a negative Principal on an order is
    // booked against sales as a correction, never as a payment sent.
    const key = `${m.kind}|${m.account || ''}|${m.line}`;
    if (!lines.has(key)) lines.set(key, { ...m, cents: 0, count: 0 });
    const l = lines.get(key);
    l.cents += cents; l.count++;
  }
  if (otherCurrency) fail('BAD_FILE', `Settlement ${s.id} is in ${currency}, but ${otherCurrency} of its rows name another currency. We do not convert mixed-currency settlements; please report this file.`);

  // 5. Transactions.
  const taxNetCents = [...lines.values()].filter((l) => l.kind === 'tax').reduce((a, l) => a + l.cents, 0);
  const txns = [];
  const base = { date, currency, payoutId: s.id, payoutDate: date };
  const summaryRaw = rawObject(header, sum);
  let n = 0;
  for (const l of lines.values()) {
    if (!l.cents) continue;
    n++;
    const t = { ...base, id: `${s.id}:${n}`, description: `Amazon settlement ${s.id}: ${l.line}`, amountCents: l.cents, raw: { ...summaryRaw, 'line': l.line, 'rows': String(l.count) } };
    if (l.kind === 'sale') { t.type = l.cents >= 0 ? 'payment' : 'refund'; if (l.cents < 0) t.refundSide = 'sale'; }
    else if (l.kind === 'refund') { t.type = 'refund'; t.refundSide = 'sale'; }
    else if (l.kind === 'tax') { t.type = 'other'; t.taxCents = l.cents; }
    else if (l.kind === 'fee') t.type = 'fee';
    else t.type = 'other';
    const txn = makeTxn(t);
    txn.journalLine = l.line;
    if (l.account) txn.journalAccount = l.account;
    // Tax Amazon did not withhold is owed by the seller: it goes to a
    // payable account, never to income by default (review finding 9).
    if (l.kind === 'tax' && taxNetCents) txn.journalAccount = 'taxesPayable';
    txns.push(txn);
  }
  const diff = rowCents - totalCents;
  // The payout: what Amazon sent to the bank (negative from the Amazon
  // balance's view). A zero deposit is only written when the rows do not
  // add up, so the journal shows the gap instead of inventing a deposit.
  if (totalCents || diff) {
    txns.push(makeTxn({ ...base, id: `${s.id}:deposit`, description: totalCents < 0 ? `Amazon settlement ${s.id}: charged to you` : `Amazon settlement ${s.id}: deposit`, amountCents: -totalCents, type: 'payout', raw: summaryRaw }));
  }

  // 6. Checks and notes.
  if (diff) warnings.push(`WARNING: Amazon settlement ${s.id} does not add up. Its rows total ${formatCents(rowCents)} ${currency}, but the settlement's total-amount (the deposit) is ${formatCents(totalCents)} (difference ${formatCents(diff)}). Rows may be missing from this file or could not be read. The deposit is booked as ${formatCents(totalCents)} and the difference goes to the clearing account. Compare with the settlement in Seller Central before importing.`);
  if (totalCents < 0) warnings.push(`Amazon settlement ${s.id} has a negative total (${formatCents(totalCents)}): Amazon took money from you (your card or bank) instead of paying a deposit. It is booked as money out of your bank account; if Amazon charged a credit card, move that line to the card account.`);
  if (unknown.size) {
    const list = [...unknown.entries()].map(([k, u]) => `${k.replace(/^Other Amazon amounts: /, '')} (${u.count} row(s), ${formatCents(u.cents)})`).join('; ');
    warnings.push(`Some Amazon amounts are of a kind this converter does not recognise yet: ${list}. They are kept, each on its own line named after Amazon's description, and booked to "Uncategorized Income" (money in) or "Uncategorized Expense" (money out) in a journal entry. Check them in the preview and recategorize them in your books.`);
  }
  const taxNet = [...lines.values()].filter((l) => l.kind === 'tax').reduce((a, l) => a + l.cents, 0);
  if (taxNet) warnings.push(`In settlement ${s.id}, ${formatCents(taxNet)} of sales tax or VAT charged to buyers was not kept back by Amazon as marketplace facilitator, so it reached you and you may owe it. It is on its own line marked as sales tax or VAT. In a journal entry it is booked to "Sales Tax / VAT Payable" (a liability, not income) unless you set your own sales tax or VAT account in the options; that account must exist in your books.`);
  const reserve = [...lines.values()].filter((l) => l.account === 'reserve').reduce((a, l) => a + l.cents, 0);
  if (reserve) warnings.push(`Settlement ${s.id} moves ${formatCents(Math.abs(reserve))} ${reserve < 0 ? 'into' : 'out of'} Amazon's reserve. Reserved money is still yours, so it is never income or expense: it stays in your Amazon clearing account (in a journal entry, "Uncategorized Asset" unless you set a reserve account).`);
  if (bad) warnings.push(`${bad} Amazon row(s) were left out because their amount could not be read.`);

  const meta = finishMeta(txns, read, skipped, {
    timeZone: 'UTC as written by Amazon; every line is dated on the deposit date',
    settlementId: s.id, settlementStart: start, settlementEnd: end, depositDate: date,
    depositTotal: totalCents / 100, rowsTotal: rowCents / 100, reconciled: diff === 0,
  });
  if (ids.length > 1) { meta.account = s.id; meta.accounts = ids.map((id) => describe(settlements.get(id))); meta.accountKind = 'settlement'; }
  return { transactions: txns, warnings, meta };
}
