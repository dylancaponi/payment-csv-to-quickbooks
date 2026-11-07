# Options and ids

Every source id, target id, transaction field and option the engine accepts.

## IDs

- Source ids: `venmo`, `cashapp`, `paypal`, `stripe-balance`, `stripe-payouts`, `etsy`, `airbnb`, `gumroad`, `generic-bank`.
  - `etsy` accepts the monthly statement, Sold Orders, Etsy Payments sales and Deposits CSVs (layout auto-detected; `meta.etsyLayout` says which).
  - `gumroad` accepts the payout CSV and the sales CSV (`meta.gumroadLayout`).
  - `stripe-balance` and `stripe-payouts` share one parser that reads any Stripe layout; the id only affects detection and labels.
- Target ids: `qbo`, `qfx`, `ofx`, `qbo-csv-3`, `qbo-csv-4`, `xero-csv`, `qbo-journal`.

## Txn

- Sign convention (clarification, not a change): `amount` is the effect on the balance of the account the export describes (the Venmo balance, the Stripe balance, the Etsy payment account...). Payouts to the bank are therefore negative, `type: 'payout'`. `amount === net`. When present, `gross - fee === amount` in cents; `fee` is positive when a fee was paid and negative when a fee was returned.
- New optional `tax?: number`: the part of `amount` that is sales tax collected and paid by the marketplace (Etsy "Sales tax paid by buyer" rows, Etsy Sold Orders hidden marketplace tax). Signed like `amount`.
- New optional `payoutDate?: 'YYYY-MM-DD'`: expected bank arrival date of the payout this row belongs to (Stripe `automatic_payout_effective_at` / `Transfer Date (UTC)`, Airbnb `Arriving by date`). Used as the journal entry date.
- `id` may be synthetic for rows the engine generates: `<id>:funding` / `<id>:destination` (Venmo offsetting transfers), `<purchase>:refund` (Gumroad sales CSV), `order-<n>` (Etsy Sold Orders).

## parse(sourceId, text, options)

- `sourceId` may be `null` or `'auto'` to auto-detect.
- Extra `meta` fields (present only when relevant): `sourceId`, `currencies` (when more than one), `openingBalance`, `closingBalance`, `reconciled` (Venmo), `mapping` and `dateOrder` (generic bank), `stripeLayout`, `etsyLayout`, `gumroadLayout`, `payoutTotal` (Gumroad payout Totals row).
- Options: `dateOrder: 'mdy'|'dmy'`, `decimal: '.'|','`, `delimiter`, `mapping: { date, description, amount, debit, credit, id, drcr }` (header names or indexes, generic bank), `invertSign` (generic bank), `currency` (generic bank and Airbnb default), `externalFunding: 'pair'|'ignore'` (Venmo, default pair), `accountHolder` (Venmo), `payoutId` (Gumroad payout CSV group id).

## write(targetId, transactions, options)

- Result may include `parts: [{ filename, content }]` when the output exceeds QuickBooks Online limits (1,000 rows or 350 KB for `qbo`, `qbo-csv-3`, `qbo-csv-4`; 1,000 lines for `qbo-journal`). `content` is still the full single file (fine for QuickBooks Desktop).
- `intuBid` (default `3000`, `2` for CAD), `routingNumber` (BANKID, default `000000000`), `fid` (generic OFX), `ledgerBalance`, `closeLeafTags` (default true), `region` (`'US'` default; anything else gives `Cheque Number` and DD/MM/YYYY for Xero), `groupBy` (journal: `'payout'` default when payout ids exist, else `'month'`), `accounts` (journal account names: `bank, sales, refunds, fees, taxes, adjustmentsIncome, adjustmentsExpense, clearing`), `journalPrefix`, `vendorName`, `filenameBase`, `sourceId` (used for filenames, labels and the default ACCTID).
- `accountType` values: `checking` (default), `savings`, `moneymrkt`, `creditline`, `creditcard`. `creditcard` writes a credit card statement (CCACCTFROM).
- `dateFormat` values: `MM/DD/YYYY`, `DD/MM/YYYY`, `YYYY-MM-DD`, `YYYY/MM/DD`, `DD-MM-YYYY`, `DD.MM.YYYY`, `MM-DD-YYYY`.
- Xero header has a 6th column (`Check Number` / `Cheque Number`), left empty, because that is Xero's own template header. The five columns in the brief come first in the same order.

## summarizePayouts(transactions, { groupBy })

