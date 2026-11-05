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
  { file: 'generic-bank-debit-credit.csv', source: 'generic-bank', count: 5, sumCents: 315960 },
  { file: 'generic-bank-signed.csv', source: 'generic-bank', count: 4, sumCents: 128295, options: { dateOrder: 'mdy' } },
];

// Source and target pairs the engine refuses on purpose (plain EngineError).
export const UNSUPPORTED = new Set(['wise>qbo-journal']);

export const TARGET_IDS = ['qbo', 'qfx', 'ofx', 'qbo-csv-3', 'qbo-csv-4', 'xero-csv', 'qbo-journal'];

export function centsOf(txns, currency) {
  return txns.filter((t) => !currency || t.currency === currency).reduce((s, t) => s + Math.round(t.amount * 100), 0);
}
