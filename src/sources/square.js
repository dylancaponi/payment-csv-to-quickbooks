// Square transactions CSV (Square Dashboard > Transactions > Export >
// Transactions CSV). One row per payment or refund, newest first, columns
// mapped by name (Square has added columns over the years: 44 in 2020, 50 to
// 54 in 2024-2025, 61 in 2026). Header provenance: FORMATS.md, Square.
//
// Money: "$1,234.56", "-$184.28"; files re-saved in Excel show "($20.00)" and
// M/D/YYYY dates. Fees are negative; Net Total = Total Collected + Fees.
// Dates and times are in the seller's time zone (Time Zone column) and are
// used as written.
//
// Only money that went through Square's balance is a transaction here: card
// and Cash App tenders. Cash, other tenders and Square gift card redemptions
// never reach a Square deposit (engine choice, UNVERIFIED as a written
// statement), so pure cash rows are left out and mixed-tender rows keep only
// their electronic part, each with a warning.
import { fail } from '../errors.js';
import { parseMoney, formatCents } from '../money.js';
import { parseDate } from '../dates.js';
import { resolveDateOrder, resolveDecimal } from '../locale.js';
import { columnMap, pick, cell, cleanText, rawObject, makeTxn, finishMeta, sortByDate, findHeaderRow } from '../util.js';

const REQUIRED = ['Date', 'Time', 'Gross Sales', 'Net Sales', 'Total Collected', 'Fees', 'Net Total', 'Transaction ID'];

function headerIndex(rows) {
  return findHeaderRow(rows, REQUIRED, 5);
}

// Other Square exports that are not money movements. They are refused with a
// pointer to the right file instead of falling through to the bank parser.
export function wrongExport(rows) {
  if (findHeaderRow(rows, ['Item', 'Qty', 'Price Point Name']) >= 0 || findHeaderRow(rows, ['Item', 'Qty', 'Gross Sales', 'Transaction ID']) >= 0) {
    return 'This is a Square item sales export (one row per item sold). It has no fees, deposits or payment totals, so it cannot be turned into bank or journal entries. In the Square Dashboard open Transactions, click Export and choose Transactions CSV, then upload that file.';
  }
  return null;
}

export function detect(rows) {
  const h = headerIndex(rows);
  if (h < 0) return { score: 0 };
  return { score: 0.97, reason: 'Found Square transaction columns (Gross Sales, Net Sales, Total Collected, Net Total).' };
}

let DECIMAL = '.';
const money = (v) => {
  const m = parseMoney(v, DECIMAL);
  return m === null || Number.isNaN(m) ? null : m;
};