Row shape: `{ key, groupBy, date, currency, transactionCount, grossSales, refunds, fees, taxes, adjustments, netActivity, payoutAmount, hasPayoutRow, difference, from, to }`. Numbers in major units; `refunds`, `fees` are usually negative; `grossSales + refunds + fees + taxes + adjustments = netActivity`; `netActivity = payoutAmount + difference` (difference = money kept in or taken from the platform balance). Transactions without a payout id group under key `(not yet paid out)`.

## Extra exports from index.js

`EngineError` (thrown for every user-facing failure; `.code` is stable, `.message` is written for end users), `parseCSV`, `writeCSV`, `convert(sourceId, text, targetId, options)` (parse + write in one call; returns the write result plus `meta` and merged `warnings`).

## Fixes after review (2026-11-04)

The site must pick these up. Everything above still holds unless changed here.

### New error codes (all `EngineError`; `message` is user-facing)
- `AMBIGUOUS_NUMBER_FORMAT`: the file does not settle whether "." or "," is the decimal separator (for example every amount looks like `1.000` or `2,500`). Thrown by `parse()` unless `options.decimal` is given.
  `error.details = { kind: 'decimal', option: 'decimal', sample: '-1.000', candidates: [{ decimal: '.', amount: -1 }, { decimal: ',', amount: -1000 }] }`
  The site should show the two readings of `sample` and re-run `parse()` with `{ decimal: '.' | ',' }`.
- `AMBIGUOUS_DATE_ORDER`: no date in the file settles month/day versus day/month (or the dates contradict each other). Thrown unless `options.dateOrder` is given.
  `error.details = { kind: 'dateOrder', option: 'dateOrder', sample: '01-02-2025', candidates: [{ dateOrder: 'mdy', date: '2025-01-02' }, { dateOrder: 'dmy', date: '2025-02-01' }] }`
  Re-run with `{ dateOrder: 'mdy' | 'dmy' }`. Dotted dates (31.01.2025) never throw: they are day first. Dates like 05/05 that read the same both ways do not count.
- `CELL_TOO_LONG`: one CSV value is over 100,000 characters (`MAX_CELL_CHARS`).
- `INTERNAL`: any unexpected failure is now wrapped (`details.cause` has the original message). No plain `Error` or `TypeError` escapes `parse`, `write`, `convert` or `summarizePayouts`; `detectSource` still never throws.
- `BAD_OPTION` is now also thrown for: `decimal` not "." or ","; `dateOrder` not "mdy"/"dmy"; unknown `timeZone`; `delimiter` not one character; `mapping` or `accounts` not an object; unknown key in `accounts`; non-text account names, `journalPrefix`, `region`, `accountId`, `bankName`; `intuBid` not a number; `currency` not 3 letters; `ledgerBalance` that is not a readable number (strings such as "1,234.56" are now accepted).
- `BAD_TXN` is now also thrown by `write()` for transactions that are not objects, amounts/gross/fee/net/tax that are not finite numbers (strings are rejected), descriptions or ids that are not text or numbers (numbers are converted), invalid currency, unknown `type`, invalid `payoutDate`.
- `AMOUNT_TOO_LARGE` now applies to every target (12 or more digits including cents).
- `NO_TRANSACTIONS` is thrown by the journal target when `options.currency` matches none of the transactions (it used to be silently ignored).

### New options
- `parse(..., { timeZone })`: IANA zone name (for example `America/Los_Angeles`). UTC timestamps (Venmo Datetime, Stripe `created_utc` / `Created (UTC)`, Gumroad `Purchase Time (UTC timezone)`) are converted to that zone before the date is taken. Without it they stay UTC dates and a warning explains the risk. The site should send the browser's zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) or let the user pick.
- `write('qbo-journal', ..., { accounts: { paymentsSent, transfers } })`: `paymentsSent` default `Payments sent (uncategorized expense)`; `transfers` defaults to the `bank` account.

### New meta fields from parse()
- `meta.timeZone`: the zone used: an IANA name, `'UTC'`, or a description such as `'as exported (local time shown in the file)'`.
- `meta.duplicatesRemoved`: count of exact repeats of the same platform transaction id that were dropped (only present when > 0). A warning also says so.

