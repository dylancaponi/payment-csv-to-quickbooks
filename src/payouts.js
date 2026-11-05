// Payout summaries: break platform activity into gross sales, refunds, fees,
// taxes, payments the user sent, adjustments, and money moved to or from the
// user's own bank, per payout (or per month). These rows drive the
// journal-entry target.
import { fail } from './errors.js';
import { toCents, fromCents } from './money.js';
import { lastDayOfMonth } from './dates.js';

export const NO_PAYOUT_KEY = '(not yet paid out)';

const BUCKETS = ['sales', 'tips', 'giftCards', 'refunds', 'fees', 'taxes', 'adjustments', 'paymentsSent', 'transfersOut', 'transfersIn', 'fundingOut', 'fundingIn', 'payouts'];

// Split one Txn into signed cent components (platform balance view; the sum
// of components equals amount).
//  payout   -> payouts       (money swept to the user's bank by the platform)
//  transfer -> transfersOut / transfersIn (money the user moved to / from their own bank)
//  payment received (amount > 0) -> sales (gross) and fees
//  payment sent (amount < 0)     -> paymentsSent (gross) and fees; never negative sales
//  refund given (amount < 0)     -> refunds (gross) and fees
//  refund received (amount > 0)  -> paymentsSent (money back for something the user paid)
//  fee -> fees, other -> adjustments; marketplace tax portion -> taxes
export function components(t) {
  const amount = toCents(t.amount);
  const out = {};
  for (const b of BUCKETS) out[b] = 0;
  const gross = toCents(t.gross);
  const fee = toCents(t.fee);
  const hasSplit = gross !== null && !Number.isNaN(gross) && fee !== null && !Number.isNaN(fee) && gross - fee === amount;
  if (t.type === 'payout' || t.type === 'transfer') {
    // Only the gross part reaches (or comes from) the other account; a fee
    // on the move is an expense (Cash App instant cash out, Venmo instant
    // transfer, Stripe instant payout).
    const moved = hasSplit ? gross : amount;
    if (hasSplit) out.fees = -fee;
    if (t.type === 'payout') out.payouts = moved;
    else {
      const card = t.transferAccount === 'card';
      if (moved < 0) out[card ? 'fundingOut' : 'transfersOut'] = moved;
      else out[card ? 'fundingIn' : 'transfersIn'] = moved;
    }
    return out;
  }
  const tax = toCents(t.tax) || 0;
  const rest = amount - tax;
  out.taxes = tax;
  let bucket = null;
  if (t.type === 'payment') bucket = amount >= 0 ? 'sales' : 'paymentsSent';
  else if (t.type === 'refund') {
    // refundSide 'sale': refunds, chargebacks and won chargebacks on sales
    // (both signs); 'purchase': money back for something the user paid.
    if (t.refundSide === 'sale') bucket = 'refunds';
    else if (t.refundSide === 'purchase') bucket = 'paymentsSent';
    else bucket = amount <= 0 ? 'refunds' : 'paymentsSent';
  }
  if (bucket) {
    if (hasSplit) { out[bucket] = gross; out.fees = -fee - tax; }
    else out[bucket] = rest;
    // Tips and gift card sales collected with a sale (Square) are not sales
    // revenue: they get their own buckets, carved out of the sale.
    // A refund of such a sale (negative tips / gift card sales) is split the
    // same way, so the tip comes back out of the tips account, not sales.
    const tips = toCents(t.tips) || 0;
    const gc = toCents(t.giftCardSales) || 0;
    if (bucket === 'sales') {
      if ((tips || gc) && tips >= 0 && gc >= 0 && tips + gc <= out.sales) { out.sales -= tips + gc; out.tips = tips; out.giftCards = gc; }
    } else if (bucket === 'refunds') {
      if ((tips || gc) && tips <= 0 && gc <= 0 && tips + gc >= out.refunds) { out.refunds -= tips + gc; out.tips = tips; out.giftCards = gc; }
    }
  } else if (t.type === 'fee') {
    out.fees = rest;
  } else {
    out.adjustments = rest;
  }
  return out;
}

