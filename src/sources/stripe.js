// Stripe exports. One parser understands every layout we know:
//  - Legacy Dashboard balance history (balance_history.csv):
//    id,Type,Source,Amount,Fee,Net,Currency,Created (UTC),...,Transfer,...
//  - Reports itemized CSVs (Balance change from activity, Payouts section,
//    Payout reconciliation): balance_transaction_id, created(_utc), currency,
//    gross, fee, net, reporting_category, description, automatic_payout_id...
//  - Dashboard Payouts list export (header not confirmed; best effort).
// Every amount is treated from the Stripe balance's point of view: charges
// add, refunds, fees and payouts subtract.
import { fail } from '../errors.js';
import { parseMoney } from '../money.js';
import { parseDate } from '../dates.js';
import { resolveDecimal, resolveDateOrder, utcDateReader } from '../locale.js';
import { columnMap, pick, cell, cleanText, rawObject, makeTxn, finishMeta, sortByDate, norm } from '../util.js';

const STRIPE_ID = /^(txn|po|ch|py|re|pyr|ipi|du|dp|ad|tr|trr|iar|fee)_[A-Za-z0-9]{6,}$/;

function stripeIdShare(rows, h, idx) {
  let n = 0; let hit = 0;
  for (let r = h + 1; r < Math.min(rows.length, h + 41); r++) {
    const v = (rows[r][idx] || '').trim();
    if (!v) continue;
    n++;
    if (STRIPE_ID.test(v)) hit++;
  }
  return n ? hit / n : 0;
}

// Only Stripe-specific evidence counts: Stripe-only column names or Stripe
// object ids (txn_, po_, ch_...). A generic ID/Created/Type/Amount/Fee/Net
// export must fall through to the generic bank parser.
function layout(rows) {
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const map = columnMap(rows[i]);
    if (map.has('balance_transaction_id') && map.has('net') && (map.has('reporting_category') || stripeIdShare(rows, i, map.get('balance_transaction_id')) >= 0.5)) return { kind: 'report', h: i, map };
    if (map.has('id') && map.has('type') && map.has('amount') && map.has('net') && (map.has('created (utc)') || map.has('created'))) {
      const stripeHeader = map.has('available on (utc)') || map.has('customer facing amount') || map.has('transfer group') || map.has('destination platform fee');
      if (stripeHeader || stripeIdShare(rows, i, map.get('id')) >= 0.5) return { kind: 'legacy', h: i, map };
    }
    if (map.has('id') && map.has('amount') && (map.has('arrival date (utc)') || map.has('arrival date')) && stripeIdShare(rows, i, map.get('id')) >= 0.5) return { kind: 'payoutlist', h: i, map };
  }
  return null;
}

export function detect(rows, which) {
  const l = layout(rows);
  if (!l) return { score: 0 };
  const payoutish = l.kind === 'payoutlist' || l.map.has('automatic_payout_id') || l.map.has('payout_id') || l.map.has('payout_status');
  const wantPayouts = which === 'stripe-payouts';
  if (payoutish !== wantPayouts) return { score: 0.6, reason: 'Stripe export' };
  const score = l.kind === 'payoutlist' ? 0.75 : 0.97;
  const reason = l.kind === 'legacy' ? 'Found Stripe balance history columns (id, Type, Source, Amount, Fee, Net, Created (UTC)).'
    : l.kind === 'payoutlist' ? 'Found Stripe payouts list columns (id, Amount, Arrival Date).'
      : wantPayouts ? 'Found Stripe payout report columns (balance_transaction_id, reporting_category, payout id).'
        : 'Found Stripe balance report columns (balance_transaction_id, reporting_category, gross, fee, net).';
  return { score, reason };
}

// Balance transaction "type" (legacy export) to reporting category.
const TYPE_TO_CATEGORY = {
  charge: 'charge', payment: 'charge', refund: 'refund', payment_refund: 'refund', payout: 'payout',
  payout_cancel: 'payout_reversal', payout_failure: 'payout_reversal', transfer: 'transfer', stripe_fee: 'fee',
  application_fee: 'platform_earning', application_fee_refund: 'platform_earning_refund', adjustment: 'other_adjustment',
  reserved_funds: 'risk_reserved_funds', reserve_transaction: 'connect_reserved_funds', topup: 'topup', tax_fee: 'tax',
  payment_failure_refund: 'charge_failure', validation: 'charge',
};