### Changed behaviour
- Detection is stricter. Cash App needs `Name of sender/receiver` or `Asset Type`; PayPal needs `TimeZone` or `Balance Impact`; Stripe needs a Stripe-only column or Stripe id prefixes (txn_, po_, ch_...); Etsy Payments needs `Posted Gross` or `Funds Available`; Airbnb needs `Arriving by date` (or `Confirmation code` with `Gross earnings`). Files that only share generic column names now fall to `generic-bank`, and choosing the specific source for them gives `WRONG_SOURCE`.
- Generic bank: prefers `Net` when `Amount`, `Fee` and `Net` columns all exist (warning); maps `Net`/`Gross` when there is no Amount column; knows Dutch, German, French, Spanish and Italian header names; warns when 90%+ of amounts are positive (possible card export needing `invertSign`).
- Delimiter sniffing is quote-aware and picks the delimiter with the most consistent column count.
- Repeated header rows inside a file are dropped with a warning; for sources with platform ids, exact repeats (same id, date, amount, description, currency) are dropped with a warning.
- Source formula guards (a leading apostrophe in the export) are no longer stripped. Every CSV output (QuickBooks CSV, Xero CSV, journal) prefixes an apostrophe to any text cell starting with `=`, `+`, `-`, `@`, tab or CR.
- FITIDs changed for every existing output (re-imports of files produced by the first version will not match). New rule: hash of date, amount in cents, description and platform id (id only when unique in the set), plus an occurrence index among identical rows. A split-off fee line is the parent FITID plus `F`.
- PayPal: pending (and denied, failed, held...) rows are always left out; any type with "hold", "release" or "authorization" is left out; a currency conversion leg in another currency takes the type of the payment it converts (so a USD leg paying for a EUR purchase is a payment sent). PayPal dates fitting both orders are read month first for US time zones and day first for European/Australian ones, with a warning; otherwise `AMBIGUOUS_DATE_ORDER`.
- Stripe: Connect `transfer` / `transfer_reversal` rows are now `type: 'other'` (money sent to connected accounts, not the user's bank); `topup` stays `transfer`. Failed payouts keep their payout_reversal row. A blank local `created` cell falls back to `created_utc`.
- Cash App: `Direct Deposit` is now `type: 'other'` (income that is not a sale).
- Venmo: a negative `Amount (fee)` keeps its sign (fee returned).
- Gumroad payout CSV: purchase ids are no longer given `:2` suffixes, so pasted-together payout files are de-duplicated.
- QBO split `parts`: boundaries avoid splitting a day where possible; each part's LEDGERBAL is the running balance on its last day (the last part ends at the full file's balance).

### summarizePayouts rows and journal lines
- New row fields: `paymentsSent` (money the user sent to others; refunds received for those payments reduce it), `transfersToBank` and `transfersFromBank` (both positive; money the user moved between the platform and their own bank), `mixedCurrencyPayout` (boolean).
- `grossSales` now only holds money received (positive payments); it is never negative.
- `netActivity = grossSales + refunds + fees + taxes + adjustments + paymentsSent`.
- `difference = netActivity - payoutAmount - transfersToBank + transfersFromBank` (change in the platform balance).
- `type: 'transfer'` rows no longer go to `adjustments`.
- Journal entries can now contain these extra lines: `Payments sent` / `Refunds received for payments sent` (account `paymentsSent`); `Transfer from <vendor> to bank` (debit `transfers` account, credit `clearing`) and `Transfer from bank to <vendor>` (debit `clearing`, credit `transfers`). Each entry still balances to the cent.
- A payout id seen in more than one currency: only the main currency's part is booked to the bank; the rest goes to the clearing account (warning).

## Second round of fixes (2026-11-04)

### Txn: new optional fields
- `transferAccount?: 'bank' | 'card'` on `type: 'transfer'` rows. `'card'` means a card or any funding source that is not recognisably the user's bank. Absent means bank.
- `refundSide?: 'sale' | 'purchase'` on `type: 'refund'` rows. `'sale'` covers refunds given, chargebacks and won chargebacks (reversals) on the user's sales; `'purchase'` is money back for something the user paid. Absent: negative = sale side, positive = purchase side.
- Transfers and payouts may now carry `gross` / `fee` / `net`. `gross` is what reached the other account; the fee is an expense (Cash App instant cash out, Venmo instant transfer, Stripe instant payout, PayPal withdrawal fee). Stripe payout rows used to have their fee dropped; it is now kept when the signs make it clear.
- `write()` rejects other values of these fields with `BAD_TXN`.

### FITIDs (all outputs change again)
- Base = hash(date, amount in cents, description, id if present, type) plus an occurrence index among rows identical on all of those. The decision is made per row; the file-wide "are ids unique" switch is gone.
- Unsplit, the net line uses the base. With `includeFeesAsSeparateRows` the gross line is base + `G` and the fee line base + `F`. The bank writers add a warning in split mode not to import the same period both ways.

