// Generates the wide fixture files (PayPal, Gumroad sales) and applies the
// byte-level quirks real exports have (UTF-8 BOM, CRLF record endings with
// bare LF inside quoted fields). Run once: node test-support/make-fixtures.mjs
// All names, emails and amounts are invented.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

// Quote every field, like PayPal's US download.
const allQuoted = (cells) => cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',');
// Quote only when needed, like Ruby CSV (Gumroad) and PayPal's other variant.
const minimal = (cells) => cells.map((c) => {
  const s = String(c);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(',');

function crlfOutsideQuotes(text) {
  let out = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') q = !q;
    if (ch === '\n' && !q && text[i - 1] !== '\r') out += '\r\n';
    else out += ch;
  }
  return out;
}

const PAYPAL_HEADER = ['Date', 'Time', 'TimeZone', 'Name', 'Type', 'Status', 'Currency', 'Gross', 'Fee', 'Net', 'From Email Address', 'To Email Address', 'Transaction ID', 'Shipping Address', 'Address Status', 'Item Title', 'Item ID', 'Shipping and Handling Amount', 'Insurance Amount', 'Sales Tax', 'Option 1 Name', 'Option 1 Value', 'Option 2 Name', 'Option 2 Value', 'Reference Txn ID', 'Invoice Number', 'Custom Number', 'Quantity', 'Receipt ID', 'Balance', 'Address Line 1', 'Address Line 2/District/Neighborhood', 'Town/City', 'State/Province/Region/County/Territory/Prefecture/Republic', 'Zip/Postal Code', 'Country', 'Contact Phone Number', 'Subject', 'Note', 'Country Code', 'Balance Impact'];

function ppRow(o) {
  return PAYPAL_HEADER.map((h) => (o[h] === undefined ? '' : o[h]));
}

const usRows = [
  { Date: '03/30/2025', Time: '18:22:05', TimeZone: 'PDT', Name: '', Type: 'General Withdrawal', Status: 'Completed', Currency: 'USD', Gross: '-1,000.00', Fee: '0.00', Net: '-1,000.00', 'From Email Address': 'seller@example.com', 'Transaction ID': '9WD00000TEST0010', Balance: '180.39', 'Balance Impact': 'Debit' },
  { Date: '03/28/2025', Time: '09:01:12', TimeZone: 'PDT', Name: 'Sample Hosting Co', Type: 'PreApproved Payment Bill User Payment', Status: 'Completed', Currency: 'EUR', Gross: '-20.00', Fee: '0.00', Net: '-20.00', 'Transaction ID': '9WD00000TEST0009', 'Item Title': 'VPS plan, March', Balance: '-20.00', 'Balance Impact': 'Debit' },
  { Date: '03/28/2025', Time: '09:01:12', TimeZone: 'PDT', Name: '', Type: 'General Currency Conversion', Status: 'Completed', Currency: 'USD', Gross: '-21.84', Fee: '0.00', Net: '-21.84', 'Transaction ID': '9WD00000TEST0008', 'Reference Txn ID': '9WD00000TEST0009', Balance: '1,180.39', 'Balance Impact': 'Debit' },
  { Date: '03/28/2025', Time: '09:01:12', TimeZone: 'PDT', Name: '', Type: 'General Currency Conversion', Status: 'Completed', Currency: 'EUR', Gross: '20.00', Fee: '0.00', Net: '20.00', 'Transaction ID': '9WD00000TEST0007', 'Reference Txn ID': '9WD00000TEST0009', Balance: '0.00', 'Balance Impact': 'Credit' },
  { Date: '03/20/2025', Time: '14:10:00', TimeZone: 'PDT', Name: 'Casey Buyerperson', Type: 'Payment Refund', Status: 'Completed', Currency: 'USD', Gross: '-50.00', Fee: '1.20', Net: '-48.80', 'To Email Address': 'casey@example.com', 'Transaction ID': '9WD00000TEST0006', 'Reference Txn ID': '9WD00000TEST0002', Balance: '1,202.23', 'Balance Impact': 'Debit' },
  { Date: '03/18/2025', Time: '11:00:00', TimeZone: 'PDT', Name: 'Sample Hardware Store', Type: 'Account Hold for Open Authorization', Status: 'Pending', Currency: 'USD', Gross: '-1.58', Fee: '0.00', Net: '-1.58', 'Transaction ID': '9WD00000TEST0005', Balance: '1,249.45', 'Balance Impact': 'Debit' },
  { Date: '03/18/2025', Time: '11:05:00', TimeZone: 'PDT', Name: 'Sample Hardware Store', Type: 'Reversal of General Account Hold', Status: 'Completed', Currency: 'USD', Gross: '1.58', Fee: '0.00', Net: '1.58', 'Transaction ID': '9WD00000TEST0004', 'Reference Txn ID': '9WD00000TEST0005', Balance: '1,251.03', 'Balance Impact': 'Credit' },
  { Date: '03/12/2025', Time: '8:15:30', TimeZone: 'PDT', Name: 'Casey Buyerperson', Type: 'Shopping Cart Item', Status: 'Completed', Currency: 'USD', Gross: '50.00', Fee: '0.00', Net: '50.00', 'Transaction ID': '9WD00000TEST0003', 'Item Title': 'Print, 8x10 "Sunset"', Balance: '', 'Balance Impact': 'Memo' },
  { Date: '03/12/2025', Time: '8:15:30', TimeZone: 'PDT', Name: 'Casey Buyerperson', Type: 'Website Payment', Status: 'Completed', Currency: 'USD', Gross: '50.00', Fee: '-2.24', Net: '47.76', 'From Email Address': 'casey@example.com', 'Transaction ID': '9WD00000TEST0002', 'Item Title': 'Print, 8x10 "Sunset"', Balance: '1,251.03', 'Balance Impact': 'Credit' },
  { Date: '03/02/2025', Time: '16:45:00', TimeZone: 'PST', Name: 'Riley Clientname', Type: 'Express Checkout Payment', Status: 'Completed', Currency: 'USD', Gross: '1,250.00', Fee: '-46.73', Net: '1,203.27', 'From Email Address': 'riley@example.com', 'Transaction ID': '9WD00000TEST0001', 'Item Title': 'MONTHLY - $1 for the first 2 Months, then $6.99 / Month', Balance: '1,203.27', 'Balance Impact': 'Credit' },
];

writeFileSync(join(dir, 'paypal-us.csv'), '﻿' + [allQuoted(PAYPAL_HEADER), ...usRows.map((r) => allQuoted(ppRow(r)))].join('\r\n') + '\r\n');

// European locale variant: 39 columns (no email columns), decimal comma, day-first dates, CET.
const EU_HEADER = PAYPAL_HEADER.filter((h) => h !== 'From Email Address' && h !== 'To Email Address');
const euRows = [
  { Date: '15/01/2025', Time: '10:20:00', TimeZone: 'CET', Name: 'Kunde Beispiel', Type: 'Website Payment', Status: 'Completed', Currency: 'EUR', Gross: '1.227,95', Fee: '-35,96', Net: '1.191,99', 'Transaction ID': '7EU00000TEST0001', Balance: '1.191,99', 'Balance Impact': 'Credit' },
  { Date: '02/02/2025', Time: '09:00:00', TimeZone: 'CET', Name: '', Type: 'General Withdrawal', Status: 'Completed', Currency: 'EUR', Gross: '-1.000,00', Fee: '0,00', Net: '-1.000,00', 'Transaction ID': '7EU00000TEST0002', Balance: '191,99', 'Balance Impact': 'Debit' },
];
writeFileSync(join(dir, 'paypal-eu.csv'), [minimal(EU_HEADER), ...euRows.map((o) => minimal(EU_HEADER.map((h) => o[h] ?? '')))].join('\n') + '\n');

const GUMROAD_SALES_HEADER = 'Purchase ID,Item Name,Buyer Name,Purchase Email,Buyer Email,Do not contact?,Purchase Date,Purchase Time (UTC timezone),Subtotal ($),Taxes ($),Tax Type,Shipping ($),Sale Price ($),Fees ($),Net Total ($),Tip ($),Tax Included in Price?,Street Address,City,Zip Code,State,Country,Referrer,Refunded?,Partial Refund ($),Fully Refunded?,Disputed?,Dispute Won?,Access Revoked?,Variants,Discount Code,Recurring Charge?,Free trial purchase?,Pre-order authorization?,Product ID,Order Number,Pre-order authorization time (UTC timezone),Custom Fields,Item Price ($),Variants Price ($),Giftee Email,SKU ID,Quantity,Recurrence,Affiliate,Affiliate commission ($),Discover?,Cancellation Date,Subscription End Date,Rating,Review,License Key,License Key Activation Count,License Key Enabled?,Payment Type,PayPal Transaction ID,PayPal Fee Amount,PayPal Fee Currency,Stripe Transaction ID,Stripe Fee Amount,Stripe Fee Currency,Purchasing Power Parity Discounted?,Upsold?,Sent Abandoned Cart Email?,UTM Source,UTM Medium,UTM Campaign,UTM Term,UTM Content,Buyer Currency,Buyer Total,Buyer Refunded Total'.split(',');
const gs = (o) => GUMROAD_SALES_HEADER.map((h) => o[h] ?? '');
const salesRows = [
  { 'Purchase ID': 'aaTestSale0001==', 'Item Name': 'Notion Budget Template', 'Buyer Name': 'Jesse Example', 'Purchase Email': 'jesse@example.com', 'Purchase Date': '2026-03-02', 'Purchase Time (UTC timezone)': '2026-03-02 02:43:16 +0000', 'Subtotal ($)': '19.0', 'Taxes ($)': '1.71', 'Shipping ($)': '0.0', 'Sale Price ($)': '19.0', 'Fees ($)': '3.25', 'Net Total ($)': '15.75', 'Refunded?': '0', 'Partial Refund ($)': '0.0', 'Fully Refunded?': '0', 'Disputed?': '0', 'Dispute Won?': '0', 'Custom Fields': '{}', 'Payment Type': 'Card', Review: 'Great, saved me hours.\nWould buy again.' },
  { 'Purchase ID': 'aaTestSale0002==', 'Item Name': "'=Formula Pack", 'Buyer Name': '', 'Purchase Email': 'free@example.com', 'Purchase Date': '2026-03-03', 'Purchase Time (UTC timezone)': '2026-03-03 10:00:00 +0000', 'Subtotal ($)': '0.0', 'Taxes ($)': '0.0', 'Sale Price ($)': '0.0', 'Fees ($)': '0.0', 'Net Total ($)': '0.0', 'Refunded?': '0', 'Fully Refunded?': '0', 'Custom Fields': '{}' },
  { 'Purchase ID': 'aaTestSale0003==', 'Item Name': 'Icon Pack, Vol. 2', 'Buyer Name': 'Morgan Example', 'Purchase Email': 'morgan@example.com', 'Purchase Date': '2026-03-05', 'Purchase Time (UTC timezone)': '2026-03-05 12:00:00 +0000', 'Subtotal ($)': '9.0', 'Taxes ($)': '0.0', 'Sale Price ($)': '9.0', 'Fees ($)': '1.6', 'Net Total ($)': '7.4', 'Refunded?': '1', 'Partial Refund ($)': '0.0', 'Fully Refunded?': '1', 'Custom Fields': '{}', 'Payment Type': 'PayPal' },
  { 'Purchase ID': 'aaTestSale0004==', 'Item Name': 'Course: Bookkeeping Basics', 'Buyer Name': 'Dana Fictional', 'Purchase Email': 'dana@example.com', 'Purchase Date': '2026-03-06', 'Purchase Time (UTC timezone)': '2026-03-06 15:30:00 +0000', 'Subtotal ($)': '120.0', 'Taxes ($)': '0.0', 'Sale Price ($)': '120.0', 'Fees ($)': '12.3', 'Net Total ($)': '107.7', 'Refunded?': '1', 'Partial Refund ($)': '20.0', 'Fully Refunded?': '0', 'Custom Fields': '{}', 'Payment Type': 'Card' },
  { 'Purchase ID': 'Totals', 'Subtotal ($)': '148.0', 'Taxes ($)': '1.71', 'Sale Price ($)': '148.0', 'Fees ($)': '17.15', 'Net Total ($)': '130.85', 'Partial Refund ($)': '20.0' },
];
writeFileSync(join(dir, 'gumroad-sales.csv'), [minimal(GUMROAD_SALES_HEADER), ...salesRows.map((o) => minimal(gs(o)))].join('\n') + '\n');

// Byte quirks on hand-written fixtures.
const quirks = [
  ['venmo-2025.csv', { crlf: true }],
  ['venmo-2021.csv', { crlf: true }],
  ['airbnb-paid.csv', { crlf: true }],
  ['etsy-statement-2025-3.csv', { bom: true }],
];
for (const [name, q] of quirks) {
  const p = join(dir, name);
  let t = readFileSync(p, 'utf8');
  if (q.crlf) t = crlfOutsideQuotes(t);
  if (q.bom && t.charCodeAt(0) !== 0xfeff) t = '﻿' + t;
  writeFileSync(p, t);
}
console.log('fixtures written');
