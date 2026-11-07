// Fixture catalog with hand-computed expectations (sums worked out on paper
// from the fixture rows, independent of the engine).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = join(ROOT, 'fixtures');
export const GOLDEN = join(ROOT, 'golden');

export function readFixture(name) {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

export const CASES = [
  { file: 'venmo-2025.csv', source: 'venmo', count: 8, sumCents: 51690 },
  { file: 'venmo-2021.csv', source: 'venmo', count: 3, sumCents: 3902 },
  { file: 'cashapp-2026.csv', source: 'cashapp', count: 6, sumCents: 129980 },
  { file: 'cashapp-2024-v1.csv', source: 'cashapp', count: 5, sumCents: 112300 },
  { file: 'paypal-us.csv', source: 'paypal', count: 7, sumCents: 18039, byCurrency: { USD: 18039, EUR: 0 } },
  { file: 'paypal-eu.csv', source: 'paypal', count: 2, sumCents: 19199, currency: 'EUR' },
  { file: 'stripe-balance-history.csv', source: 'stripe-balance', count: 10, sumCents: 1135 },
  { file: 'stripe-balance-change-itemized.csv', source: 'stripe-balance', count: 5, sumCents: 245228 },
  { file: 'stripe-payout-reconciliation.csv', source: 'stripe-payouts', count: 6, sumCents: 38248 },
  { file: 'etsy-statement-2025-3.csv', source: 'etsy', count: 11, sumCents: 1739 },
  { file: 'etsy-sold-orders.csv', source: 'etsy', count: 2, sumCents: 9278 },
  { file: 'etsy-deposits.csv', source: 'etsy', count: 2, sumCents: -114058 },
  { file: 'airbnb-paid.csv', source: 'airbnb', count: 6, sumCents: 0 },
  { file: 'gumroad-payout.csv', source: 'gumroad', count: 5, sumCents: 2265 },
  { file: 'gumroad-sales.csv', source: 'gumroad', count: 5, sumCents: 10345 },
  { file: 'square-transactions.csv', source: 'square', count: 4, sumCents: 121551 },
  { file: 'shopify-transactions.csv', source: 'shopify-transactions', count: 5, sumCents: 321790, currency: 'CZK' },
  { file: 'shopify-payouts.csv', source: 'shopify-payouts', count: 12, sumCents: -17954 },
  { file: 'wise-statement.csv', source: 'wise', count: 6, sumCents: 99617 },
  // Amazon settlements: each settlement is its named lines plus the deposit, so the
  // Amazon balance nets to zero. US rows by hand: order 1 24.48 + order 2 25.49 + refund -17.59
  // + ads -12.34 + storage -3.21 + reimbursement 8.75 + reserve 50.00 - 40.00 = 35.58 = total-amount.
  // DE: 29.99 + 5.70 - 4.50 - 3.10 - 0.14 + 8.00 - 10.00 = 25.95 = total-amount.
  { file: 'amazon-settlement-us.txt', source: 'amazon-settlement', count: 15, sumCents: 0 },
  // eBay: two payouts, each its named lines plus the payout (nets to zero). Payout 6000000001:
  // 69.93 + 74.80 - 26.20 - 8.25 - 4.10 - 4.95 - 20.00 = 81.23; 6000000002: 1039.40 + 20.00 - 15.00 = 1044.40.
  // The Oct 18 order has no Payout ID and is left out.
  { file: 'ebay-transaction-report.csv', source: 'ebay', count: 16, sumCents: 0 },
  { file: 'amazon-settlement-de.txt', source: 'amazon-settlement', count: 8, sumCents: 0, currency: 'EUR' },
  // Bank statements. Sums: Rabobank 300+300+600+300+600-4114-25.40+600 = -1439.40, which is also
  // closing 4003.49 - opening 5442.89 printed in the file. The ING sample does not reconcile in the
  // published file (the parser warns); its sum is the entries as printed. The ABN AMRO file is constructed
  // and reconciles: 2500.00 - 354.44 = 2145.56, then 2145.56 - 28.79 = 2116.77 (entries sum -383.23). German sample: the
  // account with the most entries (0194783700888), sum = its closing minus opening balances.
  { file: 'mt940-rabobank-gist.sta', source: 'mt940', count: 8, sumCents: -143940, currency: 'EUR' },
  { file: 'mt940-ing-sample.sta', source: 'mt940', count: 2, sumCents: 47500, currency: 'EUR' },
  { file: 'mt940-abnamro.sta', source: 'mt940', count: 10, sumCents: -38323, currency: 'EUR' },
  { file: 'mt940-german-sepa.sta', source: 'mt940', count: 12, sumCents: null, currency: 'EUR' },
  // camt053-multi: 660.12 - 289.00 + 50.00 - 30.00 - 50.00 - 1.50 = 339.62 (pending 999.00 left out).
  { file: 'camt053-multi.xml', source: 'camt053', count: 6, sumCents: 33962, currency: 'EUR' },
  { file: 'camt053-v08.xml', source: 'camt053', count: 1, sumCents: -2450, currency: 'EUR' },
  { file: 'camt053-ing-sample.xml', source: 'camt053', count: 1, sumCents: 27000, currency: 'EUR' },
  { file: 'generic-bank-debit-credit.csv', source: 'generic-bank', count: 5, sumCents: 315960 },
  { file: 'generic-bank-signed.csv', source: 'generic-bank', count: 4, sumCents: 128295, options: { dateOrder: 'mdy' } },
];

// Source and target pairs the engine refuses on purpose (plain EngineError).
export const UNSUPPORTED = new Set(['wise>qbo-journal', 'mt940>qbo-journal', 'camt053>qbo-journal']);

export const TARGET_IDS = ['qbo', 'qfx', 'ofx', 'qbo-csv-3', 'qbo-csv-4', 'xero-csv', 'spreadsheet-csv', 'qbo-journal'];

export function centsOf(txns, currency) {
  return txns.filter((t) => !currency || t.currency === currency).reduce((s, t) => s + Math.round(t.amount * 100), 0);
}
