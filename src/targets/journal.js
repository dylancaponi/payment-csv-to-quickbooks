// QuickBooks Online journal entry import CSV (Settings > Import data >
// Journal entries). One balanced entry per payout or per month:
//   Credit sales               gross sales (money received for sales only)
//   Debit  refunds             refunds given to buyers
//   Debit  fees                processing and platform fees
//   Debit  payments sent       money the user paid out to other people
//   +/-    taxes, adjustments  as signed
//   Debit  bank account        payout deposit
//   Debit  bank / Credit clearing  money the user moved from the platform to
//                              their own bank (reversed for money moved in):
//                              a transfer, never income or expense
//   +/-    clearing account    activity not yet paid out (or paid from an earlier balance)
import { fail } from '../errors.js';
import { formatCents, toCents } from '../money.js';
import { formatDate, DATE_FORMATS } from '../dates.js';
import { writeCSV } from '../csv.js';
import { summarizePayouts, NO_PAYOUT_KEY } from '../payouts.js';
import { validateTxns, asciiText, truncate, slug, csvSafe } from './common.js';

const VENDOR = { venmo: 'Venmo', cashapp: 'Cash App', paypal: 'PayPal', 'stripe-balance': 'Stripe', 'stripe-payouts': 'Stripe', etsy: 'Etsy', airbnb: 'Airbnb', gumroad: 'Gumroad', square: 'Square', 'shopify-transactions': 'Shopify', 'shopify-payouts': 'Shopify', wise: 'Wise', 'amazon-settlement': 'Amazon', ebay: 'eBay', 'gusto-payroll': 'Gusto', mt940: 'Bank', camt053: 'Bank', 'generic-bank': 'Bank' };

export const DEFAULT_ACCOUNTS = {
  bank: 'Checking',
  sales: 'Sales of Product Income',
  tips: 'Tips owed to staff',
  giftCards: 'Gift card liability',
  refunds: 'Sales of Product Income',
  fees: 'Bank Charges & Fees',
  taxes: 'Sales of Product Income',
  adjustmentsIncome: 'Uncategorized Income',
  adjustmentsExpense: 'Uncategorized Expense',
  clearing: 'Uncategorized Asset',
  paymentsSent: 'Payments sent (uncategorized expense)',
  fundingCard: 'Credit card or other funding source',
  transfers: null, // defaults to the bank account
  // Named lines some sources add (Amazon settlements). null = use the
  // account in brackets: advertising (fees), fulfillmentFees (fees),
  // reserve (clearing: money the marketplace holds back is still yours).
  advertising: null,
  fulfillmentFees: null,
  reserve: null,
  // Sales tax or VAT the marketplace did not withhold (Amazon): owed by the
  // seller. null = "Sales Tax / VAT Payable", or the taxes account when
  // the caller set one.
  taxesPayable: null,
  // Payroll lines (Gusto Payroll Journal Report). Expenses: wages,
  // payrollTaxExpense, benefitsExpense, reimbursements. Liabilities:
  // payrollTaxesPayable (employee taxes withheld and employer taxes owed),
  // payrollDeductions (employee deductions and employer contributions owed).
  wages: 'Payroll Expenses:Wages',
  payrollTaxExpense: 'Payroll Expenses:Taxes',
  benefitsExpense: 'Payroll Expenses:Benefits',
  reimbursements: 'Employee Reimbursements',
  payrollTaxesPayable: 'Payroll Liabilities:Taxes',
  payrollDeductions: 'Payroll Liabilities:Deductions',
};

// Account keys a transaction may name in Txn.journalAccount.
export const LINE_ACCOUNT_KEYS = ['sales', 'refunds', 'fees', 'taxes', 'clearing', 'adjustmentsIncome', 'adjustmentsExpense', 'advertising', 'fulfillmentFees', 'reserve', 'taxesPayable', 'wages', 'payrollTaxExpense', 'benefitsExpense', 'reimbursements', 'payrollTaxesPayable', 'payrollDeductions'];

const ACCOUNT_KEYS = Object.keys(DEFAULT_ACCOUNTS);

export const JOURNAL_HEADER = ['Journal No.', 'Journal Date', 'Account Name', 'Debits', 'Credits', 'Description', 'Name'];
export const QBO_JOURNAL_MAX_LINES = 1000;