export function parse(rows, options = {}, warnings = []) {
  const h = headerIndex(rows);
  if (h < 0) fail('WRONG_SOURCE', "This doesn't look like a Square transactions export: we couldn't find the \"Gross Sales\", \"Total Collected\" and \"Net Total\" columns. In the Square Dashboard open Transactions, click Export and choose Transactions CSV.");
  const header = rows[h];
  const map = columnMap(header);
  const c = {
    date: pick(map, 'Date'), time: pick(map, 'Time'), total: pick(map, 'Total Collected'), fees: pick(map, 'Fees'), net: pick(map, 'Net Total'),
    tax: pick(map, 'Tax'), card: pick(map, 'Card'), cashApp: pick(map, 'Cash App'), cash: pick(map, 'Cash'), giftCard: pick(map, 'Square Gift Card'),
    other: pick(map, 'Other Tender'), tip: pick(map, 'Tip'), giftSales: pick(map, 'Gift Card Sales'), partial: pick(map, 'Partial Refunds'), txnId: pick(map, 'Transaction ID'), paymentId: pick(map, 'Payment ID'), event: pick(map, 'Event Type'),
    status: pick(map, 'Transaction Status'), description: pick(map, 'Description'), customer: pick(map, 'Customer Name'),
    depositId: pick(map, 'Deposit ID'), depositDate: pick(map, 'Deposit Date'), currency: pick(map, 'Currency'),
  };
  const data = rows.slice(h + 1).filter((r) => !r.every((v) => v.trim() === ''));
  DECIMAL = resolveDecimal(data.flatMap((r) => [cell(r, c.total), cell(r, c.fees), cell(r, c.net)]), options, warnings, 'this Square file', '.');
  // Square writes YYYY-MM-DD; the order only matters for files re-saved in a
  // spreadsheet. A decimal comma points to a day-first spreadsheet, so the
  // US month-first default is only used for decimal-point files.
  const reSaved = data.flatMap((r) => [cell(r, c.date), cell(r, c.depositDate)]).filter((v) => /^\d{1,2}[\/.-]/.test(v));
  const dOrder = reSaved.length ? resolveDateOrder(reSaved, options, warnings, 'this Square file', DECIMAL === '.' ? { order: 'mdy', reason: 'Square exports and US spreadsheets write month/day/year' } : null) : 'mdy';
  // The transactions CSV has no currency column; the symbol only settles
  // pounds and euros. "$" is shared by US, Canadian and Australian
  // accounts, so it is read as USD unless the caller says otherwise.
  const sample = data.slice(0, 50).map((r) => cell(r, c.total)).join(' ');
  let currency = cell(data[0] || [], c.currency) || options.currency || (/£/.test(sample) ? 'GBP' : /€/.test(sample) ? 'EUR' : 'USD');
  currency = currency.toUpperCase();
  if (c.currency < 0 && !options.currency && currency === 'USD') warnings.push('This Square file does not say which currency it is in, so the amounts are treated as US dollars. If your Square account is in Canadian or Australian dollars, the currency in the converted file needs changing.');
  const txns = [];
  let read = 0, skipped = 0, zero = 0, notComplete = 0;
  let cashRows = 0, mixedRows = 0, taxCents = 0, undeposited = 0;
  const leftOut = { cash: 0, gift: 0, other: 0 };
  let tipCents = 0, giftSaleCents = 0, tipRefundCents = 0, giftRefundCents = 0, partialRows = 0, partialCents = 0, uncarved = 0;
  for (const row of data) {
    read++;
    const dateRaw = cell(row, c.date);
    const date = parseDate(dateRaw, dOrder);
    if (!date) { skipped++; warnings.push(`Skipped a Square row with an unreadable date "${dateRaw}".`); continue; }
    const status = cell(row, c.status);
    if (status && !/^complete/i.test(status)) { skipped++; notComplete++; continue; }
    const total = money(cell(row, c.total));
    const net = money(cell(row, c.net));
    const feesRaw = money(cell(row, c.fees));
    if (total === null || net === null) { skipped++; warnings.push(`Skipped a Square row dated ${dateRaw}: unreadable amount "${cell(row, c.total)}" / "${cell(row, c.net)}".`); continue; }
    const fees = feesRaw === null ? 0 : feesRaw; // negative = fee paid
    if (total + fees !== net) warnings.push(`The Square row dated ${dateRaw} (transaction ${cell(row, c.txnId) || 'without an id'}) has Total Collected ${formatCents(total)} and Fees ${formatCents(fees)}, which do not add up to its Net Total ${formatCents(net)}; we used the Net Total.`);
    // Electronic part of the tender: what can reach a Square deposit.
    const tenderCols = [c.card, c.cashApp].filter((i) => i >= 0);
    const offCols = [c.cash, c.giftCard, c.other].filter((i) => i >= 0);
    const electronic = tenderCols.reduce((s, i) => s + (money(cell(row, i)) || 0), 0);
    const off = offCols.reduce((s, i) => s + (money(cell(row, i)) || 0), 0);
    let gross = total;
    let netUsed = net;
    let mixed = false;
    if (off !== 0 && tenderCols.length) {
      leftOut.cash += money(cell(row, c.cash)) || 0;
      leftOut.gift += money(cell(row, c.giftCard)) || 0;
      leftOut.other += money(cell(row, c.other)) || 0;
      if (electronic === 0) { skipped++; cashRows++; continue; }
      gross = electronic;
      netUsed = electronic + fees;
      mixedRows++; mixed = true;
    }
    const partial = money(cell(row, c.partial)) || 0;
    if (partial) { partialRows++; partialCents += partial; }
    if (netUsed === 0 && gross === 0) { skipped++; zero++; continue; }
    const event = cell(row, c.event);
    const isRefund = /refund/i.test(event) || (!event && gross < 0);
    const tax = money(cell(row, c.tax)) || 0;
    taxCents += tax;
    const customer = cleanText(cell(row, c.customer));
    const items = cleanText(cell(row, c.description));
    const description = [customer, items].filter(Boolean).join(' - ') || (isRefund ? 'Square refund' : 'Square payment');
    const depositId = cell(row, c.depositId);
    const depositDate = depositId ? parseDate(cell(row, c.depositDate), dOrder) : null;
    if (!depositId) undeposited++;
    const t = {
      date, description, amountCents: netUsed, currency,
      id: cell(row, c.paymentId) || cell(row, c.txnId) || undefined,
      type: isRefund ? 'refund' : 'payment', counterparty: customer || undefined,
      payoutId: depositId || undefined, payoutDate: depositDate || undefined, raw: rawObject(header, row),
    };
    if (isRefund) t.refundSide = 'sale';
    // Tips and gift card sales are collected with the sale but are not sales
    // revenue; the journal books them to their own accounts.
    const tip = money(cell(row, c.tip)) || 0;
    const giftSale = money(cell(row, c.giftSales)) || 0;
    if (!isRefund && (tip > 0 || giftSale > 0)) {
      if (!mixed && tip >= 0 && giftSale >= 0 && tip + giftSale <= gross) {
        if (tip > 0) { t.tipsCents = tip; tipCents += tip; }
        if (giftSale > 0) { t.giftCardSalesCents = giftSale; giftSaleCents += giftSale; }
      } else uncarved++;
    } else if (isRefund && (tip < 0 || giftSale < 0)) {
      // Refunding a tipped sale or a gift card sale: split it the same way.
      if (!mixed && tip <= 0 && giftSale <= 0 && tip + giftSale >= gross) {
        if (tip < 0) { t.tipsCents = tip; tipRefundCents += tip; }
        if (giftSale < 0) { t.giftCardSalesCents = giftSale; giftRefundCents += giftSale; }
      } else uncarved++;
    }
    if (fees !== 0 || gross !== netUsed) { t.grossCents = gross; t.feeCents = gross - netUsed; t.netCents = netUsed; }
    txns.push(makeTxn(t));
  }
  if (notComplete) warnings.push(`Left out ${notComplete} Square row(s) whose Transaction Status is not Complete.`);
  if (zero) warnings.push(`Left out ${zero} Square row(s) with a zero amount.`);
  const offParts = [];
  if (cashRows) offParts.push(cashRows === 1 ? '1 Square sale paid entirely another way is left out' : cashRows + ' Square sales paid entirely another way are left out');
  if (mixedRows) offParts.push(mixedRows === 1 ? '1 sale paid partly another way keeps only its card part' : mixedRows + ' sales paid partly another way keep only their card part');
  if (offParts.length) warnings.push('Only card and Cash App payments pass through your Square balance, so ' + offParts.join(', and ') + '.');
  if (leftOut.cash) warnings.push(`Cash payments left out: ${formatCents(leftOut.cash)}. Cash never reaches a Square deposit; record it with your cash takings.`);
  if (leftOut.gift) warnings.push(`Payments made with Square gift cards left out: ${formatCents(leftOut.gift)}. Do not record this as new cash or income: the money came in when the gift card was sold. When a gift card is spent, move that amount from your gift card liability account to sales.`);
  if (leftOut.other) warnings.push(`Payments by other tenders (such as checks or other gift cards) left out: ${formatCents(leftOut.other)}. They never pass through Square; record them where that money was received.`);
  if (tipCents || giftSaleCents) {
    const what = [];
    if (tipCents) what.push(formatCents(tipCents) + ' of tips');
    if (giftSaleCents) what.push(formatCents(giftSaleCents) + ' of gift card sales');
    const lines = tipCents && giftSaleCents ? 'they get their own lines ("Tips owed to staff" and "Gift card liability")' : tipCents ? 'tips get their own line ("Tips owed to staff")' : 'gift card sales get their own line ("Gift card liability")';
    warnings.push('This file includes ' + what.join(' and ') + '. Neither is sales revenue: in a journal entry ' + lines + '. In bank files they stay part of each payment, because they are part of the money Square deposits.');
  }
  if (tipRefundCents || giftRefundCents) {
    const what = [];
    if (tipRefundCents) what.push(formatCents(-tipRefundCents) + ' of tips');
    if (giftRefundCents) what.push(formatCents(-giftRefundCents) + ' of gift card sales');
    warnings.push('Refunds in this file give back ' + what.join(' and ') + '. In a journal entry that part of each refund comes out of the same tips or gift card account, not out of sales.');
  }
  if (uncarved) warnings.push(`${uncarved} Square sale(s) with tips or gift card sales were also paid partly another way, so their tips or gift card sales could not be separated and stay inside sales. Check those sales.`);
  if (taxCents) warnings.push(`Sales include ${formatCents(taxCents)} of sales tax collected through Square (the Tax column). It is part of the sale amounts here; move it to your sales tax account if you track one.`);
  if (partialRows) warnings.push(`${partialRows} Square payment(s) show a partial refund in the Partial Refunds column (total ${formatCents(partialCents)}). We could not confirm how Square lists partial refunds: the same refund may also appear as its own Refund row. Check that each partial refund is counted only once by comparing the converted total with the matching Square deposit.`);
  if (undeposited && txns.length) warnings.push(`${undeposited} Square row(s) have no Deposit ID yet (not deposited when the file was exported). In a journal entry they go to the clearing account.`);
  const sorted = sortByDate(txns.reverse());
  return { transactions: sorted, warnings, meta: finishMeta(sorted, read, skipped, { timeZone: 'as exported (the Square account time zone shown in the file)' }) };
}