function categoryToType(cat) {
  if (cat === 'charge' || cat === 'platform_earning') return 'payment';
  if (cat === 'refund' || cat === 'partial_capture_reversal' || cat === 'dispute' || cat === 'dispute_reversal' || cat === 'refund_failure' || cat === 'platform_earning_refund' || cat === 'charge_failure') return 'refund';
  if (cat === 'payout' || cat === 'payout_reversal') return 'payout';
  if (cat === 'fee' || cat === 'tax' || cat === 'stripe_balance_payment_debit') return 'fee';
  // Top-ups move the user's own money from their bank. Connect "transfer"
  // rows send money to other (connected) accounts, so they are not transfers
  // to the user's bank and stay "other".
  if (cat === 'topup' || cat === 'topup_reversal') return 'transfer';
  return 'other';
}

const LABEL = {
  charge: 'Charge', refund: 'Refund', payout: 'Payout', payout_reversal: 'Payout reversal', fee: 'Stripe fee',
  dispute: 'Dispute', dispute_reversal: 'Dispute won', transfer: 'Transfer', tax: 'Tax on Stripe fees',
  risk_reserved_funds: 'Reserved funds', other_adjustment: 'Adjustment', refund_failure: 'Refund failed',
};

export function parse(rows, options = {}, warnings = []) {
  const l = layout(rows);
  if (!l) fail('WRONG_SOURCE', "This doesn't look like a Stripe export: we couldn't find the gross, fee and net columns. In Stripe open Reports > Balance (or Payout reconciliation), choose Download, pick Itemized and CSV.");
  const header = rows[l.h];
  const map = l.map;
  const g = (...names) => pick(map, ...names);
  let c;
  if (l.kind === 'report') {
    c = {
      id: g('balance_transaction_id'), created: g('created', 'effective_at'), createdUtc: g('created_utc', 'effective_at_utc'),
      currency: g('currency'), gross: g('gross'), fee: g('fee'), net: g('net'), category: g('reporting_category'),
      description: g('description'), payout: g('automatic_payout_id', 'payout_id'), payoutDate: g('automatic_payout_effective_at', 'automatic_payout_effective_at_utc', 'payout_expected_arrival_date'),
      customer: g('customer_name', 'customer_email', 'customer_description'), source: g('source_id', 'charge_id'),
      status: g('payout_status'),
    };
  } else if (l.kind === 'legacy') {
    c = {
      id: g('id'), created: g('created'), createdUtc: g('created (utc)'), currency: g('currency'), gross: g('amount'), fee: g('fee'), net: g('net'),
      type: g('type'), description: g('description'), payout: g('transfer'), source: g('source'), payoutDate: g('transfer date (utc)', 'transfer date'),
      customer: g('customer email', 'customer description', 'customeremail (metadata)'),
    };
  } else {
    c = {
      id: g('id'), created: g('arrival date (utc)', 'arrival date'), createdUtc: -1, currency: g('currency'), gross: g('amount'),
      description: g('description'), status: g('status'), fee: -1, net: -1,
    };
  }
  const data = rows.slice(l.h + 1).filter((r) => !r.every((v) => v.trim() === ''));
  const decimal = resolveDecimal(data.flatMap((r) => [cell(r, c.gross), cell(r, c.fee), cell(r, c.net)]), options, warnings, 'this Stripe file', '.');
  const tzMeta = {};
  // Columns without _utc are already in the time zone chosen at export time.
  const usesUtc = c.createdUtc >= 0 && data.some((r) => !cell(r, c.created) && cell(r, c.createdUtc));
  const utcDate = usesUtc ? utcDateReader(options, warnings, tzMeta, 'Stripe', data.map((r) => cell(r, c.createdUtc))) : null;
  const localVals = c.created >= 0 ? data.map((r) => cell(r, c.created)).filter((v) => v && !/^\d{4}-\d{2}-\d{2}/.test(v)) : [];
  const localOrder = localVals.length ? resolveDateOrder(localVals, options, warnings, 'this Stripe file', { order: 'mdy', reason: 'Stripe exports and US spreadsheets write month/day/year' }) : 'mdy';
  if (!usesUtc) tzMeta.timeZone = l.kind === 'payoutlist' ? 'dates only' : 'as exported (time zone chosen in Stripe)';
  const txns = [];
  let read = 0;
  let skipped = 0;
  let mismatch = 0;
  let unclearPayoutFees = 0;
  for (const row of data) {
    read++;
    const local = cell(row, c.created);
    const dateRaw = local || cell(row, c.createdUtc);
    const date = local ? parseDate(local, localOrder) : utcDate ? utcDate(dateRaw) : parseDate(dateRaw, localOrder);
    if (!date) { skipped++; warnings.push(`Skipped a Stripe row with an unreadable date "${dateRaw}".`); continue; }
    let category;
    if (l.kind === 'report') category = cell(row, c.category).toLowerCase() || 'charge';
    else if (l.kind === 'legacy') { const ty = cell(row, c.type).toLowerCase(); category = TYPE_TO_CATEGORY[ty] || ty || 'other'; if (ty === 'adjustment' && /dispute|chargeback/i.test(cell(row, c.description))) category = 'dispute'; }
    else category = 'payout';
    if (l.kind === 'payoutlist' && c.status >= 0 && /fail|cancel/i.test(cell(row, c.status))) { skipped++; continue; }
    // Reports list a failed payout as a payout row plus a payout_reversal row;
    // both are kept so they cancel out, exactly as they did in the balance.
    let gross = parseMoney(cell(row, c.gross), decimal);
    let fee = c.fee >= 0 ? parseMoney(cell(row, c.fee), decimal) : 0;
    let net = c.net >= 0 ? parseMoney(cell(row, c.net), decimal) : null;
    if (fee === null || Number.isNaN(fee)) fee = 0;
    if (net === null || Number.isNaN(net)) net = gross === null || Number.isNaN(gross) ? null : gross - fee;
    if (gross === null || Number.isNaN(gross)) gross = net === null ? null : net + fee;
    if (net === null) { skipped++; warnings.push(`Skipped a Stripe row dated ${dateRaw}: unreadable amount.`); continue; }
    if (gross - fee !== net) mismatch++;
    // Payout sign differs between exports; force it from the category.
    // A payout fee (instant payouts) is kept: the bank receives the gross,
    // the balance drops by gross plus fee.
    let payoutFee = 0;
    if (category === 'payout') {
      if (gross < 0 && fee !== 0 && gross - fee === net) { payoutFee = fee; }
      else {
        if (fee !== 0) unclearPayoutFees++;
        net = -Math.abs(net); gross = net; fee = 0;
      }
    }
    if (category === 'payout_reversal') { net = Math.abs(net); gross = Math.abs(gross); fee = 0; }
    if (net === 0 && gross === 0) { skipped++; continue; }
    const id = cell(row, c.id);
    const desc = cleanText(cell(row, c.description));
    const customer = cleanText(cell(row, c.customer));
    const label = LABEL[category] || category.replace(/_/g, ' ');
    const description = [label, customer, desc && desc !== label ? desc : ''].filter(Boolean).join(' - ');
    let payoutId = cell(row, c.payout);
    if (category === 'payout' && !payoutId && id.startsWith('po_')) payoutId = id;
    if (category === 'payout' && l.kind === 'legacy' && !payoutId) payoutId = cell(row, c.source);
    const type = categoryToType(category);
    const t = {
      date, description, amountCents: net, currency: cell(row, c.currency) || 'USD', id: id || undefined,
      type, counterparty: customer || undefined, payoutId: payoutId || undefined, raw: rawObject(header, row),
    };
    if (payoutId && c.payoutDate >= 0) { const pd = parseDate(cell(row, c.payoutDate), 'mdy'); if (pd) t.payoutDate = pd; }
    if (type === 'refund') t.refundSide = 'sale'; // Stripe refunds and disputes are always on the user's sales
    if (type === 'transfer') t.transferAccount = 'bank'; // top-ups come from the user's bank
    if (type === 'payout' && payoutFee) { t.grossCents = gross; t.feeCents = payoutFee; t.netCents = net; }
    else if (type !== 'payout' && (fee !== 0 || gross !== net)) { t.grossCents = gross; t.feeCents = fee; t.netCents = net; }
    else if (type === 'payment' || type === 'refund') { t.grossCents = gross; t.feeCents = fee; t.netCents = net; }
    txns.push(makeTxn(t));
  }
  if (unclearPayoutFees) warnings.push(`${unclearPayoutFees} Stripe payout row(s) show a fee but their signs do not say whether the fee was added to or taken from the payout, so the net column was used as the amount that reached your bank. Check those payouts against your bank statement.`);
  if (mismatch) warnings.push(`${mismatch} Stripe row(s) where gross minus fee does not equal net; we used the net column as the amount.`);
  if (l.kind === 'payoutlist') warnings.push('This looks like the Stripe Payouts list export. Its column layout is not documented by Stripe, so we read it on a best-effort basis; the itemized Payout reconciliation report is more reliable.');
  if (l.kind === 'report' && !map.has('automatic_payout_id') && !map.has('payout_id')) {
    // Not an error, just helpful.
  }
  const desc = txns.length > 1 && txns[0].date > txns[txns.length - 1].date;
  const sorted = sortByDate(desc ? txns.reverse() : txns);
  const extra = { ...tzMeta, stripeLayout: l.kind === 'report' ? 'itemized-report' : l.kind === 'legacy' ? 'balance-history' : 'payouts-list' };
  return { transactions: sorted, warnings, meta: finishMeta(sorted, read, skipped, extra) };
}

export { norm };