### parse() options and meta
- When `dateOrder` / `decimal` IS given and the file cannot confirm it, parsing proceeds with the given value. It sets `meta.dateOrderAssumed` / `meta.decimalAssumed = true` and adds `meta.assumptionSamples: [{ kind: 'dateOrder', option: 'dateOrder', sample, readings: [{ dateOrder: 'mdy', date }, { dateOrder: 'dmy', date }] }, { kind: 'decimal', option: 'decimal', sample, readings: [{ decimal: '.', amount }, { decimal: ',', amount }] }]`, plus a warning. If the data contradicts the given value, a warning says so. With no option the two AMBIGUOUS_* errors are unchanged.
  The site should always pass a locale-based default and show a confirmation built from `assumptionSamples`.
- These platforms never raise either AMBIGUOUS_* error: Stripe and Etsy (they fall back to the platform convention and mark it assumed), and Venmo, Cash App and Gumroad (their formats are fixed). PayPal and Airbnb are localized and can raise either error when no option is given. For PayPal, a US or European time zone in the file settles the date order and is marked assumed.
- In comma-delimited files, a quoted value like "1,000" now counts as thousands, not as ambiguous.
- `meta.pendingTransfers: [{ date, amount, description }]` (only present when > 0): pending transfers and withdrawals that were left out (Venmo, Cash App, PayPal). A warning lists them and says to re-export after they complete.
- `meta.timeZone` may read `"<zone> (some dates not converted)"`, and `meta.datesNotConverted` gives the count, when timestamps were re-saved by a spreadsheet. Explicit offsets and Z in timestamps are honoured.

### Duplicates
- A row is dropped only when the source has row-unique ids (Venmo, Cash App with an id, PayPal, Stripe, Etsy, Airbnb) and the whole source row is identical. Gumroad is never de-duplicated. The warning now gives the count and the total amount dropped.

### summarizePayouts rows and journal
- New row fields: `fundingToCard`, `fundingFromCard` (both positive). `difference` now also subtracts `fundingToCard` and adds `fundingFromCard`.
- Transfer and payout fees now appear in `fees`. `transfersToBank`, `transfersFromBank` and `payoutAmount` are the gross amounts that actually moved.
- New account key: `accounts.fundingCard`, default `Credit card or other funding source`. New journal lines: `Funded by card or other source into <vendor>` (debit clearing, credit fundingCard) and `Paid to card or other funding source from <vendor>` (debit fundingCard, credit clearing). Each comes with a warning.
- Won chargebacks and Stripe `dispute_reversal` rows reduce Refunds instead of crediting Payments sent. Stripe `dispute_reversal` and `refund_failure` are now `type: 'refund'`, `refundSide: 'sale'`.
- Cash App: a received payment whose status says refunded is now the original `payment` (sale); a sent payment or card purchase marked refunded is the original spend.

## Third round of fixes (2026-11-04)

The data shapes and option names are unchanged. There are two new error codes, and a few behaviours changed:
- `options.dateOrder` and `options.decimal` now only break genuine ties. When the file settles the question, the data wins for every source and a warning says the setting was ignored; `meta.dateOrderAssumed` / `meta.decimalAssumed` stay unset. Evidence that settles it: a date part above 12; an amount with both separators; one or two digits after the last separator; a quoted "1,000" in a comma-delimited file. The site can keep passing a locale default safely.
- New error `MIXED_DATE_FORMATS` when some dates only fit month/day and others only day/month: `details = { kind: 'dateOrder', mixed: true, samples: [{ dateOrder: 'mdy', value, date }, { dateOrder: 'dmy', value, date }] }`. This replaces the earlier "contradicting dates" case of `AMBIGUOUS_DATE_ORDER` and is thrown even when `dateOrder` is given.
- Amounts that mix "1,234.56" and "1.234,56" styles throw `AMBIGUOUS_NUMBER_FORMAT` even when `decimal` is given, with `details.mixed: true` and `details.samples: [{ decimal: '.', value }, { decimal: ',', value }]`.
- New error `UNREADABLE_DATE` (generic bank CSV) when a date-shaped value is not a real date under the settled order: `details = { line, value, dateOrder }`. These rows used to be skipped as footer lines.
- Funding labels: bank words (bank, checking, savings, credit union) mean the bank. Clear card evidence (Visa, Mastercard, American Express / Amex, Discover, "credit card", "debit card") means a card. Anything else, including blank, now defaults to the bank (`transferAccount: 'bank'`) with a warning naming the label. Before, anything else went to the card account.
- Re-saved timestamps (Stripe, Venmo, Gumroad, Cash App) that are read by assumption now set `meta.dateOrderAssumed` and `meta.assumptionSamples` like any other assumed read. Fixed-format Venmo business and Cash App dates no longer follow `options.dateOrder` blindly.