// summarizePayouts(transactions, { groupBy: 'payout' | 'month' })
// Returns rows (numbers in major units):
// { key, groupBy, date, currency, transactionCount, grossSales, refunds, fees,
//   taxes, adjustments, paymentsSent, netActivity, transfersToBank,
//   transfersFromBank, fundingToCard, fundingFromCard, payoutAmount, hasPayoutRow, mixedCurrencyPayout, difference, from, to }
// netActivity = grossSales + refunds + fees + taxes + adjustments + paymentsSent
// transfersToBank / transfersFromBank: money the user moved to / from their
// own bank (both positive); fundingToCard / fundingFromCard: the same for a
// card or other funding source that is not recognisably the user's bank
// payoutAmount: money the platform paid out to the bank
// difference = netActivity - payoutAmount - transfersToBank + transfersFromBank
//   - fundingToCard + fundingFromCard: money that stayed
// in (positive) or came out of (negative) the platform balance.
export function summarizePayouts(transactions, options = {}) {
  const groupBy = options.groupBy || 'payout';
  if (groupBy !== 'payout' && groupBy !== 'month') fail('BAD_OPTION', 'groupBy must be "payout" or "month".');
  if (!Array.isArray(transactions) || !transactions.length) fail('NO_TRANSACTIONS', 'There are no transactions to summarize.');
  if (groupBy === 'payout' && !transactions.some((t) => t.payoutId)) {
    fail('NO_PAYOUT_IDS', "This file doesn't say which transactions belong to which payout, so we can't build one entry per payout. Choose \"group by month\" instead.");
  }
  const groups = new Map();
  const currenciesByKey = new Map();
  for (const t of transactions) {
    const currency = (t.currency || 'USD').toUpperCase();
    const k = groupBy === 'month' ? t.date.slice(0, 7) : t.payoutId || NO_PAYOUT_KEY;
    const gk = `${k}|${currency}`;
    if (!groups.has(gk)) groups.set(gk, { key: k, currency, txns: [] });
    groups.get(gk).txns.push(t);
    if (!currenciesByKey.has(k)) currenciesByKey.set(k, new Map());
    const cm = currenciesByKey.get(k);
    cm.set(currency, (cm.get(currency) || 0) + 1);
  }
  const rows = [];
  for (const g of groups.values()) {
    const sum = {};
    for (const b of BUCKETS) sum[b] = 0;
    let from = null; let to = null; let payoutDate = null; let payoutRows = 0; let declared = null;
    for (const t of g.txns) {
      const c = components(t);
      for (const b of BUCKETS) sum[b] += c[b];
      if (!from || t.date < from) from = t.date;
      if (!to || t.date > to) to = t.date;
      if (t.type === 'payout') { payoutRows++; if (!payoutDate || t.date > payoutDate) payoutDate = t.date; }
      if (t.payoutDate && (!declared || t.payoutDate > declared)) declared = t.payoutDate;
    }
    const net = sum.sales + sum.tips + sum.giftCards + sum.refunds + sum.fees + sum.taxes + sum.adjustments + sum.paymentsSent;
    const outToBank = -sum.transfersOut;
    const inFromBank = sum.transfersIn;
    const outToCard = -sum.fundingOut;
    const inFromCard = sum.fundingIn;
    const toBank = outToBank - inFromBank + outToCard - inFromCard; // all money moved out, net
    // A payout id seen in more than one currency: only the main currency's
    // part is a deposit we can vouch for; the rest goes to clearing.
    const cm = currenciesByKey.get(g.key);
    let mainCurrency = g.currency;
    if (cm.size > 1) mainCurrency = [...cm.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
    const mixed = groupBy === 'payout' && g.key !== NO_PAYOUT_KEY && cm.size > 1;
    let payout;
    if (payoutRows) payout = -sum.payouts;
    else if (groupBy === 'payout' && g.key !== NO_PAYOUT_KEY && (!mixed || g.currency === mainCurrency)) payout = net - toBank; // itemized payout reports list only the parts
    else payout = 0;
    let date;
    if (groupBy === 'month') date = lastDayOfMonth(g.key);
    else date = (g.key !== NO_PAYOUT_KEY && declared) || payoutDate || to;
    rows.push({
      key: g.key, groupBy, date, currency: g.currency, transactionCount: g.txns.filter((t) => t.type !== 'payout').length,
      grossSales: fromCents(sum.sales), tipsCollected: fromCents(sum.tips), giftCardSales: fromCents(sum.giftCards), refunds: fromCents(sum.refunds), fees: fromCents(sum.fees), taxes: fromCents(sum.taxes),
      adjustments: fromCents(sum.adjustments), paymentsSent: fromCents(sum.paymentsSent), netActivity: fromCents(net),
      transfersToBank: fromCents(outToBank), transfersFromBank: fromCents(inFromBank),
      fundingToCard: fromCents(outToCard), fundingFromCard: fromCents(inFromCard), payoutAmount: fromCents(payout), hasPayoutRow: payoutRows > 0,
      mixedCurrencyPayout: mixed, difference: fromCents(net - payout - toBank), from, to,
    });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : a.currency < b.currency ? -1 : 1));
  return rows;
}