export function journalLines(rows, options = {}) {
  if (options.accounts !== undefined && (options.accounts === null || typeof options.accounts !== 'object')) fail('BAD_OPTION', 'The accounts option must be an object of account names.');
  const acct = { ...DEFAULT_ACCOUNTS };
  for (const [k, v] of Object.entries(options.accounts || {})) {
    if (!ACCOUNT_KEYS.includes(k)) fail('BAD_OPTION', `Unknown account "${k}". Use one of: ${ACCOUNT_KEYS.join(', ')}.`);
    if (v !== null && (typeof v !== 'string' || !v.trim())) fail('BAD_OPTION', `The account name for "${k}" must be text.`);
    acct[k] = v;
  }
  if (!acct.transfers) acct.transfers = acct.bank;
  if (!acct.advertising) acct.advertising = acct.fees;
  if (!acct.fulfillmentFees) acct.fulfillmentFees = acct.fees;
  if (!acct.reserve) acct.reserve = acct.clearing;
  if (!acct.taxesPayable) acct.taxesPayable = (options.accounts && options.accounts.taxes) || 'Sales Tax / VAT Payable';
  if (options.journalPrefix !== undefined && typeof options.journalPrefix !== 'string') fail('BAD_OPTION', 'The journalPrefix option must be text.');
  const label = options.vendorName || VENDOR[options.sourceId] || 'Platform';
  const prefix = (options.journalPrefix || 'BI').replace(/[^A-Za-z0-9]/g, '').slice(0, 6) || 'BI';
  const entries = [];
  const used = new Map();
  for (const r of rows) {
    const base = `${prefix}-${r.date.replace(/-/g, '')}`;
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    const no = `${base}-${n}`.slice(0, 21);
    const payroll = !!options._payroll;
    const what = payroll ? (r.groupBy === 'month' ? `${label} payrolls ${r.key}` : `${label} payroll ${r.key}`) : r.groupBy === 'month' ? `${label} activity ${r.key}` : r.key === NO_PAYOUT_KEY ? `${label} activity not yet paid out` : `${label} payout ${r.key}`;
    const lines = [];
    // Signed: positive = credit, negative = debit (from the platform balance's view).
    const add = (account, cents, desc) => {
      if (!cents) return;
      lines.push({ account, debit: cents < 0 ? -cents : 0, credit: cents > 0 ? cents : 0, desc: `${desc} - ${what}` });
    };
    // Parts of a bucket that a source gave their own named line (only
    // Amazon settlements so far); the bucket line keeps the rest.
    const details = Array.isArray(r.details) ? r.details : [];
    const named = (bucket) => details.filter((d) => d.bucket === bucket).reduce((s, d) => s + toCents(d.amount), 0);
    add(acct.sales, toCents(r.grossSales) - named('sales'), 'Gross sales');
    add(acct.tips, toCents(r.tipsCollected) - named('tips'), 'Tips collected (not sales)');
    add(acct.giftCards, toCents(r.giftCardSales) - named('giftCards'), 'Gift cards sold (owed until redeemed)');
    add(acct.refunds, toCents(r.refunds) - named('refunds'), 'Refunds');
    add(acct.fees, toCents(r.fees) - named('fees'), 'Fees');
    add(acct.taxes, toCents(r.taxes) - named('taxes'), 'Sales tax collected by marketplace');
    const adj = toCents(r.adjustments) - named('adjustments');
    add(adj >= 0 ? acct.adjustmentsIncome : acct.adjustmentsExpense, adj, 'Adjustments');
    const sent = toCents(r.paymentsSent) - named('paymentsSent');
    add(acct.paymentsSent, sent, sent < 0 ? 'Payments sent' : 'Refunds received for payments sent');
    const BUCKET_ACCOUNT = { sales: 'sales', tips: 'tips', giftCards: 'giftCards', refunds: 'refunds', fees: 'fees', taxes: 'taxes', paymentsSent: 'paymentsSent' };
    for (const d of details) {
      const cents = toCents(d.amount);
      let key = d.account || BUCKET_ACCOUNT[d.bucket];
      if (!key) key = cents >= 0 ? 'adjustmentsIncome' : 'adjustmentsExpense';
      if (!Object.prototype.hasOwnProperty.call(acct, key) || !acct[key]) fail('BAD_TXN', `A transaction names the journal account "${String(d.account)}", which is not one of: ${LINE_ACCOUNT_KEYS.join(', ')}.`);
      add(acct[key], cents, String(d.label));
    }
    const payout = toCents(r.payoutAmount);
    const toBank = toCents(r.transfersToBank);
    const fromBank = toCents(r.transfersFromBank);
    // Assets (bank, clearing) are debited when they grow: negate.
    // A negative settlement total (named-line sources only, so other
    // sources keep their exact text) is a charge, not a deposit.
    add(acct.bank, -payout, payroll ? 'Net pay paid to employees (Check Amount)' : payout < 0 && details.length ? `Charged by ${label}` : 'Deposit');
    // Own-money transfers: bank against the platform clearing account.
    if (toBank) {
      add(acct.transfers, -toBank, `Transfer from ${label} to bank`);
      add(acct.clearing, toBank, `Transfer from ${label} to bank`);
    }
    if (fromBank) {
      add(acct.clearing, -fromBank, `Transfer from bank to ${label}`);
      add(acct.transfers, fromBank, `Transfer from bank to ${label}`);
    }
    const toCard = toCents(r.fundingToCard);
    const fromCard = toCents(r.fundingFromCard);
    // Card or other non-bank funding: its own account, never the bank.
    if (toCard) {
      add(acct.fundingCard, -toCard, `Paid to card or other funding source from ${label}`);
      add(acct.clearing, toCard, `Paid to card or other funding source from ${label}`);
    }
    if (fromCard) {
      add(acct.clearing, -fromCard, `Funded by card or other source into ${label}`);
      add(acct.fundingCard, fromCard, `Funded by card or other source into ${label}`);
    }
    const diff = toCents(r.difference) + toBank - fromBank + toCard - fromCard; // clearing change from activity and payouts
    add(acct.clearing, -diff, payroll ? 'Gap between the payroll lines and the Check Amount total' : diff > 0 ? `Kept in ${label} balance` : r.key === NO_PAYOUT_KEY ? `Taken from ${label} balance` : `Paid from earlier ${label} balance`);
    let dr = 0; let cr = 0;
    for (const l of lines) { dr += l.debit; cr += l.credit; }
    if (dr !== cr) fail('UNBALANCED', `Internal check failed: entry ${no} does not balance (${formatCents(dr)} vs ${formatCents(cr)}). Please report this file.`);
    if (lines.length) entries.push({ no, date: r.date, lines, currency: r.currency });
  }
  return entries;
}