## Fourth check residuals (2026-11-04)

No API change. There is a new warning per row whenever an amount has more than two decimals and was rounded. The text names the row's date and description, the original value and the value used. Funding labels containing the word "card" or a common card product name (Quicksilver, Venture, Savor, Sapphire, Freedom, Double Cash, Custom Cash) now count as card evidence. Bank words still win.

## New sources (2026-11-05, not yet independently reviewed)

New source ids: `square`, `shopify-transactions`, `shopify-payouts`, `wise`. Same `parse()` result and Txn shape; no new options. `options.currency` is used only when the file has no currency of its own (Square `$` files, Shopify files without a Currency column); data always wins. Journal vendor labels: Square, Shopify, Wise. Square and Shopify transactions carry `payoutId` / `payoutDate` (Deposit ID / Payout ID or payout date), so `groupBy: 'payout'` works; Shopify payouts files carry a `payout` row per payout; Wise has no payout ids (journal by month). None of the new sources is in the row-unique-id de-duplication set: their ids repeat (Wise main and fee rows) or are absent (Shopify), and identical rows can be real money.

## Review round 1 fixes for the new sources (2026-11-05)
- Txn: optional `tips` and `giftCardSales` (major units, part of a sale's gross). `summarizePayouts` rows: new `tipsCollected` and `giftCardSales`, carved out of `grossSales`; `netActivity` includes them.
- Journal: new account keys `tips` (default `Tips owed to staff`) and `giftCards` (default `Gift card liability`); lines only appear when non-zero, so other sources' output is unchanged.
- `write('qbo-journal', ...)` throws `NOT_SUPPORTED` for Wise transactions (sourceId `wise`, or a TransferWise ID / Wise ID column in `raw`).
- `detectSource` returns `sourceId: null` with a plain "wrong export" reason for Square item sales and Shopify orders/products exports; `parse('generic-bank', ...)` throws WRONG_SOURCE for them.
- Shopify payouts: failed payouts' activity is kept without a payout id; Retried Amount is no longer a transaction.

## Amazon settlement source and named journal lines (2026-11-06)

All additive. Existing sources produce byte-identical output (golden files unchanged).

- New source id `amazon-settlement` (Amazon Seller Central settlement report, Flat File V2, tab-separated). See FORMATS.md Appendix D.
  - `meta`: `settlementId`, `settlementStart`, `settlementEnd`, `depositDate`, `depositTotal`, `rowsTotal`, `reconciled` (rows total equals total-amount). With several settlements in one file also `account` (chosen settlement id), `accounts` (`[{ account, currency, transactions }]`) and `accountKind: 'settlement'`.
  - Parse option `account`: the settlement id to convert (a trailing currency, as the site sends it, is ignored). Unknown id: `BAD_OPTION` with `details.accounts`.
  - New refusals (`BAD_FILE`): settlement without a summary row, summary row repeated, unreadable deposit-date or total-amount, bad currency, detail row in another currency. `WRONG_SOURCE` for the Amazon Date Range Transaction CSV (also refused in `detectSource`).
- New optional Txn fields:
  - `journalLine` (text, at most 200 characters): the journal writes this transaction's part on its own line with this description, inside its normal bucket (the bucket line keeps the rest).
  - `journalAccount`: one of `sales, refunds, fees, taxes, clearing, adjustmentsIncome, adjustmentsExpense, advertising, fulfillmentFees, reserve`; the named line goes to that account instead of the bucket's. Other values: `BAD_TXN`.
- `summarizePayouts` rows get `details: [{ bucket, account, label, amount }]` only when a transaction in the group has `journalLine`.
- New journal `accounts` keys: `advertising` and `fulfillmentFees` (default: the fees account), `reserve` (default: the clearing account), `taxesPayable` (default: `accounts.taxes` if set, else "Sales Tax / VAT Payable"). `journalAccount` also accepts `taxesPayable`.
- `write()` to any non-journal target adds a first warning for Amazon settlements (sourceId `amazon-settlement`, or transactions with `journalLine` and a `settlement-id` raw column) to import into a separate Amazon clearing account.
- The generic "couldn't recognize" message now lists Amazon.

## eBay transaction report source (2026-11-06)

All additive; existing golden files unchanged.
- New source id `ebay` (Seller Hub transaction report CSV). See FORMATS.md Appendix E. Each payout becomes named lines (Txn `journalLine`, `journalAccount`) plus the payout; payoutId = eBay Payout ID; several payouts per file, one journal entry each; currency selection as for every other source.
- `meta`: `payouts` (`[{ payoutId, currency, rows, payout, reconciled }]`, payout null when the Payout row is missing), `payoutCount`, `notPaidOut`, `reconciled`.
- Refusals: `WRONG_SOURCE` for the German eBay.de report and the eBay payout report (also in `detectSource`); `BAD_FILE` for a payout with two payout currencies or two Payout rows.
- `write()` to non-journal targets adds a first warning for eBay (sourceId `ebay`, or rows built by this parser) to import into a separate eBay clearing account.
- The generic "couldn't recognize" message now lists Amazon and eBay.

## Gusto payroll journal source (2026-11-06 evening)

All additive; existing golden files unchanged.
- New source id `gusto-payroll` (Gusto Payroll Journal Report CSV, flat layout with one row per employee). See FORMATS.md Appendix F. Each "Employee Earnings" block (one per pay schedule) becomes named lines plus a payout of the block's Payroll Totals Check Amount; payoutId = `<pay day> <schedule>` (for example `2026-03-13 Weekly Payroll`), date = pay day. Several payrolls per file, one journal entry each.
- Txn signs follow the existing contract with the "balance" being a payroll clearing view: expenses negative (debit), liabilities positive (credit), the payout positive (money in from the bank, credited to the bank account in the journal).
- `meta`: `payrolls` (number of blocks), `employeeRows`, `payrollChecks` (`[{ key, payDay, checkAmount, reconciled }]`, reconciled = employee rows equal Payroll Totals in every money column read and the lines equal the Check Amount total), `reconciled` (all payrolls reconciled).
- New journal `accounts` keys, also accepted as `journalAccount`: `wages` (default `Payroll Expenses:Wages`), `payrollTaxExpense` (`Payroll Expenses:Taxes`), `benefitsExpense` (`Payroll Expenses:Benefits`), `reimbursements` (`Employee Reimbursements`), `payrollTaxesPayable` (`Payroll Liabilities:Taxes`), `payrollDeductions` (`Payroll Liabilities:Deductions`). Only Gusto payroll lines use them, so other sources' output is unchanged.
- Journal wording for payroll (sourceId `gusto-payroll`, or a `Gusto payroll` key in `raw`): entry description "Gusto payroll <key>", bank line "Net pay paid to employees (Check Amount)", clearing line "Gap between the payroll lines and the Check Amount total", and a payroll version of the "do not add up" note.
- `write()` throws `NOT_SUPPORTED` for Gusto payroll transactions with targets `qbo`, `qfx`, `ofx`, `qbo-csv-3`, `qbo-csv-4`, `xero-csv` (a payroll report is not a bank statement). `spreadsheet-csv` and `qbo-journal` work.
- Refusals: `WRONG_SOURCE` for the Gusto Payroll Journal layout with Job and Pay Type columns and no Gross Earnings (also in `detectSource`); `BAD_FILE` for a block without a Pay day line, without a Payroll Totals row, with an unreadable amount, or the same payroll twice; `MISSING_COLUMNS` when the Gusto columns are not there.
- `parse()` no longer drops repeated header rows for `gusto-payroll` (the report repeats its header once per pay schedule on purpose).

## Walmart Recon report source (2026-11-06 evening)

All additive; existing golden files unchanged.
- New source id `walmart-recon` (Walmart Marketplace Recon report CSV, v1). See FORMATS.md Appendix G. One report = one payout: named lines (Txn `journalLine`, `journalAccount`) plus the payout of Total Payable; payoutId = `<period start> to <period end>`; date = the PaymentSummary row's Transaction Posted Timestamp (period end if missing).
- `meta`: `periodStart`, `periodEnd`, `depositDate`, `depositTotal`, `rowsTotal`, `reconciled`.
- Refusals: `WRONG_SOURCE` for the JSON form (also in `detectSource`); `BAD_FILE` for no PaymentSummary row, several PaymentSummary rows, unreadable Total Payable, currency or dates; `MISSING_COLUMNS`.
- `write()` to non-journal targets adds a first warning for Walmart (sourceId `walmart-recon`, or a `Walmart recon` key in `raw`) to import into a separate Walmart clearing account.