// Gusto payroll journal transactions (source id or the raw marker).
export function isPayroll(transactions, options = {}) {
  return options.sourceId === 'gusto-payroll' || transactions.some((t) => t && t.raw && Object.prototype.hasOwnProperty.call(t.raw, 'Gusto payroll'));
}

export function writeJournal(transactions, options = {}) {
  const warnings = [];
  transactions = validateTxns(transactions);
  // A Wise statement does not say which incoming money is sales, owner
  // top-ups, loans or refunds, and conversions move money between your own
  // balances, so a journal built from it would put money in the wrong
  // accounts. Only bank-feed files are offered for Wise.
  if (options.sourceId === 'wise' || transactions.some((t) => t.raw && Object.keys(t.raw).some((k) => /^(transferwise|wise) id$/i.test(k.trim())))) {
    fail('NOT_SUPPORTED', 'Journal entries are not available for Wise statements: the statement does not say which money coming in is sales and which is your own money, a loan or a refund, so the entries would be wrong. Choose a bank file instead (QuickBooks .qbo, QuickBooks Online CSV, Xero CSV, Quicken .qfx or OFX) and categorize each transaction in your accounting software.');
  }
  // Bank statements (MT940, camt.053) say nothing about which money is
  // sales, so they get the same refusal as Wise.
  if (options.sourceId === 'mt940' || options.sourceId === 'camt053' || transactions.some((t) => t.raw && (Object.prototype.hasOwnProperty.call(t.raw, 'MT940 :61:') || Object.prototype.hasOwnProperty.call(t.raw, 'camt.053 entry')))) {
    fail('NOT_SUPPORTED', 'Journal entries are not available for bank statements (MT940 or camt.053): a statement does not say which money coming in is sales and which is a transfer, a loan or a refund, so the entries would be wrong. Choose a bank file instead (QuickBooks .qbo, QuickBooks Online CSV, Xero CSV, OFX or a spreadsheet CSV) and categorize each transaction in your accounting software.');
  }
  const payroll = isPayroll(transactions, options);
  const groupBy = options.groupBy || (transactions.some((t) => t.payoutId) ? 'payout' : 'month');
  let rows = summarizePayouts(transactions, { groupBy });
  if (options.currency !== undefined && options.currency !== null && !/^[A-Za-z]{3}$/.test(String(options.currency))) fail('BAD_OPTION', 'The currency option must be a 3-letter code such as USD.');
  const counts = new Map();
  for (const t of transactions) counts.set(t.currency, (counts.get(t.currency) || 0) + 1);
  const chosen = options.currency ? String(options.currency).toUpperCase() : [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  if (!counts.has(chosen)) fail('NO_TRANSACTIONS', `You asked for a ${chosen} journal, but none of the transactions are in ${chosen} (they are in ${[...counts.keys()].sort().join(', ')}).`);
  const dropped = rows.filter((r) => r.currency !== chosen).length;
  rows = rows.filter((r) => r.currency === chosen);
  if (dropped) warnings.push(`Left out ${dropped} entr(ies) in other currencies: one journal file is written per currency, and this one is ${chosen}.`);
  if (rows.some((r) => r.mixedCurrencyPayout)) warnings.push('Some payouts contain transactions in more than one currency. Only the main currency counts toward the bank deposit; the other currency\'s part is booked to the clearing account. Check those payouts in your platform.');
  const entries = journalLines(rows, { ...options, _payroll: payroll });
  const fmt = options.dateFormat || 'MM/DD/YYYY';
  if (!DATE_FORMATS.includes(fmt)) fail('BAD_OPTION', `Unsupported date format "${String(fmt)}". Use one of: ${DATE_FORMATS.join(', ')}.`);
  if (options.includeFeesAsSeparateRows) warnings.push('includeFeesAsSeparateRows does not apply to journal entries (fees always get their own line) and was ignored.');
  const flat = [];
  for (const e of entries) for (const l of e.lines) flat.push({ e, l });
  const toRow = ({ e, l }) => [e.no, formatDate(e.date, fmt), csvSafe(asciiText(l.account)), l.debit ? formatCents(l.debit) : '', l.credit ? formatCents(l.credit) : '', csvSafe(truncate(asciiText(l.desc), 4000)), ''];
  const render = (chunk) => writeCSV([JOURNAL_HEADER, ...chunk.map(toRow)]);
  const content = render(flat);
  const pending = rows.find((r) => r.key === NO_PAYOUT_KEY);
  if (pending) warnings.push(`Some transactions are not part of any payout yet; they are booked to "${(options.accounts && options.accounts.clearing) || DEFAULT_ACCOUNTS.clearing}" until they are paid out.`);
  const offs = rows.filter((r) => r.hasPayoutRow && r.difference !== 0 && r.groupBy === 'payout');
  if (offs.length && payroll) warnings.push(`${offs.length} payroll(s) do not add up to the report's Check Amount total; the difference is booked to the clearing account so each entry still balances. Check those payrolls.`);
  else if (offs.length) warnings.push(`${offs.length} payout(s) do not equal the activity listed with them; the difference is booked to the clearing account so each entry still balances. Check those payouts.`);
  if (rows.some((r) => r.fundingToCard || r.fundingFromCard)) warnings.push(`Some payments were funded by (or paid to) a card or another source that is not recognisably your bank. They are booked to "${(options.accounts && options.accounts.fundingCard) || DEFAULT_ACCOUNTS.fundingCard}", not your bank account. Point that at the right credit card account in the options.`);
  if (rows.some((r) => r.paymentsSent)) warnings.push(`Money you sent to other people is booked to "${(options.accounts && options.accounts.paymentsSent) || DEFAULT_ACCOUNTS.paymentsSent}", not deducted from sales. Recategorize it in QuickBooks, or set the account name in the options.`);
  if (rows.some((r) => r.tipsCollected)) warnings.push(`Tips collected with sales are booked to "${(options.accounts && options.accounts.tips) || DEFAULT_ACCOUNTS.tips}", not to sales, because they are owed to staff. Point that at your tips or payroll liability account in the options.`);
  if (rows.some((r) => r.giftCardSales)) warnings.push(`Gift cards you sold are booked to "${(options.accounts && options.accounts.giftCards) || DEFAULT_ACCOUNTS.giftCards}", not to sales: the money is owed to the card holder until the card is spent. When a card is redeemed, move that amount from the gift card account to sales.`);
  warnings.push('Every account name in this file must already exist in your QuickBooks chart of accounts (use "Parent:Sub" for subaccounts). Change the account names in the options to match yours before downloading.');
  const res = { filename: `${slug(options.filenameBase || options.sourceId || 'payouts')}-journal-${groupBy}-${rows[0].date}-to-${rows[rows.length - 1].date}.csv`, mime: 'text/csv', content, warnings };
  if (flat.length > QBO_JOURNAL_MAX_LINES) {
    // Never split an entry across files.
    const parts = [];
    let cur = [];
    for (const e of entries) {
      const ls = e.lines.map((l) => ({ e, l }));
      if (cur.length + ls.length > QBO_JOURNAL_MAX_LINES && cur.length) { parts.push(render(cur)); cur = []; }
      cur.push(...ls);
    }
    if (cur.length) parts.push(render(cur));
    res.parts = parts.map((c, i) => ({ filename: res.filename.replace(/\.csv$/, `-part${i + 1}of${parts.length}.csv`), content: c }));
    warnings.push(`QuickBooks imports at most ${QBO_JOURNAL_MAX_LINES} journal lines per file, so the entries are also provided as ${parts.length} files.`);
  }
  return res;
}
