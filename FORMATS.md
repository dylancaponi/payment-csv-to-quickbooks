# FORMATS.md: source and target format rules

Compiled 2026-11-04. Every claim in the appendices carries the source URL it came from. Anything that could not be confirmed from a primary source (official help page, official template file, spec) or from a concrete real export file is marked UNVERIFIED. Web pages and files were read as data only; no third-party code was downloaded or run.

How to read this file:
- Part 1: the rules the engine enforces, with the source URL for each and where they live in the code.
- Part 2: every UNVERIFIED detail in one list, plus the engine's own choices where no source exists.
- Appendix A: Venmo, Cash App, PayPal, Gumroad research notes (verbatim headers, quirks, URLs).
- Appendix B: Stripe, Etsy, Airbnb research notes.
- Appendix C: QBO, QFX, OFX, QuickBooks Online CSV, Xero CSV, QuickBooks Online journal import rules.

## Part 1: rules enforced by the engine

### Sources (parsers in src/sources/)

| Source | Header detection | Junk lines handled | Dates | Amounts and sign | Fees / refunds / transfers | Primary evidence |
|---|---|---|---|---|---|---|
| Venmo personal (2021: 19 cols, 2024+: 22 cols) | row with `ID` and `Amount (total)`; first cell empty | 2 preamble lines, beginning-balance row, ending-balance footer with multi-line quoted disclaimer, crypto summary | `YYYY-MM-DDTHH:MM:SS`, UTC wall time | `+ $25.00` / `- $1,000.00`; plus = in | `Amount (fee)` unsigned; transfers `Standard Transfer` / `Issued`; bank-funded rows do not move the balance (engine adds an offsetting transfer) | real exports in public repos: https://github.com/TrentChip38/Python_Projects/blob/main/AnalyzeVenmo/Transactions/VenmoStatement_Sep_2024.csv , https://github.com/Mrcarnj/MajorPools/blob/main/data/VenmoStatement_April_2025.csv , https://github.com/egost/venmo_statement/blob/main/venmo_statement.csv ; export steps https://help.venmo.com/cs/articles/transaction-history-vhel281 |
| Venmo business | `Transaction ID`, `Date`, `Time (UTC)`, `Amount (net)` | none known | `MM/DD/YYYY` | as personal | `Amount (net)` used as amount | fixture only (UNVERIFIED): https://github.com/drbartender/os/blob/main/server/scripts/staffPaymentImport/__fixtures__/venmo-business.csv |
| Cash App v1 (to ~2024-08) / v2 (from ~2024-10) | `Transaction ID`, `Date`, `Transaction Type`, `Amount`, `Net Amount` in either order, plus Cash App's own `Name of sender/receiver` or `Asset Type` | none; newest first | `YYYY-MM-DD HH:MM:SS EDT` | `$10.00`, `-$5.00`, v1 `$2`; Fee negative, Net = Amount + Fee | `PAYMENT REVERSED` = refund; `FAILED` skipped; `Account Notifications` $0 skipped | https://github.com/BittyTax/BittyTax/blob/master/src/bittytax/conv/parsers/cashapp.py , https://github.com/Nina530/Nina530/blob/main/cash_app_report.csv , https://github.com/matthagy/cashapp_analysis/blob/main/data/cash_app_report_1782136207099.csv |
| PayPal activity download | `Date,Name,Type,Status,Currency,Gross,Fee,Net` by name (columns are user-customizable), plus PayPal's own `TimeZone` or `Balance Impact` | optional UTF-8 BOM | locale: `MM/DD/YYYY` (US), `DD/MM/YYYY`, `YYYY/MM/DD`; sniffed, time zone used as a hint | US `1,234.56`, EU `1.234,56`; Fee negative, Net = Gross + Fee | `Balance Impact` = `Memo` skipped; holds and their reversals skipped; currency conversion = 3 rows linked by `Reference Txn ID` | https://developer.paypal.com/reports/activity-download , https://www.paypal.com/us/cshelp/article/how-do-i-view-and-download-statements-and-reports-help145 , https://github.com/hledgerorg/hledger/blob/master/examples/csv/other/paypal-2018.csv.rules |
| Stripe legacy balance history | `id,Type,Amount,Net,Created (UTC)` plus Stripe-only evidence: `Available On (UTC)`, `Customer Facing Amount`, `Transfer Group` or `Destination Platform Fee`, or ids with Stripe prefixes (txn_, po_, ch_...) | none | `YYYY-MM-DD HH:MM` UTC | major units; Fee positive; Net = Amount - Fee; payouts negative; EU decimal comma | `Transfer` column = payout id that swept the row; raw `Type` mapped to reporting category | https://raw.githubusercontent.com/BananaAccounting/Universal/HEAD/extensions/import/stripe/test/testcases/ch.banana.filter.import.stripe.transactions_all_format1_20231004.csv , https://raw.githubusercontent.com/onyedikachi-david/my-algora-stripe-payments/HEAD/src/data/balance_history.csv |
| Stripe Reports itemized (balance change, payouts section, payout reconciliation) | `balance_transaction_id`, `net`, and `reporting_category` or txn_ ids | none | `YYYY-MM-DD HH:MM:SS`, `_utc` or account time zone | major units (https://docs.stripe.com/reports/api) | `reporting_category` list https://docs.stripe.com/reports/reporting-categories ; `automatic_payout_id` groups rows into payouts https://docs.stripe.com/reports/payout-reconciliation | https://docs.stripe.com/reports/report-types/balance , https://docs.stripe.com/reports/report-types/payout-reconciliation |
| Etsy monthly statement | `Date,Type,Title,Info,Currency,Amount,Fees & Taxes,Net[,Tax Details]` | UTF-8 BOM; newest first | `January 30, 2025` or `16 January, 2024` | symbols `-€0.19`, `$1,250.00`; `--` = empty | Deposit amount only in Title text; buyer sales tax added to Sale and removed by a `Tax` row | https://raw.githubusercontent.com/MoulikArora21/FiDAViSta-Converter/HEAD/CE/test_files/etsy_statement_2025_1.csv , https://help.etsy.com/hc/articles/360016389113 |
| Etsy Sold Orders / Payments / Deposits | `Sale Date,Order ID,...,Order Net` / `Payment ID,...` with `Posted Gross` or `Funds Available` / `Date,Amount,Currency,Status,Bank Account Ending Digits` | none | `MM/DD/YY`, `MM/DD/YYYY`, `July 3, 2025` | plain decimals; deposits use thousands separators | Sold Orders lacks transaction/listing/ad fees | https://raw.githubusercontent.com/pqueuex/store.extantra/HEAD/EtsySoldOrders2025.csv , https://help.etsy.com/hc/articles/360000343328 |
| Airbnb transaction history | `Type` + `Amount` + `Paid out` + (`Arriving by date`, or `Confirmation code` with `Gross earnings`); English and Spanish | none known | `M/D/YY` (US) | plain numbers, integers allowed | `Payout` row first, then the rows it pays; Paid out = sum of their Amount; occupancy tax informational | https://raw.githubusercontent.com/scmsal/nextProject/HEAD/rentalTaxes/sampleCSV/sampleTransactions.csv , https://raw.githubusercontent.com/Fafifo92/rental-income-dashboard/HEAD/src/services/etl.ts , https://www.airbnb.com/help/article/3632 |
| Gumroad payout CSV | `Type,Date,Purchase ID,...,Gumroad Fees ($),Net Total ($)` | `Subtotal - ...` and `Totals` footer rows | `YYYY-MM-DD` UTC | plain decimals | refunds, chargebacks, payout fee are dated rows | https://github.com/antiwork/gumroad/blob/main/app/services/exports/payouts/csv.rb |
| Gumroad sales CSV | `Purchase ID`, `Sale Price ($)`, `Net Total ($)`, `Purchase Date` | `Totals` row; `'` formula guard on text | `YYYY-MM-DD` | plain decimals | refunds flagged on the sale row only, no refund date | https://github.com/antiwork/gumroad/blob/main/app/services/exports/purchase_export_service.rb , https://github.com/antiwork/gumroad/blob/main/lib/utilities/csv_safe.rb |
| Generic bank CSV | first row (of 40) with a date-like and an amount-like or debit/credit header (English, Dutch, German, French, Spanish, Italian names); Net is preferred when Amount, Fee and Net all exist | preamble lines, footer lines without a date, repeated header rows | `mdy`/`dmy` decided from the data, dotted = day first, otherwise AMBIGUOUS_DATE_ORDER | symbols, parentheses, trailing minus; decimal separator decided from the data, otherwise AMBIGUOUS_NUMBER_FORMAT | debit/credit merged; optional DR/CR indicator column | engine design (no single source) |
| Square transactions CSV (added 2026-11-05, NOT yet reviewed) | `Date`,`Time`,`Gross Sales`,`Net Sales`,`Total Collected`,`Fees`,`Net Total`,`Transaction ID` all present | none; newest first | `YYYY-MM-DD` + `HH:MM:SS` in the account time zone (`Time Zone` column), used as written; re-saved `M/D/YYYY` checked | `$1,234.56`, `-$184.28`, re-saved `($20.00)`; Fees negative; Net Total = Total Collected + Fees | `Event Type` Payment / Refund; cash, Square gift card and other tenders left out (mixed rows keep the Card + Cash App part); `Deposit ID` = payout id, `Deposit Date` = payout date; tax reported in a warning, kept inside sales | real exports: https://github.com/ksfraser/FA_ImportSquareUp/blob/HEAD/includes/transactions-2024-08-24-2024-08-25.csv , https://github.com/YukiiiNot/mgf_env_dotnet/tree/HEAD/docs/99-reference/misc/square_imports , https://github.com/Tribowl-LLC/Perfect-Game-Daily-Dash/tree/HEAD/attached_assets , https://github.com/chrisccoy/dcfbmailer/blob/HEAD/notebook/trans.csv |
| Shopify Payments transactions CSV (added 2026-11-05, NOT yet reviewed) | `Transaction Date`,`Type`,`Payout Status`,`Payout Date`,`Available On`,`Amount`,`Fee`,`Net` | none | `2023-10-31 12:00:42 +0100`: store-local date used as written | plain decimals; Fee positive; Net = Amount - Fee | `charge` payment, `refund`/`dispute` sale-side refund, `payout` payout, others adjustments with a warning for unknown types; `Payout ID` when present else `shopify-<Payout Date>-<currency>`; non-`paid` rows get no payout id | official column list https://help.shopify.com/en/manual/payments/shopify-payments/getting-paid-with-shopify-payments/view-payouts/view-details ; real export https://github.com/anion0278/mapp/blob/HEAD/Mapp.BusinessLogic.Transactions.Tests/TestData/Shopify.csv ; `Payout ID` variant parser-only https://github.com/firsttris/haben/blob/HEAD/packages/import/src/psp.test.ts ; types https://shopify.dev/docs/api/admin-rest/latest/resources/transactions.md |
| Shopify Payments payouts CSV (added 2026-11-05, NOT yet reviewed) | `Payout Date`,`Status`,`Charges`,`Refunds`,`Adjustments`,`Reserved Funds`,`Fees`,`Total` | none | `YYYY-MM-DD` | plain decimals; Refunds negative; Fees positive (real) or negative (synthetic): the sign that makes the row equal Total is used, else the row is left out | each `paid` row becomes charges, refunds, adjustments, reserved funds, retried amount, fees and the payout itself (nets to zero); other statuses left out | real export https://github.com/jameshunter12/james-fastpage/blob/HEAD/_notebooks/payout-export.csv ; negative-fee dataset https://github.com/avinashrayudu/dtc-cash-onboarding |
| Wise balance statement CSV (added 2026-11-05, NOT yet reviewed) | `TransferWise ID` (or `Wise ID`),`Date`,`Amount`,`Currency`,`Description`,`Running Balance` | optional UTF-8 BOM; newest first | `DD-MM-YYYY` always day-first; re-saved slash dates checked | signed plain decimals = what moved the balance; `Total fees` informational only (fee rows exist separately) | `... Charges for:` rows fee, `BALANCE-` conversions other, `CARD-` purchases/refunds, ids repeat (main + fee row) | real sample https://github.com/jlabath/wiseconvert/blob/HEAD/statement_sample.csv ; https://mail.kde.org/pipermail/kmymoney/2023-March/004062.html ; https://github.com/kedder/ofxstatement-transferwise/blob/HEAD/tests/sample-statement.csv ; https://github.com/OSadovy/uabean/tree/HEAD/tests/importers/wise_csv ; formats only https://wise.com/help/articles/2736049/how-do-i-download-a-statement |

### Targets (writers in src/targets/)

QBO / QFX / OFX (src/targets/ofx.js), from Appendix C:
- 9-line OFX 1.0.2 header `OFXHEADER:100` ... `NEWFILEUID:NONE`, CRLF, then a blank line before `<OFX>`. Header block: OFX 2.2 spec sec 2.8 https://financialdataexchange.org/wp-content/uploads/2025/12/OFX-2.2.pdf ; `CHARSET:1252` as in real bank QBO files https://quickbooks.intuit.com/learn-support/en-us/banking/cannot-import-qbo-to-credit-card-account-type-only-other-current/00/970740 and csv2ofx https://raw.githubusercontent.com/reubano/csv2ofx/master/csv2ofx/ofx.py
- `SONRS`: STATUS, DTSERVER, LANGUAGE ENG, FI (ORG, FID), then `INTU.BID` (QBO and QFX only) after `</FI>`.
- INTU.BID default `3000` (Wells Fargo, ACTIVE, `BANKING,CREDIT&WEB-CONNECT` in Intuit's QuickBooks FI list https://ofx-prod-filist.intuit.com/qb3400/data/fidir.txt ), `2` when the currency is CAD (QuickBooks Canada, ProperSoft https://www.propersoft.net/howto/output-settings-qbo/ ). Configurable with `intuBid`.
- Bank accounts: BANKMSGSRSV1 > STMTTRNRS > STMTRS > BANKACCTFROM (BANKID, ACCTID, ACCTTYPE). Credit cards: CREDITCARDMSGSRSV1 > CCSTMTTRNRS > CCSTMTRS > CCACCTFROM (ACCTID only). A card written as BANKACCTFROM + CREDITLINE only imports as Other Current Liability (Intuit community thread above).
- STMTTRN order TRNTYPE, DTPOSTED, TRNAMT, FITID, NAME, MEMO (OFX 2.2 spec 11.4.4.1). TRNTYPE CREDIT for >= 0, DEBIT for < 0.
- DTPOSTED `YYYYMMDD120000`: noon avoids the time-zone day shift (spec 3.2.8.4).
- TRNAMT `-1234.56`, no thousands separators (spec 3.2.9.1); fewer than 12 digits (QuickBooks "invalid transaction amount" https://quickbooks.intuit.com/learn-support/en-ca/help-article/bank-transactions/fix-bank-upload-errors-quickbooks-online/L6FBh3zDC_CA_en_CA ).
- FITID: 16 uppercase hex chars, FNV-1a 64 of date|amount in cents|description|platform id (id only when unique in the set) plus an occurrence number among identical rows; a split-off fee line uses the parent FITID plus `F` (17 chars). Spec allows 255, recommends 32 or fewer (spec 3.2.3). QuickBooks skips FITIDs it has seen, even after deletion https://www.propersoft.net/howto/quickbooks-import-duplicates/
- NAME at most 32 chars (A-32), MEMO at most 255, ACCTID at most 22, BANKID at most 9 digits, ORG/FID at most 32.
- `&`, `<`, `>` escaped; text folded to printable ASCII (ENCODING:USASCII).
- LEDGERBAL (BALAMT, DTASOF) always present (required in STMTRS, spec 11.4.2.2).
- QuickBooks Online upload limits: 350 KB and 1,000 lines https://quickbooks.intuit.com/learn-support/en-us/help-article/import-transactions/manually-upload-transactions-quickbooks-online/L0rE9OXBz_US_en_US . Bigger QBO output also returns `parts`.

QuickBooks Online bank CSV (src/targets/csvbank.js), same Intuit page plus https://quickbooks.intuit.com/learn-support/en-us/banking/import-bank-transactions-using-excel-csv-files/00/261910 and https://quickbooks.intuit.com/learn-support/en-ca/help-article/import-transactions/common-errors-importing-bank-transactions-using/L02IgW462_CA_en_CA :
- Header exactly `Date,Description,Amount` or `Date,Description,Credit,Debit` (no word "amount" in Credit/Debit).
- One date format for the whole file; default `MM/DD/YYYY`, configurable.
- Amount `-1234.56`, no symbols, no thousands commas; 4-column: positive numbers, unused side blank (never 0); zero rows dropped.
- Description: printable ASCII, purely numeric descriptions prefixed with `Ref `.
- CRLF line endings ("save as Windows CSV"), no BOM; at most 1,000 rows and 350 KB per upload (splits into `parts`).

Xero bank statement CSV (src/targets/csvbank.js):
- Header from Xero's own template file: `*Date,*Amount,Payee,Description,Reference,Check Number` (US) or `Cheque Number` (elsewhere): https://go.xero.com/Bank/TemplateDownloader.aspx?americanise=true and ...?americanise=false
- Signed amount, decimal point; at most 100,000 rows https://central.xero.com/0/article/Import-a-CSV-bank-statement-US
- Dates `MM/DD/YYYY` (region US, default) or `DD/MM/YYYY`, both listed as recommended by Xero.

QuickBooks Online journal import (src/targets/journal.js):
- Columns `Journal No.,Journal Date,Account Name,Debits,Credits,Description,Name` https://quickbooks.intuit.com/learn-support/en-us/help-article/import-export-data-files/import-journal-entries-quickbooks-online/L4tQBwbs7_US_en_US and https://quickbooks.intuit.com/learn-support/en-ca/help-article/import-export-files/import-journal-entries-quickbooks-online/L4tQBwbs7_CA_en_CA
- Lines of one entry share Journal No. and date; each entry balances to the cent; each line fills exactly one of Debits/Credits.
- At most 1,000 lines per file https://www.firmofthefuture.com/quickbooks-proadvisor/in-the-know-s1-e9-journal-entries-import/ ; split without breaking an entry.
- Accounts must exist; subaccounts as `Parent:Sub` (Intuit US page above).

## Part 2: UNVERIFIED details and engine choices

Source details not confirmed:
- Venmo: whether `Amount (total)` is already net of `Amount (fee)` (engine assumes net, warns); business-profile header (fixture only); `Instant Transfer` fee row shape; exact date the 19 to 22 column switch happened; negative balance format; raw line endings of current downloads.
- Cash App: official web export menu wording; card purchase, refund, direct deposit and instant-deposit fee row shapes in the v2 format; time zone abbreviations other than EST/EDT; raw line endings.
- PayPal: row-level difference between "Balance affecting" and "All transactions" downloads; sign of Fee on refunds (engine derives fee = Gross - Net, so either sign works); current label of the transaction-type dropdown.
- Stripe: Dashboard Payouts list export header (parsed best effort with a warning); BOM and line endings of live downloads; default column order of `balance_change_from_activity.itemized.7`; rendering of zero-decimal currencies; whether the payout row appears in the itemized payout reconciliation (engine handles both); sign of payout rows in `payouts.itemized` (engine forces sign from the category).
- Etsy: time zone of dates; statement Type values beyond Sale, Fee, Tax, VAT, Marketing, Refund, Deposit (unknown types are kept as "other" with a warning); thousands separators inside statement amount columns (engine accepts them); meaning of Adjusted* and Refund Amount columns in Sold Orders and Payments files (engine warns and does not book them); Tax Details contents.
- Airbnb: exact current English header (engine matches by name, case-insensitive, with aliases for the `Airbnb remitted tax` column that replaced `Occupancy taxes`); shape of the Upcoming export; sign of Service fee on reservation rows (engine derives fee from Gross - Amount when Gross is present); time zone; whether symbols or thousands separators ever appear (engine accepts them).
- Gumroad: pre-2025 sales headers; no real payout CSV seen (header from Gumroad's open-source exporter code); semantics of partial refunds for fees (engine books partial refunds without a fee component).

- Square (2026-11-05): Dashboard export menu wording (from parser repos, no official help page read); that cash, Square gift card and other tenders never reach a Square deposit (engine choice); currency of `$` files (assumed USD, warned); decimal comma in non-English Square locales; whether refunds carry their original Payment ID; whether fees are ever refunded on refund rows; sales tax stays in gross sales (warned); tips and gift card sales get their own journal lines on fully card-paid sales (review N2); Partial Refunds column semantics unknown (warned, review N10); no standalone deposits export header found.
- Shopify (2026-11-05): that Shopify pays one payout per day per currency (payout id without a `Payout ID` column is the payout date); full list of `Type` values in the CSV (only `charge` and `refund` seen in real files); sign of `payout` rows if they appear; `Fee` sign on refunds and adjustments; meaning of `Retried Amount`; time zone of `Payout Date`.
- Wise (2026-11-05): no official column list; whether every layout lists fees as separate rows (engine never subtracts `Total fees`, and the Running Balance check warns when the file does not add up); export menu wording; newer account-wide "Transactions" export (`ID,Status,Direction,...`) is not supported (parser-only evidence, unsigned amounts).

Target details not confirmed:
- Which fidir.txt column is the INTU.BID QuickBooks matches (column 1 is the community reading); whether QuickBooks Online validates INTU.BID at all; whether leading zeros matter ("3000" vs "03000").
- Whether BANKID content matters to QuickBooks (engine writes `000000000` unless `routingNumber` is given; ProperSoft says leave it empty unless needed).
- Practical FITID length limit inside QuickBooks (engine uses 16 chars, well under the spec's recommended 32).
- QuickBooks Online's exact list of selectable CSV date formats; whether it rejects parentheses or currency symbols in amounts (engine never writes them); which "special characters" in descriptions block import (engine writes printable ASCII from a conservative set and drops `$`, `<`, `>`, emoji).
- Encoding QuickBooks expects for CSV (engine writes ASCII only, so the question does not arise).
- Xero: precoded statement headers (not implemented); byte size limit; whether ISO `YYYY-MM-DD` is accepted (engine does not default to it); encoding of non-ASCII text without a BOM (engine writes UTF-8 without BOM and strips emoji).
- QuickBooks Online journal import: exact optional column names in Intuit's sample file (Name, Location, Class, Currency); Journal No. maximum length (engine keeps it at 21 characters or fewer, the QuickBooks Online DocNumber limit as documented for the API; not confirmed for the importer); accepted date formats; whether semicolon separators are accepted.
- Quicken Mac behaviour with QFX (community reports only); whether Quicken accepts INTU.BID 3000 from the Quicken list row.
- QuickBooks Desktop date-range limit for Web Connect files (none found).

Review suspicions (2026-11-04 independent review) and their status:
- S1 PayPal Pending rows with a Balance Impact: fixed. Pending, denied, failed, canceled, voided, expired, unclaimed, placed and held rows are always left out (test "S1"). Whether a pending row ever moves the available balance in PayPal's own accounting remains UNVERIFIED; leaving it out matches the completed-only statement.
- S2 PayPal "Payment Hold" / "Payment Release": fixed, every type containing the word hold or release, or authorization, is left out (test "S2"). If only one side of a hold falls in the export, the file's total will differ from PayPal's balance; the warning says holds were left out.
- S3 Venmo fee semantics: partly fixed. A returned (negative) fee now keeps its sign. Whether Amount (total) is net of Amount (fee) is still UNVERIFIED; the engine treats it as net and warns on every file with fees. Needs one real goods-and-services export.
- S4 Stripe failed payouts: fixed. Reports list a failed payout as a payout row plus a payout_reversal row; both are kept so they cancel (test "S4"). Before, only the payout row was dropped, leaving a phantom credit.
- S5 Stripe payout mixing currencies: fixed. For a payout id seen in more than one currency only the main currency's part counts toward the bank deposit; the rest is booked to the clearing account with a warning (test "S5").
- S6 Generic card exports with positive purchases: mitigated. When 90% or more of 5+ amounts are positive the parser warns and suggests invertSign (test "S6"). Not auto-inverted, because a deposit-heavy bank file looks the same.
- S7 INTU.BID 3000 and BANKID 000000000 may make QuickBooks Desktop show the account as Wells Fargo: unresolved, not testable without QuickBooks. ProperSoft documents that the bank name shown comes from INTU.BID (https://propersoft.net/howto/quickbooks-errors), so the label will read Wells Fargo even though transactions go to the account the user picks. INTU.BID stays 3000 by default, configurable, UNVERIFIED as noted above.

Second review pass (2026-11-04) decisions:
- Transfer and payout fees: the bank (or card) line is the gross moved; the fee is an expense. Cash App: Amount is what moved, Fee is negative, Net = Amount + Fee (confirmed from the export's own columns, see Appendix A). Venmo Instant Transfer: Amount (total) is what left the balance and Amount (fee) is taken from it, so the bank receives total minus fee: UNVERIFIED (inferred, not confirmed by a real export or Venmo help page). PayPal withdrawal fees and Stripe instant payout fees follow the export's Gross/Amount, Fee and Net columns; a Stripe payout whose signs do not make the relation clear uses Net and warns (UNVERIFIED, no real instant payout file seen).
- Bank versus card funding: a Venmo Funding Source / Destination or Cash App Account label is treated as the user's bank only when it contains a bank word (bank, checking, credit union, federal, financial, N.A. and similar) and no card word (Visa, Mastercard, Amex, Discover, debit, credit, card). Anything else is booked to the separate funding account. Cash App cash outs default to the bank unless the label names a card, because their Account column often only says "Cash Balance" (UNVERIFIED). PayPal "General Withdrawal" and "Bank Deposit to PP Account" are bank; types containing "card" are card (UNVERIFIED for card withdrawals).
- Duplicates: only sources with row-unique ids (Venmo ID, Cash App Transaction ID when present, PayPal Transaction ID, Stripe balance transaction id, Etsy Payment ID or order id, Airbnb payout reference) are de-duplicated, and only for a byte-identical source row. Gumroad purchase ids repeat across sale and refund rows and are never de-duplicated.
- Time zones: an explicit offset or Z in a timestamp is honoured. A timestamp not in the platform's own ISO shape (a file re-saved in a spreadsheet, such as "7/1/2025 2:12") is not converted and a warning says so.
- Airbnb dates and numbers are localized by Airbnb, so an Airbnb file can still raise AMBIGUOUS_DATE_ORDER or AMBIGUOUS_NUMBER_FORMAT when no option is passed. PayPal likewise, except that a US (or European/Australian) time zone column settles the date order.
- Pending transfers (Venmo, Cash App, PayPal) are left out and listed by date and amount, because a later month's export will not include them once they complete (re-check S8).

Engine choices made without a source (all legal per spec):
- Leaf element end tags are written (`<CODE>0</CODE>`). OFX 1.0.2 parsers must accept them; real bank files both include and omit them. Set `closeLeafTags: false` to omit.
- DTSTART is the first day at 000000, DTEND the last day at 235959, DTSERVER the last day at 120000 (deterministic, no wall clock).
- TRNUID is `1`.
- LEDGERBAL defaults to the sum of the transactions when no `ledgerBalance` is given (the applications only display it).
- ACCTID defaults to `BI` + 10 hex chars derived from the source id and currency; users with several accounts from the same source should pass `accountId`.
- Dates printed in local time are kept as printed. UTC timestamps (Venmo Datetime, Stripe *_utc and Created (UTC), Gumroad Purchase Time) are converted to `options.timeZone` when given; without it they stay UTC dates and a warning says so. Date-only UTC values (Gumroad payout dates, Stripe arrival dates) cannot be converted and stay as printed.
- Ambiguous number formats and day/month orders are never guessed: the parser throws `AMBIGUOUS_NUMBER_FORMAT` / `AMBIGUOUS_DATE_ORDER` unless the file settles it or the caller passes `decimal` / `dateOrder`. Dotted dates (DD.MM.YYYY) are read day first. A PayPal file whose time zone column is a US zone is read month first (and a European or Australian zone day first), with a warning; this is a documented PayPal locale behaviour, not confirmed for every account (UNVERIFIED).
- Etsy order, payment files and deposits are read month first when the dates fit both orders, with a warning, because every sample seen was month first (UNVERIFIED for non-US shops).
- Journal entries: transfers between the platform and the user's own bank are booked bank against the clearing account (never income or expense); payments the user sent go to `Payments sent (uncategorized expense)`; gross sales only hold money received for sales (incoming payments, which for P2P apps cannot be told apart from friends paying back: UNVERIFIED by design, the user recategorizes); Cash App direct deposits go to Uncategorized Income.


---

# Appendix A: Venmo, Cash App, PayPal, Gumroad


Researched 2026-11-04. Read-only research; every fetched page treated as data. UNVERIFIED marks details not confirmed from a primary or concrete source.

## 1. Venmo statement CSV

### 1.1 Header and preamble (2021 era, statement download)

Source: Tiller community thread, post by "randy" 2021-06-11
https://community.tiller.com/t/venmo-upload-not-working-import-csv-line-items-workflow-question/8939

Lines 1-2 are preamble, header is line 3 (thread says "column header rows are in the third line of CSV file"):

```
Account Statement - (@XXXX) - March 12th to June 12th 2021 ,,,,,,,,,,,,,,,,,,
Account Activity,,,,,,,,,,,,,,,,,,
,ID,Datetime,Type,Status,Note,From,To,Amount (total),Amount (tip),Amount (fee),Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,Terminal Location,Year to Date Venmo Fees,Disclaimer
```

- Header starts with an EMPTY first column (leading comma).
- 18 named columns after the empty one: ID, Datetime, Type, Status, Note, From, To, Amount (total), Amount (tip), Amount (fee), Funding Source, Destination, Beginning Balance, Ending Balance, Statement Period Venmo Fees, Terminal Location, Year to Date Venmo Fees, Disclaimer.
- Users in that thread reported amounts parsing as NaN in Tiller (consistent with "+ $" / "- $" prefixed amounts, see below).

### 1.2 Older / simpler column set (beancount-import)

Source: jbms/beancount-import venmo.py
https://raw.githubusercontent.com/jbms/beancount-import/master/beancount_import/source/venmo.py

- Required columns (subset check after stripping whitespace from header names): ID, Datetime, Type, Status, Note, From, To, Amount (total), Amount (fee), Funding Source, Destination. No "Amount (tip)" required, so file may predate or ignore it.
- Code strips whitespace from header keys (`{k.strip(): v ...}`), implying headers in some exports had leading/trailing spaces (e.g. " ID") UNVERIFIED as to which year.
- Reads header from line 1 via csv.DictReader (no preamble skip), so it expects either an older export without preamble or a user-cleaned file. UNVERIFIED which.
- Datetime parsed with dateutil, tz ignored, treated as UTC.
- Type values handled: `Standard Transfer`, `Charge`, `Payment`, `Merchant Transaction`, `Refunded transaction`; any other raises error. (Instant Transfer not listed, so likely newer than code.)
- Separate balances.csv (user-made, from finance-dl scrape): `"Start Date","End Date","Start Balance","End Balance"`, balance example `"$1528.25"`, dates `%Y-%m-%d`.

### 1.3 Real statement files (2021, 2024, 2025) - personal profile

Concrete sources (real Venmo statement CSVs committed to public repos; only structure recorded here, no personal data):
- 2021-08 (19-col, no tax columns): https://github.com/egost/venmo_statement/blob/main/venmo_statement.csv
- 2024-09 (22-col): https://github.com/TrentChip38/Python_Projects/blob/main/AnalyzeVenmo/Transactions/VenmoStatement_Sep_2024.csv
- 2025-04 (22-col): https://github.com/Mrcarnj/MajorPools/blob/main/data/VenmoStatement_April_2025.csv
- Synthetic fixture built from a real 2025 export: https://github.com/drbartender/os/blob/main/server/scripts/staffPaymentImport/__fixtures__/venmo-personal.csv
- Importer spec with sample: https://github.com/jakelit/cash-sync/blob/main/docs/specs/venmo_importer.md

Header variant A (2021, confirmed in egost file; same as Tiller 2021 post):
```
,ID,Datetime,Type,Status,Note,From,To,Amount (total),Amount (tip),Amount (fee),Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,Terminal Location,Year to Date Venmo Fees,Disclaimer
```
Header variant B (2024 and 2025, confirmed in TrentChip38 and Mrcarnj files): adds Amount (tax) after Amount (tip), and Tax Rate, Tax Exempt after Amount (fee):
```
,ID,Datetime,Type,Status,Note,From,To,Amount (total),Amount (tip),Amount (tax),Amount (fee),Tax Rate,Tax Exempt,Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,Terminal Location,Year to Date Venmo Fees,Disclaimer
```
Exact switch date between A and B: UNVERIFIED (between 2021-09 and 2024-09).

File layout (all three real files):
- Line 1: `Account Statement - (@username) ` followed by commas padding to column count. Note trailing space before the commas. 2021 file includes period: `Account Statement - (@user) - July 31st to September 1st 2021 ` (ordinal dates in prose). 2024/2025 files have NO period text, just `Account Statement - (@user) `. Whether the period text depends on download path (monthly vs custom range): UNVERIFIED.
- Line 2: `Account Activity,,,,...`
- Line 3: header, first cell empty.
- Line 4: beginning balance row: all empty except Beginning Balance column, e.g. `$14.95` or quoted `"$1,250.00"` when it has a thousands comma.
- Data rows: first cell empty, ID is a 19-digit numeric string (Credit Card Payment rows had 12-digit IDs like `100001863680` in 2021). IDs exceed 2^53, keep as string.
- Footer row: all empty except Ending Balance (e.g. `"$3,445.00"`), Statement Period Venmo Fees (`$0.00`), Year to Date Venmo Fees (`$0.00`), and Disclaimer: a long quoted multi-line text starting `In case of errors or questions about your\n        electronic transfers:` with embedded LF newlines and 8-space indentation, ending with `(https://venmo.com/legal/bancorp-cardholder-agreement).\n        `.
- 2021 file additionally has a crypto section after the footer: `Cryptocurrency summary` row, a row with `Ethereum` in col 3, `Available beginning` / `Available ending` rows with coin quantities, a blank row, then `Cryptocurrency summary in USD (Estimated values as of Sep 13, 2021 04:31 hours U...` and repeat with USD values. Present in 2024/2025: not seen (those accounts may have had no crypto) UNVERIFIED.
- Columns Terminal Location = `Venmo` on every transaction row. Tax Rate = `0`, Amount (tax) = `0` on 2024/2025 payment rows; transfer rows leave them empty.

Encoding and line endings:
- No UTF-8 BOM in any of the 4 files checked (first bytes `Acc`).
- 2025-04 file: CRLF record terminators (`\r\n`), but the embedded newlines inside the quoted Disclaimer are bare LF. 2021 file also CRLF. 2024 file had LF only (may be git normalization, UNVERIFIED).
- Notes contain emoji (UTF-8) and quoted embedded newlines (2021 file: `"Disney food \nBengal\nMendocinos \nOgas Cantina"`). Parser must be RFC4180 quote-aware.

Datetime:
- Format `YYYY-MM-DDTHH:MM:SS` with no zone, e.g. `2025-04-08T11:37:36`. Treated as UTC wall time by hyphenatable parser ("Venmo statements give UTC wall time without a zone"): https://github.com/Devaj6190/hyphenatable/blob/main/packages/connectors/src/exports/venmo-csv.ts . Official confirmation of UTC: UNVERIFIED (business-profile format labels column `Time (UTC)`, see 1.4, supporting UTC).

Amounts:
- Amount (total): sign, space, dollar, number: `+ $25.00`, `- $200.00`, `- $1,000.00` (thousands comma inside quotes in raw CSV). Plus = into the account holder's view (received), minus = sent/withdrawn.
- Amount (fee): unsigned `$0.05`, empty when none. Seen on received Payment rows in a 2024 business-ish account (`+ $1.70` total with `$0.05` fee). Whether total is net of fee: UNVERIFIED (2024 file did not reconcile begin+sum to end; 2025 file reconciled exactly: $144.00 + 3301.00 = $3,445.00).
- Balances: `$14.95`, `"$3,445.00"`, no sign seen. Negative balance format UNVERIFIED.
- Currency: USD only; no currency column.

Type / Status values observed:
- `Payment` / `Complete` (sent or received; sign tells direction; From/To are names).
- `Charge` / `Complete` (a request that was paid; 2021).
- `Merchant Transaction` / `Complete` (fixture, 2025).
- `Standard Transfer` / `Issued` (cash-out to bank; From/To/Note empty; amount negative `- $444.15`; Destination = bank like `ZIONS BANCORPORATION, NA DBA ZIONS B *0040` or `ALLY BANK *9391`).
- `Credit Card Payment` / `Complete` (2021; Venmo credit card paydown; Funding Source = bank `ALLY BANK Personal Checking *9391` or `Venmo balance`).
- `Credit Card Reward` / `Complete` (2021; `+ $25.55`, no From/To).
- From beancount-import code: `Refunded transaction`. From openaccountant skill (second-hand): `Instant Transfer`. Instant transfer fee row shape: UNVERIFIED.
- Funding Source values: `Venmo balance`, bank like `... Personal Checking *9391`, empty when the user is the receiver. Destination: `Venmo balance` for receipts, bank name for transfers.
- Rows funded from an external bank/card (Funding Source not Venmo balance) do not move the Venmo balance; converter must not assume sum(total) = balance change. 2021 file confirms: begin $101.04, end $140.06, but sum totals -960.98 (includes Credit Card Payment from bank). UNVERIFIED exact rule.

### 1.4 Business profile variant (different header)

Sources: drbartender fixture https://github.com/drbartender/os/blob/main/server/scripts/staffPaymentImport/__fixtures__/venmo-business.csv (synthetic, hand-made), and a Google Sheet surfaced by search listing the same columns https://docs.google.com/spreadsheets/d/1FlELa6ndsRCQokg8Jad5W6rU3vreC1_I/edit
```
Transaction ID,Date,Time (UTC),Type,Status,Note,From,To,Amount (total),Amount (tip),Amount (tax),Amount (net),Amount (fee),Tax Rate,Tax Exempt,Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,Terminal Location,Year to Date Venmo Fees,Disclaimer
```
- No preamble lines in the fixture; header on line 1; no empty first column. Search snippet lists `Donor email` after From for charity profiles (column set may vary by profile type) UNVERIFIED.
- Transaction ID quoted with literal double quotes inside, e.g. `"""1111111111111111111"""` in raw CSV (fixture) UNVERIFIED for real exports.
- Date `MM/DD/YYYY`, Time `HH:MM:SS` UTC. Unused fields `0`, `(None)`, Tax Exempt `FALSE`. Whole layout UNVERIFIED against a real business export.

### 1.5 Export steps (official)

Source: https://help.venmo.com/cs/articles/transaction-history-vhel281
- "Account statements allow you to view a detailed history of your Venmo transactions in a downloadable CSV file." Available for personal, Teen (parent only), business, charity profiles.
- App: select year and month from dropdown, choose download or email; large files get emailed.
- Web: venmo.com, Statements (sidebar), pick month/year from dropdown (click year at top to change year), Download CSV.
- One month per statement in UI. Undocumented full-range URL reported by a user 2025-02: `https://account.venmo.com/api/statement/download?startDate=2024-01-01&endDate=2024-12-31&csv=true` (https://infinitekind.tenderapp.com/discussions/online-banking/1250556-venmo-downloading-all-transactions-a-year-at-a-time-in-csv-format) UNVERIFIED.
- Separate crypto tax "Transactions Statement CSV" exists under Settings > Tax Documents (https://help.coinledger.io/en/articles/5964845-venmo-file-import-guide), different format, not covered.

### 1.6 Converter rules (derived)
- Locate header by finding a row containing `ID`/`Transaction ID` and `Amount (total)`; map by name, not position (column count is 19, 22 or 23).
- Data row = ID cell all digits (strip quotes). Skip beginning-balance row, footer, crypto section.
- Amount regex: `^([+-]) \$([\d,]+\.\d{2})$`.

## 2. Cash App CSV

### 2.1 Export steps

- Official monthly statements page (2026-11 fetch): https://cash.app/help/us/en-us/3055-download-transaction-history . In-app: Profile icon > Documents > Account Statements. Web: cash.app/account > Documents > Account statements > year dropdown > View next to month. These monthly statements are viewable documents (PDF-style: balances, fees, history, routing numbers); this page does NOT mention CSV.
- Official tax page: https://cash.app/help/us/en-us/6526-personal-and-business-use-tax-reporting . "We'll send you a Transaction CSV statement". In-app: profile icon > Documents & statements > Business Account Taxes > Tax Documents > 1099-K or Transactions CSV.
- Third-party (TokenTax): "In Cash App, click Statements." then "Click Export CSV." https://help.tokentax.co/en/articles/6207465-how-to-get-your-cash-app-data . This is the long-standing web path (cash.app/account > Activity/Statements > Export CSV). Current exact menu wording on web: UNVERIFIED (official help page for it not found, help pages are JS-rendered).
- Downloaded filename pattern seen in the wild: `cash_app_report_<epoch-ms>.csv` (e.g. `cash_app_report_1727949352123.csv` = 2024-10-03) and `cash_app_report.csv`. Sources: https://github.com/Enkato64bit/general-contracting/blob/main/cash_app_report_1727949352123.csv , https://github.com/matthagy/cashapp_analysis/tree/main/data
- Exports seem to cover full history (one 2026-06 export spans 2021-08-04 to 2026-06-22). Pending excluded (third-party claim, UNVERIFIED).

### 2.2 Headers (two variants, same 14 columns, different order)

Source for both: BittyTax parser registers both as v1 and v2: https://github.com/BittyTax/BittyTax/blob/master/src/bittytax/conv/parsers/cashapp.py ; plus real files below.

v1 (older, Transaction ID first). Real file exported ~2024-08 (data 2024-01-12 to 2024-08-07): https://github.com/Nina530/Nina530/blob/main/cash_app_report.csv ; also https://github.com/Aga92-92/Aga92-92/blob/main/cash_app_report.csv
```
"Transaction ID","Date","Transaction Type","Currency","Amount","Fee","Net Amount","Asset Type","Asset Price","Asset Amount","Status","Notes","Name of sender/receiver","Account"
```
v2 (newer, Date first). Real files exported 2024-10 and 2026-06: https://github.com/Enkato64bit/general-contracting/blob/main/cash_app_report_1727949352123.csv , https://github.com/matthagy/cashapp_analysis/blob/main/data/cash_app_report_1782136207099.csv
```
"Date","Transaction ID","Transaction Type","Currency","Amount","Fee","Net Amount","Asset Type","Asset Price","Asset Amount","Status","Notes","Name of sender/receiver","Account"
```
Switch between v1 and v2: between 2024-08 and 2024-10 (from file dates above; exact date UNVERIFIED). v2 also changed vocab (below).

File structure: no preamble, no footer, header on line 1, every field double-quoted in header. No BOM (first bytes `"Tr` / `"Da`). LF line endings in all 4 files (git may normalize, raw download line ending UNVERIFIED). Rows newest first (reverse chronological). No quoted newlines seen in Notes (0 across 1,200+ rows).
- v1 quirk: empty fields sometimes unquoted: `...,"$2",,"",,"PAYMENT DEPOSITED",,"Shawn Stein","Your Cash"` (mixed `,,` and `""`).

### 2.3 Field formats

- Date: `YYYY-MM-DD HH:MM:SS TZ` with abbreviation, e.g. `2024-09-26 16:18:23 EDT`, `2026-01-24 20:39:52 EST`. Zone is the account/device local zone with DST abbreviation (EDT/EST seen; BittyTax maps EST/EDT to America/New_York only). Other abbreviations (PST, PDT, CST, UTC) presumably appear for other users UNVERIFIED. Parser needs an abbreviation map.
- Transaction ID: v1 short base36 like `ux2t7w`; v2 often empty for Stock/Bitcoin/Deposits rows, numeric `306150405514408` for Withdrawal, `#D-824GXRGG` for some P2P. Not a reliable unique key; dedupe on (Date, Amount, Notes, Type) when empty.
- Amount / Fee / Net Amount: `$10.00`, `-$5.00` (minus before dollar sign, no space). v1 drops zero cents: `$2`, `$149`, `-$28`, fee `$0`. v2 always 2 decimals, fee `$0.00`. Thousands separator: none seen in Amount; Asset Price uses it (`$63,371.65`), so assume `$1,234.56` possible. BittyTax also handles parentheses `($x)` as negative, so that variant existed at some point UNVERIFIED.
- Sign: positive = into Cash balance, negative = out. Fee is negative (`-$0.20`) in v2 and Net Amount = Amount + Fee. Examples: Bitcoin Buy Amount `-$4.90`, Fee `-$0.10`, Net `-$5.00`; Bitcoin Sell Amount `$10.00`, Fee `-$0.20`, Net `$9.80`. Account Notifications rows: Amount `$0.00`, Fee empty.
- Currency: `USD` only in all files.
- Asset Type: ticker (`BTC`, `TGT`, `WFC`) for investing rows; Asset Price `$133.40`; Asset Amount decimal quantity `0.07496`.
- Account: funding/destination label: v1 `Your Cash`, `Visa Debit 7950`; v2 `Cash Balance`, `Visa debit 3333` (lowercase d), bank name like `WELLS FARGO BANK`.

### 2.4 Type / Status values

v1 (2024-01 to 2024-08 file): (Type, Status)
- `Sent P2P` / `PAYMENT SENT` (negative)
- `Received P2P` / `PAYMENT DEPOSITED` (positive)
- `Sent P2P` / `PAYMENT REVERSED` (positive amount, refund of a sent payment)
- `Cash Card Debit` / `CARD CHARGED` (card purchase, Notes = merchant descriptor like `GRAND VALLEY PAR`, Account = `Visa Debit NNNN`)
- `ATM Withdrawal` / `CARD CHARGED`
- `Direct Deposit` / `CARD CHARGED` (seen with negative `-$28` and Notes `CAPITAL ONE MOBILE PMT`, so this type covers ACH debits too)
- empty Type / `CARD CHARGED` (both signs, e.g. `$149`)
- BittyTax v1 also handles: `Cash in`, `Cash out`, `Boost Payment`, `Bitcoin Buy`, `Bitcoin Boost`, `Bitcoin Withdrawal`, and Received P2P with negative amount = "PAYMENT REFUNDED".

v2 (2024-10 and 2026-06 files): Status mostly `COMPLETE`, also `FAILED` (skip; BittyTax skips FAILED).
- `P2P` (both directions; Notes like `$10 Payment From tyson combs` / `$5 Payment To tyson combs`; Account can be a bank when funded externally)
- `Deposits` (Notes `Add Cash`, Account = debit card), `Withdrawal` (Notes `Cash Out`)
- `Savings Internal Transfer` (Notes `Savings`, negative = to savings)
- `Stock Buy`, `Stock Dividends`, empty Type for stock sales (Notes `$10 Sale of Wells Fargo`)
- `Bitcoin Buy`, `Bitcoin Sell` (fees here)
- `Account Notifications` ($0.00, Notes `New device login`; skip)
- Card purchase, refund, direct deposit and instant-deposit-fee row shapes in v2: UNVERIFIED (not present in sampled files).

## 3. PayPal activity download CSV

### 3.1 Export steps (official)

Source: https://www.paypal.com/us/cshelp/article/how-do-i-view-and-download-statements-and-reports-help145 (fetched 2026-11-04)
- "Go to History. Click the Download icon. Click Custom. Select the report that is most suitable for you. Follow the prompts to create and generate your report. When the report is ready, click Download."
- Monthly statements: paypal.com/reports/accountStatements > Request > Download.
- "up to the past seven years as a PDF, Quicken, QuickBooks, CSV, or TAB file. Your request can include up to 12 months of activity at a time." Large logs can take up to 5 business days, emailed; last 3 large logs saved.
- Older UI (third-party): Activity > All Reports > Activity download, transaction type dropdown default "Balance affecting", alternative "All transactions"; large files at paypal.com/reports/dlog. https://til.secretgeek.net/paypal/download_custom_daterange.html (undated). Current label wording of the type dropdown: UNVERIFIED.

### 3.2 Official column spec

Source: PayPal developer docs, Activity download report https://developer.paypal.com/reports/activity-download
- Encoding UTF-8. CSV and TAB capped at 50,000 records per file; larger split and zipped.
- Mandatory columns: Date, Time, TimeZone, Name, Type, Status, Currency, Gross, Fee, Net, From Email Address, To Email Address, Transaction ID, Reference Txn ID, Receipt ID.
- Default-on (removable): Address Status, Item Title, Item ID, Shipping and Handling Amount, Insurance Amount, Sales Tax, Option 1 Name, Option 1 Value, Option 2 Name, Option 2 Value, Invoice Number Text, Custom Number, Quantity, Balance, address fields, Contact Phone Number, Subject, Note, Country Code, Balance Impact, Invoice Number.
- User can toggle fields ("Customize report fields"), so column SET and COUNT vary per user. Map by header name, never by position.
- Full positional order in docs: Date, Time, TimeZone, Name, Type, Status, Currency, Gross, Fee, Net, From Email Address, To Email Address, Transaction ID, CounterParty Status, Shipping Address, Address Status, Item Title, Item ID, Shipping and Handling Amount, Insurance Amount, Sales Tax, Option 1 Name, Option 1 Value, Option 2 Name, Option 2 Value, Auction Site, Buyer ID, Item URL, Closing Date, Escrow ID, Reference Txn ID, Invoice Number Text, Custom Number, Quantity, Receipt ID, Balance, Address Line 1, Address Line 2 / District / Neighborhood, Town/City, State / Province / Region / Territory / Prefecture / Republic, Zip/Postal Code, Contact Phone Number, Subject, Note, Payment Source, Card Type, Transaction Event Code, Payment Tracking ID, Bank Reference ID, Transaction Buyer Country Code, Item Details, Coupons, Special Offers, Loyalty Card Number, Authorization Review Status, Protection Eligibility, Country Code, Balance Impact, Buyer Wallet, Comment 1, Comment 2, Invoice Number, PO Number, Customer Reference Number, Payflow Transaction ID (PNREF), Tip, Discount, SellerID, Risk Filter, Tax ID Type, Tax ID, Number of Installments, Installment Amount, Installment Fee, Credit Transactional Fee, Credit Promotional Fee, Credit Term, Credit Offer Type, Original Invoice ID, Campaign Fee, Campaign Name, Campaign Discount, Campaign Discount Currency, Payment Source Subtype, Decline Code, Fastlane Checkout Transaction.
- NOTE: docs spell some names differently from real files (docs `Address Line 2 / District / Neighborhood` with spaces, real files `Address Line 2/District/Neighborhood`; docs `SellerID`, real `Seller ID`; docs state field without `County`, real `State/Province/Region/County/Territory/Prefecture/Republic`). Trust real files for spelling.
- Date: "localized completion date", US accounts MM/DD/YYYY. Time `HH:MM:SS`. TimeZone: zone of date/time. Gross/Fee/Net "localized" amounts; Currency ISO-4217; Balance "in the transaction currency".
- Balance Impact: "`Debit`, `Credit`, or `Memo`. Cannot be blank."

### 3.3 Real header rows seen (default fields, with variation)

A. 41-col default (2018 hledger sample; 2023 coco2023 file; 2026 South Africa file; reckon fixture). Sources: https://github.com/hledgerorg/hledger/blob/master/examples/csv/other/paypal-2018.csv.rules , https://github.com/coco2023/shopV2-backend/blob/main/doc/PayPal/Download.CSV , https://github.com/philipdc/bookstage/blob/main/books/4-EN-SOUTH-AFRICA-GENERIC/Bank%20Statements/paypal/paypal2mar.CSV , https://github.com/cantino/reckon/blob/master/spec/data_fixtures/bom_utf8_file.csv
```
"Date","Time","TimeZone","Name","Type","Status","Currency","Gross","Fee","Net","From Email Address","To Email Address","Transaction ID","Shipping Address","Address Status","Item Title","Item ID","Shipping and Handling Amount","Insurance Amount","Sales Tax","Option 1 Name","Option 1 Value","Option 2 Name","Option 2 Value","Reference Txn ID","Invoice Number","Custom Number","Quantity","Receipt ID","Balance","Address Line 1","Address Line 2/District/Neighborhood","Town/City","State/Province/Region/County/Territory/Prefecture/Republic","Zip/Postal Code","Country","Contact Phone Number","Subject","Note","Country Code","Balance Impact"
```
B. 39-col (2025 Thailand-zone personal account, no email columns): https://github.com/Kezlo98/Portfolio/blob/main/data/paypal.CSV
```
Date,Time,TimeZone,Name,Type,Status,Currency,Gross,Fee,Net,Transaction ID,Shipping Address,Address Status,Item Title,Item ID,Shipping and Handling Amount,Insurance Amount,Sales Tax,Option 1 Name,Option 1 Value,Option 2 Name,Option 2 Value,Reference Txn ID,Invoice Number,Custom Number,Quantity,Receipt ID,Balance,Address Line 1,Address Line 2/District/Neighborhood,Town/City,State/Province/Region/County/Territory/Prefecture/Republic,Zip/Postal Code,Country,Contact Phone Number,Subject,Note,Country Code,Balance Impact
```
C. 68-col "all fields" (2022 business, fixture with real shape): https://github.com/nozzlegear/foxy-balance/blob/master/assets/paypal-transaction-activity.csv . Starts like A but inserts `CounterParty Status` after Transaction ID and `Escrow Id` before Reference Txn ID, and after Note adds: Payment Source, Card Type, Transaction Event Code, Payment Tracking ID, Bank Reference ID, Transaction Buyer Country Code, Item Details, Country Code, Balance Impact, Buyer Wallet, Comment 1, Comment 2, Invoice Number_2, PO Number, Customer Reference Number, Payflow Transaction ID (PNREF), Tip, Discount, Seller ID, Risk Filter, Credit Transactional Fee, Credit Promotional Fee, Credit Term, Credit Offer Type, Original Invoice ID, Payment Source Subtype, Decline Code. Note duplicate-name handling: second Invoice Number appears as `Invoice Number_2` in that file (may be the fixture author's rename) UNVERIFIED.
D. 37-col variant (fixture, EU locale): https://github.com/andreoliwa/bank-csv-rs/blob/main/tests/fixtures/paypal_current.csv : `...,Receipt ID,Balance,Address Status,Address Line 1,Address Line 2,Town/City,...,Contact Phone Number,Balance Impact` (no Shipping Address, Subject, Note, Country Code). Fixture, partly synthetic.

Localized headers: exports from non-English profiles translate header names (German `Datum`, `Uhrzeit`/`Zeit`, French `Heure`, Italian `Orario`); Banana Accounting importer detects language by the Time column name and also handles `;` separator. Source: https://github.com/BananaAccounting/Universal/blob/master/extensions/import/paypal/ch.banana.uni.import.paypal.js . Banana comment: "Starting Nov 2016 BalanceImpact field is no more available for download on the new version of Paypal But it is possible to select only transactions with balance Impact" (it is back in all post-2018 files above).

### 3.4 Preamble, encoding, line endings
- No preamble or footer: header is line 1, data follows, no totals row.
- UTF-8 BOM present in 3 of 6 files (2023 coco, 2026 ZA, reckon fixture: bytes `EF BB BF`). Absent in 2025 Kezlo and 2022 foxy-balance (may have been stripped by the committer). Treat BOM as optional; strip it.
- Quoting: some files quote every field (`"Date","Time",...`), others quote nothing except where needed. Both occur in real downloads (A vs B).
- CRLF in 2025 Kezlo file; LF in others (git normalization possible) UNVERIFIED for raw.
- No embedded newlines seen in sampled rows; Item Title can contain commas and `$` (hledger sample `"MONTHLY - $1 for the first 2 Months: ... then $6.99 / Month"`).
- Downloaded filename: `Download.CSV` (uppercase extension), seen across repos.

### 3.5 Date, time, amount formats
- Date localized by account country: US `MM/DD/YYYY` padded in 2022-2025 files (`01/05/2022`), but 2018 hledger sample unpadded `1/1/2018` (rules use `%-m/%-d/%Y`). South Africa 2026 file `2026/03/02` (YYYY/MM/DD). EU fixture `15/01/2024` (DD/MM/YYYY). Converter must take the date format as a parameter or sniff it.
- Time `HH:MM:SS` 24h, sometimes unpadded hour (`2:18:17` in 2023 coco file).
- TimeZone: abbreviation of the account's zone: `PST`/`PDT` (US), `ICT` (Thailand), `CET`/`CEST`. Abbreviation to offset map required; DST abbreviation flips per row.
- Gross/Fee/Net/Balance: plain numbers, no currency symbol, minus sign for negatives, thousands separator comma in US locale: `1,234.00`, `-233.00`, `6,364.62`. EU locale: `-1.227,95`, `0,00`. Integer without decimals seen once (`1` in 2023 coco file, may be hand-edited) UNVERIFIED.
- Fee is negative (`-0.52`, `-233.00`) and Net = Gross + Fee (e.g. 1 + -0.52 = 0.48; 6.00 + -0.58 = 5.42). Fee `0.00` on outgoing payments.
- Sign: Gross negative = money out (Balance Impact `Debit`), positive = in (`Credit`).
- Balance: running balance per currency after the row (blank or `0.00` for some rows).

### 3.6 Type / Status values and how events appear

Observed in real files: `Express Checkout Payment`, `Website Payment`, `Subscription Payment`, `PreApproved Payment Bill User Payment`, `Mass Pay Payment`, `General Currency Conversion`, `Account Hold for Open Authorization`, `Reversal of General Account Hold`. Status: `Completed`, `Pending` (hold rows). EU fixture uses Status `-` and Type `Shopping` (fixture, UNVERIFIED).
From AxCrypt classifier (real business usage): https://github.com/axcrypt/AxCrypt-Net/blob/master/shared/AxCrypt.Reports/Model/Csv/PayPalTransactionCsvConverterExtensions.cs : `Website Payment`, `Payment Refund`, `Chargeback`, `Subscription Payment`, `General Payment`, `Payment Reversal`, `Hold on Balance for Dispute Investigation`, `Cancellation of Hold for Dispute Resolution`, `General Withdrawal`, `General Currency Conversion`, `Shopping Cart Item`, `Mobile Payment`, `Express Checkout Payment`, `Payment Review Hold`, `Payment Review Release`, `PreApproved Payment Bill User Payment`, `General Account Correction`, `General Credit Card Deposit`, `Chargeback Fee`, `Order`, `General Authorization`, `Account Hold for Open Authorization`, `Reversal of General Account Hold`. Balance Impact values `Debit`, `Credit`, `Memo`.
hledger rules also mention `Update to ...`, `Temporary Hold`, `Add Funds from a Bank Account` (2017), `Bank Deposit to PP Account` (2018, status Pending), `Donation Received`, `Recurring Payment Received`.

How events appear:
- Fees: NOT separate rows; Fee column on the payment row (negative). Chargeback Fee is its own Type.
- Refunds: `Payment Refund` row, Reference Txn ID points to original. Sign of Gross/Fee on refunds (fee partially returned?) UNVERIFIED.
- Withdrawals to bank: `General Withdrawal` (negative, Debit). Bank top-ups: `General Credit Card Deposit` / `Bank Deposit to PP Account`.
- Currency conversion: a purchase in foreign currency produces 3 rows with the same Date/Time: payment row in the foreign currency (Kezlo 2025: `Express Checkout Payment`, USD, `-2.12`, Debit, Balance `-2.12`), then two `General Currency Conversion` rows sharing a Reference Txn ID: one in home currency (AUD `-3.52`, Debit, Balance `45.85`) and one in foreign currency (USD `2.12`, Credit, Balance `0.00`). Net effect: foreign-currency balance nets to 0, home balance drops. Converter should pair them by Reference Txn ID + timestamp, and book the payment at the home-currency amount.
- Holds: `Account Hold for Open Authorization` / `Pending` / Debit `-1.58`, later `Reversal of General Account Hold` / `Completed` / Credit `1.58`. Net zero; skip both or pair.
- Memo rows (Balance Impact `Memo`, e.g. `Shopping Cart Item`, authorizations) carry amounts but do not change balance; exclude from ledger. This is the main difference between "All transactions" and "Balance affecting" downloads: Balance affecting omits Memo/non-balance rows (developer docs on statements: only "balance-affecting transactions that debit or credit" the account; excludes uncaptured authorizations, pending e-checks, unresolved disputes): https://developer.paypal.com/docs/reports/online-reports/monthly-statement . Exact row-level diff between the two downloads: UNVERIFIED.
- Transaction Event Code column (optional) gives T-codes, e.g. `T0006` (Express Checkout) and `T0007` (Website Payment) in the foxy-balance file; more reliable than Type text if present.

## 4. Gumroad CSVs (sales export and payout export)

Gumroad's production app is open source (antiwork/gumroad), so headers below come from the actual exporter code, cross-checked with a real export file.

### 4.1 Export steps (official help, rendered from repo)
- Sales CSV: Sales tab (or Analytics) > Export icon > choose Date Range > Download; filter icon to restrict to one product. "If the CSV is not immediately available for download, it will be emailed to you." Source: https://gumroad.com/help/article/74-the-analytics-dashboard (content at https://github.com/antiwork/gumroad/blob/main/app/views/help_center/articles/contents/_74-the-analytics-dashboard.html.erb )
- Code: exports of up to 2,000 purchases are synchronous, larger ones are built async in chunks and emailed (`SYNCHRONOUS_EXPORT_THRESHOLD = 2_000`). Date filters are UTC days by default (end date inclusive since 2026-10-14). Filename `Sales<timestamp>-<random>.csv`, e.g. `Sales20260418-221956-dnla9z.csv`.
- Payout CSV: Payouts page; "You can export a CSV of each payout after it has been paid. Click the download button next to the payout period and the CSV will be sent via email. Multiple payout reports can now be downloaded from the top-right download button." Payouts page is UTC. Source: https://github.com/antiwork/gumroad/blob/main/app/views/help_center/articles/contents/_269-balance-page.html.erb (live: https://gumroad.com/help/article/269-balance-page )
- Help page warns: dashboard uses seller local time zone, CSV uses UTC; add a 1-day buffer.

### 4.2 Sales CSV header

Source code: https://github.com/antiwork/gumroad/blob/main/app/services/exports/purchase_export_service.rb (PURCHASE_FIELDS)

Current (since 2026-07-25), 72 columns, then one column per seller-defined custom field name appended at the end:
```
Purchase ID,Item Name,Buyer Name,Purchase Email,Buyer Email,Do not contact?,Purchase Date,Purchase Time (UTC timezone),Subtotal ($),Taxes ($),Tax Type,Shipping ($),Sale Price ($),Fees ($),Net Total ($),Tip ($),Tax Included in Price?,Street Address,City,Zip Code,State,Country,Referrer,Refunded?,Partial Refund ($),Fully Refunded?,Disputed?,Dispute Won?,Access Revoked?,Variants,Discount Code,Recurring Charge?,Free trial purchase?,Pre-order authorization?,Product ID,Order Number,Pre-order authorization time (UTC timezone),Custom Fields,Item Price ($),Variants Price ($),Giftee Email,SKU ID,Quantity,Recurrence,Affiliate,Affiliate commission ($),Discover?,Cancellation Date,Subscription End Date,Rating,Review,License Key,License Key Activation Count,License Key Enabled?,Payment Type,PayPal Transaction ID,PayPal Fee Amount,PayPal Fee Currency,Stripe Transaction ID,Stripe Fee Amount,Stripe Fee Currency,Purchasing Power Parity Discounted?,Upsold?,Sent Abandoned Cart Email?,UTM Source,UTM Medium,UTM Campaign,UTM Term,UTM Content,Buyer Currency,Buyer Total,Buyer Refunded Total
```
Real export confirming the 69-column pre-2026-07 form (identical minus the last 3 Buyer columns), exported 2026-04-18: https://github.com/abenjelloun1989/mini-on-ai/blob/main/Sales20260418-221956-dnla9z.csv . A 72-column file also exists at https://github.com/alanjones2/alanjones2.github.io/blob/main/apps/gumroadstats/sales.csv but looks synthetic (fake charge IDs), structure-only evidence.

Variants by date (from git history of that file, https://github.com/antiwork/gumroad/commits/main/app/services/exports/purchase_export_service.rb ; repo history starts 2025-04-03, earlier years UNVERIFIED):
- 2025-06-13 added `Access Revoked?`; 2025-06-23 added `Tax Type`; 2025-07-18 added `License Key Activation Count`; 2025-11-13 added `License Key Enabled?` (after License Key Activation Count); 2026-01-05 formula-injection sanitizing; 2026-03-03 added `Cancellation Date` (before Subscription End Date); 2026-07-25 added `Buyer Currency`, `Buyer Total`, `Buyer Refunded Total` at end.
- A mid-2025 snapshot (shakacode/gumroad-old fork) has 66 columns: no License Key Enabled?, no Cancellation Date, no Buyer columns: https://github.com/shakacode/gumroad-old/blob/main/app/services/exports/purchase_export_service.rb
- Pre-2025 exports likely lack Tax Type, Access Revoked?, License Key Activation Count UNVERIFIED (no older file found). Help article still lists `In-App Purchase?` which is not in current code (stale doc or older column) UNVERIFIED.
- Map by name; custom-field columns are appended after the fixed ones, so column count varies per seller.

Structure:
- Header line 1, no preamble. Last row is a totals row: first cell `Totals`, sums in Subtotal ($), Taxes ($), Shipping ($), Sale Price ($), Fees ($), Net Total ($), Tip ($), Partial Refund ($), Variants Price ($), Item Price ($), Affiliate commission ($), PayPal Fee Amount, Stripe Fee Amount; other cells empty. Must be skipped.
- UTF-8, no BOM (real file starts `Pur`; code opens tempfile UTF-8, payout code comment confirms "this export is UTF-8 without a BOM"). LF line endings (Ruby CSV default; real file 0 CR). Item names contain non-ASCII (em dash seen in real file). Review text may contain commas/newlines (quoted by Ruby CSV).
- Formula-injection guard (since 2026-01-05): string cells starting with `=`, `@`, `|`, `%`, tab, CR, or `+`/`-` followed by non-numeric text are prefixed with `'`. Numeric values untouched. Source: https://github.com/antiwork/gumroad/blob/main/lib/utilities/csv_safe.rb . Strip a leading `'` from text fields.

Field formats (real 2026 file):
- Purchase ID: base64-like `uzP3CtDgIjQBvzHZDVBd2Q==`. Order Number: numeric `248987265`.
- Purchase Date `YYYY-MM-DD` (UTC date). Purchase Time (UTC timezone) `2026-03-20 02:43:16 +0000`.
- Money columns: plain decimals, no symbol, no thousands separator, Ruby float formatting: `0.0`, `19.0`, `1.71`, `15.75`; synthetic file shows integers like `16`. Treat as generic decimal strings. All `($)` columns are USD regardless of buyer currency; buyer-currency columns only populated for sales charged in buyer currency.
- Flags are `0`/`1`. Custom Fields is a Ruby hash string like `{}`.
- Net Total ($) = Sale Price ($) - Fees ($) (help page: "Your take-home pay (sale price - Gumroad's fees)"). Fees positive. Taxes separate: real Totals row Sale Price 19.0, Taxes 1.71, Fees 3.25, Net 15.75.
- Refunds: NOT separate rows in sales CSV; flagged on the original row (`Refunded?`, `Fully Refunded?`, `Partial Refund ($)` amount). Chargebacks: `Disputed?`, `Dispute Won?`. Free/zero-price sales appear as rows with 0.0 amounts.
- Payment Type: `Card`, `PayPal`, `UPI`, `iDEAL`, `Bancontact`, `Pix`, `Klarna`, `Alipay`. Stripe Fee Currency lowercase ISO (`gbp`).

### 4.3 Payout CSV header

Source: https://github.com/antiwork/gumroad/blob/main/app/services/exports/payouts/csv.rb and https://github.com/antiwork/gumroad/blob/main/app/services/exports/payouts/base.rb (unchanged header since 2025-04-03 initial commit, also identical in mid-2025 fork)
```
Type,Date,Purchase ID,Item Name,Buyer Name,Buyer Email,Taxes ($),Shipping ($),Sale Price ($),Gumroad Fees ($),Net Total ($)
```
No real payout file found; formats derived from code (UNVERIFIED against a real download, but code is authoritative for the current version).
- Date: `YYYY-MM-DD` (Ruby Date#to_s). Rows sorted by date, stable.
- Type values: `Sale`, `Chargeback`, `Full Refund`, `Partial Refund`, `Failed Refund`, `Failed Refund Reversal`, `Refund fee written off`, `Credit`, `Failed Refund Fee Returned`, `Failed Refund Fee Retained`, `Affiliate Credit`, `PayPal Refund`, `Stripe Connect Refund`, `PayPal Connect Affiliate Fees`, `Stripe Connect Affiliate Fees`, `PayPal Payouts`, `Stripe Connect Payouts`, `Payout Fee`, `Technical Adjustment`.
- Signs: Sale row positive Sale Price, positive Gumroad Fees, Net = price - fee. Chargeback and Full Refund rows negate all amounts (fee negative = fee returned, unless retained fee adjusts it). `Payout Fee` row: fee positive, net negative. `PayPal Payouts` / `Stripe Connect Payouts` rows: Sale Price and Net negative (removes sales already paid out by PayPal/Stripe directly); since 2026-07-10 Item Name on those rows carries an explanatory note. `Technical Adjustment`: only Net filled.
- Footer: optional subtotal rows (since 2026-07-10) with first cell `Subtotal - activity paid out by Gumroad`, `Subtotal - PayPal sales (paid out by PayPal; nets to zero here)`, `Subtotal - Stripe Connect sales (paid out by Stripe; nets to zero here)`, then final `Totals` row. Skip all rows whose Type starts with `Subtotal` or equals `Totals`.
- Encoding: UTF-8 without BOM, invalid bytes replaced with `?`.
- Annual payout export (Exports::Payouts::Annual) uses the same header, rows from all payouts in the calendar year, one Totals row at the end.
- Payout CSV is the better source for books (has refunds/chargebacks/fees as dated rows); sales CSV is order-level with refund flags.


---

# Appendix B: Stripe, Etsy, Airbnb


Researched 2026-11-04. Read-only research; every fetched page treated as data. UNVERIFIED marks details not confirmed from a primary or concrete source.

## 1. Stripe

### 1.1 General CSV conventions (Reports: Balance, Payout reconciliation)

- Amounts in CSV reports are decimal numbers in MAJOR units ("10.00" for 10 USD), unlike the API which uses integer minor units (1000). Source: https://docs.stripe.com/reports/api (callout "CSV and API monetary formats differ"). Each column table also says gross/fee/net are "Expressed in major units of the currency (e.g. dollars for USD, yen for JPY)". Source: https://docs.stripe.com/reports/report-types/balance
- Zero-decimal currencies (JPY etc.) therefore appear with no fractional part in CSV (follows from "major units ... yen for JPY"; exact rendering e.g. "1000" vs "1000.00" UNVERIFIED).
- Optional run parameter `decimal_separator` exists on itemized types (so some files may use "," as decimal separator; default "." UNVERIFIED as a written statement, but all fixtures seen use "."). Source: https://docs.stripe.com/reports/report-types/balance (parameter table).
- No thousands separators, no currency symbols in Reports CSVs (UNVERIFIED from docs; consistent with "decimal number" wording and fixtures below).
- Timezone: report types with suffix ".itemized.3/.5/.7" (and payout_reconciliation.itemized.4/.5/.7) take a `timezone` param; columns without `_utc` are "in the requested timezone, or UTC if not provided"; `_utc` columns are always UTC. Older versions (.itemized.1/.2/.6) only have `_utc` columns. Source: https://docs.stripe.com/reports/report-types/balance and https://docs.stripe.com/reports/api ("timezone parameter is optional and defaults to UTC").
- Dashboard: reports can be viewed in the account time zone or UTC; this choice changes both the date filter and how dates are presented in the file. Date ranges inclusive full days. Source: https://docs.stripe.com/reports/options
- Datetime text format in CSV: "YYYY-MM-DD HH:MM:SS" (no T, no offset). UNVERIFIED in docs; confirm from fixtures (see 1.6).
- Column selection and ORDER are customizable (`columns` param, and in Dashboard "Customize exported columns"), so an importer must map by header name, never by position. Source: https://docs.stripe.com/reports/api ("customize the selection and ordering of columns"), https://docs.stripe.com/reports/balance
- Doc column tables are alphabetical; they are NOT the file's column order. Default order must come from real files (see 1.6).
- Reports are in settlement currency after FX conversion: "Transactions appear in your settlement currency after any required foreign currency conversion." Multiple settlement currencies are exported separately via the currency selector. Source: https://docs.stripe.com/reports/balance, https://docs.stripe.com/reports/options
- `customer_facing_amount` / `customer_facing_currency` carry the presentment (customer-side) amount when it differs. Source: https://docs.stripe.com/reports/report-types/balance
- `withheld_tax`: "Sales tax, VAT or GST withheld. This amount is already included within the fee column." Source: https://docs.stripe.com/reports/balance

### 1.2 Reports > Balance > "Balance change from activity" itemized CSV

How to export: Dashboard > Reports > Balance (https://dashboard.stripe.com/reports/balance) > section "Balance change from activity" > Export > CSV > Itemized. CSV contains only the section you exported from. The Balance summary section only gives a summary CSV. This section EXCLUDES payouts ("all transactions that affect your balance, except payouts"); payouts are in the separate "Payouts" section export. Source: https://docs.stripe.com/reports/balance

Current API type in Dashboard docs: balance_change_from_activity.itemized.7 (versions 1,2,3,6,7 documented). Source: https://docs.stripe.com/reports/report-types/balance

Default columns (alphabetical per docs, not file order):
- itemized.1: automatic_payout_effective_at, automatic_payout_id, available_on_utc, balance_transaction_id, charge_id, created_utc, currency, customer_facing_amount, customer_facing_currency, description, fee, gross, net, reporting_category, source_id
- itemized.2 and .6: available_on_utc, balance_transaction_id, created_utc, currency, description, fee, gross, net, reporting_category
- itemized.3 and .7: available_on, balance_transaction_id, created, currency, description, fee, gross, net, reporting_category
Source: https://docs.stripe.com/reports/report-types/balance

Notable optional columns (v7): application_fee, automatic_payout_effective_at(_utc), automatic_payout_id, available_on_utc, balance_type, card_brand, card_country, card_funding, card_network, charge_created(_utc), charge_id, connected_account_*, country, created_utc, customer_* (address, email, id, name, description, tax_ids), customer_facing_amount, customer_facing_currency, dispute_reason, exchange_rate, fee_net_of_withheld_tax, fee_transaction_id (v6), invoice_id, invoice_number, is_link, is_managed_payments, payment_intent_id, payment_metadata[key], payment_method_type, payout_reference_token, payout_statement_descriptor, product_ids, product_names, refund_metadata[key], regulatory_tag, shipping_address_*, source_id, statement_descriptor, subscription_id, tax_collected, tax_currency, tax_transaction_id, trace_id, trace_id_status, transfer_metadata[key], withheld_tax. Metadata columns are emitted with header like `payment_metadata[order_id]` (one per key). Dashboard itemized downloads may add "Product IDs", "Product Names", "Country". Source: https://docs.stripe.com/reports/report-types/balance, https://docs.stripe.com/reports/balance

Column semantics: gross = gross amount; fee = fees paid; net = net amount (net = gross - fee, implied; arithmetic identity UNVERIFIED as stated text). created(_utc) = when the balance transaction was created; available_on(_utc) = when net funds become available. Source: https://docs.stripe.com/reports/report-types/balance

Sign convention (from reporting-category semantics; explicit "negative" wording not on the report page): credits to balance positive (charge, dispute_reversal, refund_failure, payout_reversal, topup, fee_credit_funding "positive amount"), debits negative (refund, dispute, payout, transfer, fee, tax). Fee column is a positive number subtracted from gross on charge rows (UNVERIFIED in docs; see fixtures in 1.6). Source for category meaning: https://docs.stripe.com/reports/reporting-categories

### 1.3 Reports > Balance > "Payouts" itemized CSV (payouts.itemized.*)

Default columns:
- payouts.itemized.1: balance_transaction_id, currency, description, effective_at_utc, fee, gross, net, payout_description, payout_destination_id, payout_expected_arrival_date, payout_id, payout_reversed_at, payout_status, payout_type, reporting_category
- payouts.itemized.2 and .4: balance_transaction_id, currency, description, effective_at_utc, fee, gross, net, payout_expected_arrival_date, payout_id, payout_status, reporting_category
- payouts.itemized.3 and .5: same with effective_at instead of effective_at_utc
Optional: application_fee, effective_at_utc, payout_description, payout_destination_id, payout_reversed_at(_utc), payout_type, regulatory_tag, trace_id, trace_id_status.
Semantics: effective_at = expected arrival date (automatic) or initiation date (manual), the date funds leave the Stripe balance. payout_status in {paid, pending, in_transit, canceled, failed}. payout_type in {bank_account, card}. payout_reversed_at set only if canceled/failed. reporting_category here is payout or payout_reversal. Source: https://docs.stripe.com/reports/report-types/balance, https://docs.stripe.com/reports/balance
The Balance report "doesn't associate payouts with payment transactions". Source: https://docs.stripe.com/reports/balance

### 1.4 Reports > Payout reconciliation itemized CSV

How to export: Dashboard > Reports > Payout reconciliation (https://dashboard.stripe.com/reports/reconciliation) > choose date range containing payout's ESTIMATED ARRIVAL date > "Payout reconciliation" section > Download > Itemized (CSV). Sections: Balance summary, Payout reconciliation, Failed payouts (only if any), Ending balance reconciliation (transactions not yet settled as of end date). Only for automatic payouts; instant payouts cannot be attributed. Source: https://docs.stripe.com/reports/payout-reconciliation

Default columns:
- payout_reconciliation.itemized.1 and payout_reconciliation.by_id.itemized.1: automatic_payout_effective_at, automatic_payout_id, available_on_utc, balance_transaction_id, charge_id, created_utc, currency, customer_facing_amount, customer_facing_currency, description, fee, gross, net, reporting_category, source_id
- .itemized.2, .3, .6: available_on_utc, balance_transaction_id, created_utc, currency, description, fee, gross, net, reporting_category (automatic_payout_id optional!)
- .itemized.4: available_on, balance_transaction_id, created, currency, description, fee, gross, net, reporting_category
- .itemized.5 and .7: automatic_payout_effective_at, automatic_payout_id, available_on, balance_transaction_id, created, currency, description, fee, gross, net, reporting_category
- failed_payouts.itemized.1/2 adds retried_payout_id. ending_balance_reconciliation.itemized.1..4 similar sets.
- Summary types (payout_reconciliation.summary.*, *.summary.*): count, currency, fee, gross, net, reporting_category. balance.summary.*: category, currency, description, net_amount (category in starting_balance, ending_balance, activity, payouts; description like "Starting balance (YYYY-MM-DD)", "Activity", "Total payouts", "Ending balance (YYYY-MM-DD)").
Source: https://docs.stripe.com/reports/report-types/payout-reconciliation, https://docs.stripe.com/reports/payout-reconciliation

Payout linkage: every row carries automatic_payout_id (po_...) and automatic_payout_effective_at = expected arrival date in bank and the moment funds are deducted from balance. Group rows by automatic_payout_id; sum(net) per payout = payout amount (UNVERIFIED as explicit statement; this is the report's stated purpose: "match the payouts you receive in your bank account with the batches of ... transactions"). The payout itself does not appear as a row in the itemized payout reconciliation (UNVERIFIED). Source: https://docs.stripe.com/reports/payout-reconciliation

### 1.5 reporting_category values (complete list from docs)

Source: https://docs.stripe.com/reports/reporting-categories
Type to category mapping: charge,payment -> charge; refund,payment_refund -> refund; payout_cancel,payout_failure -> payout_reversal; transfer,recipient_transfer -> transfer; transfer_cancel,transfer_failure,recipient_transfer_cancel,recipient_transfer_failure -> transfer_reversal; application_fee -> platform_earning; application_fee_refund -> platform_earning_refund; stripe_fee -> fee; reserve_transaction -> connect_reserved_funds; reserved_funds -> risk_reserved_funds. type=adjustment splits into dispute, dispute_reversal, refund_failure, other_adjustment, fee.

Payments: charge (types charge, payment, validation), charge_failure (payment_failure_refund; async methods failing after pending charge), dispute (adjustment or adjusted_for_overdraft_transaction; "Stripe deducts the disputed amount"), dispute_reversal (won dispute, amount returned), partial_capture_reversal (type refund; uncaptured portion; sum with charge = captured amount), refund (refund, payment_refund), refund_failure (funds returned to balance).
Balance: anticipation_repayment, climate_order_purchase, climate_order_refund, contribution, currency_conversion ("Adjustment to your Stripe balance related to currency conversion"), fee ("Fees for Stripe software and services", e.g. Radar, Connect, Billing, Identity; separate from per-charge processing fees, which sit in the fee column of the charge row), other_adjustment, payment_network_reserve_hold, payment_network_reserve_release, payout, payout_minimum_balance_hold, payout_minimum_balance_release, payout_reversal, revenue_share, reward, risk_reserved_funds (two rows: debit then credit at end of reserve), stripe_balance_payment_debit, stripe_balance_payment_debit_reversal, tax (tax_fee; "Typically, this is a tax on Stripe fees"), tax_fund, tax_withholding, topup, topup_reversal, unreconciled_customer_funds.
Issuing: issuing_authorization_hold, issuing_authorization_release, issuing_disbursement, issuing_dispute, issuing_dispute_fraud_liability_debit, issuing_dispute_provisional_credit, issuing_dispute_provisional_credit_reversal, issuing_transaction.
Connect: advance, advance_funding, connect_collection_transfer, connect_reserved_funds, platform_earning, platform_earning_refund, transfer, transfer_reversal.
Fee credits: fee_credit_funding ("positive amount").

### 1.6 Real header rows and sample rows from public fixtures (Reports CSVs)

Note on order: these show the order real files use. Order differs by report version and by any column customization, so map by name.

(a) hledger example, "Balance change from activity" default fields (itemized v1/v2 era, all fields double-quoted):
```
"balance_transaction_id","created_utc","available_on_utc","currency","gross","fee","net","reporting_category","description"
"txn_14G11HjubSIHf9IKrvJdwN","2020-01-23 08:26:29","2020-01-27 00:00:00","usd","12.00","0.00","12.00","charge",
"txn_14G11HjHgubIH9ZvbPgYO7","2020-01-23 08:26:31","2020-01-27 00:00:00","usd","-0.77","0.00","-0.77","refund","REFUND FOR PAYMENT"
```
Source: https://raw.githubusercontent.com/hledgerorg/hledger/HEAD/examples/csv/other/stripe.csv
hledger rules comment: "Stripe \"Balance change from activity\" CSV, default fields", date-format `%Y-%m-%d %H:%M:%S`, and "negative means leaving my account, in all amount fields"; postings are net to Stripe asset, -gross to counterparty, -fee to fees, which only balances if net = gross - fee with fee positive on charges. Source: https://raw.githubusercontent.com/hledgerorg/hledger/HEAD/examples/csv/other/stripe.csv.rules

(b) BananaAccounting importer test case, Balance change from activity itemized with automatic payout columns appended (real export, anonymized; currency codes obfuscated to "tes"):
```
"balance_transaction_id","created","available_on","currency","gross","fee","net","reporting_category","description","automatic_payout_id","automatic_payout_effective_at"
"txn_1Noh05Kh5QAlWt1C76QBqatA","2023-09-10 08:20:04","2023-10-13 02:00:00","tes","0.65","0.00","0.65","risk_reserved_funds","Reserved Funds","po_1Nzr7YKh5QAlWt1CBKvGMVAL","2023-10-16 02:00:00"
```
Note "02:00:00" on available_on and payout date: non-UTC version (no _utc suffix) rendered in account timezone (Europe), so midnight UTC shows as 02:00. Source: https://raw.githubusercontent.com/BananaAccounting/Universal/HEAD/extensions/import/stripe/test/testcases/ch.banana.filter.import.stripe.balance_summary_format1_20231010.csv
2025 variant (all columns selected):
```
"automatic_payout_id","automatic_payout_effective_at","balance_transaction_id","created","available_on","currency","gross","fee","net","reporting_category","description","customer_email","customer_name","order_id","invoice_id","invoice_number","subscription_id","statement_descriptor"
"po_1Qe4AXA0IpYVNU1u4vYVbjHd","2025-01-07 00:00:00","txn_3QcrImA0IpYVNU1u0wNC3kOh","2025-01-02 16:31:18","2025-01-07 00:00:00","chf","102.00","2.95","99.05","charge","Gutschein","info@hotmail.com","User1",,,,,
```
Empty values are unquoted (`,,`) even when other fields are quoted. Source: https://raw.githubusercontent.com/BananaAccounting/Universal/HEAD/extensions/import/stripe/test/testcases/ch.banana.filter.import.stripe..balance_summary_format1_20250102.csv
Banana README export steps: "Report->Summary Balance->Balance change from activity-> Download", "Report format: Itemized", "Columns: All columns". Source: https://raw.githubusercontent.com/BananaAccounting/Universal/HEAD/extensions/import/stripe/readme.md

(c) Artconomy (production app) test fixture of balance_change_from_activity via API with custom columns:
```
balance_transaction_id,created_utc,available_on_utc,reporting_category,gross,currency,description
txn_beep,2025-03-27 09:01:06,2025-03-27 09:01:06,fee,-0.08,usd,Radar (2025-03-26): Radar for Fraud Teams
txn_boop,2025-03-27 11:34:37,2025-03-27 11:34:37,transfer,-113.25,usd,
txn_foo,2025-03-27 19:09:17,2025-03-31 00:00:00,charge,80,usd,
```
Shows: unquoted API download; amount may lack decimals ("80") (UNVERIFIED whether Stripe ever emits "80" vs "80.00"; fixture may be hand-trimmed); fee category rows have negative gross with description like "Radar (YYYY-MM-DD): ..."; transfer rows negative. Source: https://raw.githubusercontent.com/Kelketek/artconomy/HEAD/backend/apps/sales/views/tests/fixtures/stripe_fixtures.py

(d) Wikimedia SmashPig (production fundraising code) settlement report fixture = payout_reconciliation itemized with metadata columns:
```
balance_transaction_id,payment_metadata[external_identifier],...,source_id,payment_intent_id,charge_id,created,available_on,automatic_payout_effective_at,currency,gross,fee,net,reporting_category,payment_method_type,card_brand,card_country,card_funding,description,trace_id_status,gateway_account,automatic_payout_id,customer_facing_amount,customer_facing_currency
txn_001,24315.1,,,,,ch_123,pi_123,ch_123,2026-01-30 10:11:12,2026-01-30 00:00:00,2026-01-31 00:00:00,USD,25,0.95,24.05,charge,card,visa,US,credit,,pending,acct_live,po_test123,25,usd
txn_rfnd_002,...,re_123,pi_123,ch_123,...,USD,-10,0,-10,refund,...,po_test123,-10,usd
txn_fee_01,...,USD,-0.5,0,-0.5,fee,,,,,Card payments (2026-03-24): Transaction network costs,,,po_test123,"",
```
("gateway_account" is not a Stripe column; added by Wikimedia. Fixture is hand-edited, values like "25" and uppercase "USD" may not match real output: UNVERIFIED.) Shows: refund rows have negative gross and net, fee 0; separate fee-category rows (e.g. "Card payments (YYYY-MM-DD): Transaction network costs", "Radar (YYYY-MM-DD): Standard") are negative gross; all rows of a payout share automatic_payout_id po_... Source: https://raw.githubusercontent.com/wikimedia/wikimedia-fundraising-SmashPig/HEAD/PaymentProviders/Stripe/Tests/Data/settlement_report.csv
Dispute row example from the same project's payments_activity fixture: `...,USD,Dispute,15.00,-30.00,-45.00,...,dispute,dp_bbb,...` i.e. gross -30.00, fee 15.00 (dispute fee positive), net -45.00. Source: https://raw.githubusercontent.com/wikimedia/wikimedia-fundraising-SmashPig/HEAD/PaymentProviders/Stripe/Tests/Data/payments_activity.csv

(e) Connect "Payouts" itemized for connected accounts, real Dashboard filename `itemized_payouts_for_orgs_USD_2025-02-07_to_2025-02-16_Etc-UTC.csv`:
```
"account_id","account_name","payout_id","effective_at","currency","gross","fee","net","reporting_category","balance_transaction_id","description","payout_expected_arrival_date","payout_status"
"acct_1QpiFnGP3x5z5MHD","Verdigris Botanica","po_1QsHrDGP3x5z5MHDe62ClvIt","2025-02-14 05:54:34","usd","1364.05","0.00","1364.05","payout","txn_1QsHrDGP3x5z5MHDEc4B5eDk","","2025-02-18 00:00:00","pending"
```
Payout gross is POSITIVE here ("1364.05", reporting_category payout), unlike legacy balance history where payouts are negative (see 1.7). Sign of payout rows in the account's own payouts.itemized export: UNVERIFIED (likely positive amount paid out, treat by category not sign). No thousands separator on 1364.05. Dashboard filename embeds currency, date range and timezone ("Etc-UTC"). Source: https://raw.githubusercontent.com/Lainyshell/verdigris-nation-ledger/HEAD/itemized_payouts_for_orgs_USD_2025-02-07_to_2025-02-16_Etc-UTC.csv

(f) deanbarrow/stripe-csv-to-qbo (reads "Balance change from activity" with all columns): parses `created_utc` with `%Y-%m-%d %H:%M:%S`; strips "," from gross (`line['gross'].replace(',','')`), suggesting some downloads carry thousands separators (UNVERIFIED); treats reporting_category payout/refund/adjustment/charge; emits fee as separate negative line when fee != "0.00", and handles negative fee (`replace('--','')`, fee refunds). Columns used: created_utc, gross, fee, reporting_category, description, customer_description, customer_email, id. Source: https://raw.githubusercontent.com/deanbarrow/stripe-csv-to-qbo/HEAD/stripe2qbo.py and README https://raw.githubusercontent.com/deanbarrow/stripe-csv-to-qbo/HEAD/README.md

Encoding: no BOM seen in any fixture above (UNVERIFIED for live downloads). Line endings in live downloads UNVERIFIED. Descriptions and metadata can contain commas and JSON with doubled quotes (see 1.7 (c)), so a real CSV parser is mandatory.

### 1.7 Legacy Dashboard "Balance history" / Transactions "All activity" export (balance_history.csv)

How to export: Dashboard > Transactions > All activity > Export, choose "All columns" (Banana notes that exporting only Payments, Payouts or Top-ups gives a DIFFERENT format per option). Source: https://raw.githubusercontent.com/BananaAccounting/Universal/HEAD/extensions/import/stripe/readme.md ; Stripe support: Payouts page > Export lets you pick time zone, date range and columns: https://support.stripe.com/questions/exporting-payout-reports
Default filename: balance_history.csv (seen across several repos; UNVERIFIED as official).

Header (full "all columns" form, verbatim, seen identically in 3 independent repos):
```
id,Type,Source,Amount,Fee,Destination Platform Fee,Destination Platform Fee Currency,Net,Currency,Created (UTC),Available On (UTC),Description,Customer Facing Amount,Customer Facing Currency,Transfer,Transfer Date (UTC),Transfer Group
```
Sources: https://raw.githubusercontent.com/onyedikachi-david/my-algora-stripe-payments/HEAD/src/data/balance_history.csv , https://raw.githubusercontent.com/MalesForFemalesLLC22/solid-dependency/HEAD/balance_history.csv , https://raw.githubusercontent.com/BananaAccounting/Universal/HEAD/extensions/import/stripe/test/testcases/ch.banana.filter.import.stripe.transactions_all_format1_20231004.csv
Minimal/default variant:
```
id,Type,Source,Amount,Fee,Net,Currency,Created (UTC),Available On (UTC)
```
Source: https://raw.githubusercontent.com/danielyoungkimball/alos.coffee/HEAD/public/balance_history.csv
Metadata columns are appended as `<key> (metadata)`, e.g. `customerEmail (metadata)`, `donorbox_campaign (metadata)`. Sources: https://raw.githubusercontent.com/giventadevelop/mcefee-temp/HEAD/code_html_template/stripe_balance_history.csv , Banana testcase above.
A variant with `Automatic Payout ID,Automatic Payout Effective At (UTC)` columns appears only in an apparently synthetic fixture (UNVERIFIED): https://raw.githubusercontent.com/Duncan-Haywood/oss-monorepo/HEAD/ventures/ai-bookkeeper/fixtures/stripe-balance-transactions.csv

Sample rows (real):
```
txn_1QXulUQ5ilbrL7smfZYUegjY,payout,po_1QXulTQ5ilbrL7sm070taasc,-371784.60,0.00,,,-371784.60,ngn,2024-12-20 01:12,2024-12-24 00:00,STRIPE PAYOUT,,,po_1QXulTQ5ilbrL7sm070taasc,2024-12-24 00:00,
txn_1QXlpNQ5ilbrL7smhoSdZVHH,payment,py_1QXlpLQ5ilbrL7smrkEx7koB,371784.60,0.00,,,371784.60,ngn,2024-12-19 15:39,2024-12-23 00:00,,220.00,usd,po_1QXulTQ5ilbrL7sm070taasc,2024-12-24 00:00,
txn_1SLCHhCV3aMWmAX0U3dwAnB0,payout_failure,po_1SKq4QCV3aMWmAX0jXEQ8y6C,1.00,0.00,,,1.00,usd,2025-10-23 00:21,2025-10-23 00:21,REFUND FOR PAYOUT (STRIPE PAYOUT),,,,,
txn_3RcwGGPHRBS0GimP1wrlTF8C,charge,ch_3RcwGGPHRBS0GimP1MRNa3k6,6.60,0.50,6.10,usd,2025-06-22 22:21,2025-06-29 00:00
```
Sources: onyedikachi-david, MalesForFemalesLLC22, alos.coffee files above.

Facts from these rows:
- Type holds raw balance transaction `type` (charge, payment, payout, payout_failure, refund, adjustment, stripe_fee, reserved_funds, transfer, ...), NOT reporting_category. Map with the table in 1.5.
- Source = source object id (ch_, py_, po_, re_, ...; can be empty for reserved_funds).
- Amount = gross, signed: payouts negative, charges positive, payout_failure positive (money returned). Fee positive, Net = Amount - Fee.
- Dates "YYYY-MM-DD HH:MM" (minutes, no seconds) in UTC as the header says. Banana's matcher also accepts "." date separators: regex `^\d{2,4}[-.]\d{2}[-.]\d{2} \d{2}:\d{2}$`. Source: https://raw.githubusercontent.com/BananaAccounting/Universal/HEAD/extensions/import/stripe/ch.banana.uni.import.stripe.js
- Currency lowercase ISO ("usd", "ngn"). Customer Facing Amount/Currency give presentment amount (e.g. 220.00 usd charged, settled 371784.60 ngn): this is how currency conversion shows (no separate FX row).
- Payout linkage: `Transfer` column holds the payout id (po_...) that swept this transaction, `Transfer Date (UTC)` its date. On the payout row itself Transfer = its own po_ id. Failed payouts reverse with a payout_failure row of opposite sign and empty Transfer.
- Locale-dependent decimals: in a European account export, amounts use decimal comma and are quoted: `"-75,57","0,00",,,"-75,57",por,2023-10-04 02:14,...` and `"104,13","3,37",,,"100,76"`. Banana states "the decimal separator could be: ',' or '.' and there is no thousand divisor". Sources: Banana testcase transactions_all_format1_20231004.csv and ch.banana.uni.import.stripe.js (getDecimalSeparator) above.
- reserved_funds appear as a pair: positive (release) and negative (hold), both "0,00" fee.
- Legacy dashboard "Collected fees" (Connect application fees) export header (sample, appears synthetic): `id,Created (UTC),Amount,Amount Refunded,Currency,User ID,User Email,Application ID,Transaction ID` with decimal-comma quoted amounts. UNVERIFIED. Source: https://raw.githubusercontent.com/Kosta-Git/stripe-csv/HEAD/samples/01-fees.csv

### 1.8 Dashboard Payouts list export (Balances > Payouts > Export)

Steps (official): "on the Payouts page, click Export", then "select your preferred time zone, date range, and desired columns"; downloads a CSV of all payouts. Source: https://support.stripe.com/questions/exporting-payout-reports
Header row: UNVERIFIED. No primary or fixture source found. A third-party help page (search snippet, page now 404) listed defaults as Payout ID / id, Amount, Created (UTC), Currency, Arrival Date (UTC), Source Type, Status, Type, Method, Balance Transaction. Treat as hint only. Legacy transfers export (pre-2017, "transfers" = payouts) used columns id, Currency, Destination, Balance Transaction, Description per EP4/stripe-iiftoqbo parser (very old, UNVERIFIED for today): https://raw.githubusercontent.com/EP4/stripe-iiftoqbo/HEAD/lib/stripe-iiftoqbo.rb
Recommendation: prefer the Reports payouts.itemized CSV (1.3) whose schema is documented.

## 2. Etsy

### 2.1 How to export (official)

- Sold Orders / Sold Order Items / Etsy Payments sales / Etsy Payments deposits: "Sign into Etsy.com and go to Shop Manager." "Select Settings, then select Options." "Go to the Download Data tab." "Go to Orders." "Use the dropdown menus to select the CSV Type, Month and Year." "To download a CSV for an entire year, don't select Month." "Select Download CSV." Source: https://help.etsy.com/hc/articles/360000343328
  The help page lists no columns, date formats or timezone. Timezone of dates in all Etsy CSVs: UNVERIFIED.
- Monthly Payment account statement: "Shop Manager" > "Finances" > "Monthly statements" > "View all monthly statements" > choose year and month > "Generate CSV" > "You'll receive an email when the CSV file is ready." > "Download Now" in the email > "Download CSV". "Each statement contains all activity within your Payment account for a given month." "Any sale that isn't yet available for deposit shows when funds will be available in the Info column." Deposit = Available for deposit = "available funds, minus fees, refunds, taxes, and other activity." Source: https://help.etsy.com/hc/articles/360016389113
- Real downloaded filenames: EtsySoldOrders2025-1.csv, EtsySoldOrderItems2025-1.csv, EtsyDirectCheckoutPayments2025-1.csv (= "Etsy Payments sales"), EtsyDeposits2025-1.csv, full-year form EtsySoldOrders2025.csv; statement etsy_statement_YYYY_M.csv (M without leading zero). Sources: https://github.com/ddooxhuy09/Etsy-data-warehouse/tree/HEAD/data/raw/2025-01 , https://github.com/pqueuex/store.extantra , https://raw.githubusercontent.com/bnieco/business_analytics/HEAD/scripts/load_etsy_statements.py

### 2.2 Sold Orders CSV (EtsySoldOrders*.csv)

Header, current (2025, two independent shops, identical), verbatim incl. quoting:
```
"Sale Date","Order ID","Buyer User ID","Full Name","First Name","Last Name","Number of Items","Payment Method","Date Shipped","Street 1","Street 2","Ship City","Ship State","Ship Zipcode","Ship Country",Currency,"Order Value","Coupon Code","Coupon Details","Discount Amount","Shipping Discount",Shipping,"Sales Tax","Order Total",Status,"Card Processing Fees","Order Net","Adjusted Order Total","Adjusted Card Processing Fees","Adjusted Net Order Amount",Buyer,"Order Type","Payment Type","InPerson Discount","InPerson Location",SKU
```
Sources: https://raw.githubusercontent.com/pqueuex/store.extantra/HEAD/EtsySoldOrders2025.csv , https://raw.githubusercontent.com/ddooxhuy09/Etsy-data-warehouse/HEAD/data/raw/2025-01/EtsySoldOrders2025-1.csv
2020 variant (same 36 positions, different words, likely locale/en-GB or older naming): "Date Posted" for "Date Shipped", "Delivery City/State/Zipcode/Country" for "Ship ...", "Delivery Discount" for "Shipping Discount", "Delivery" for "Shipping", "Sales tax" and "Order total" (lowercase). Source: https://raw.githubusercontent.com/yasir-naseer-tetralogicx/Webinopoly/HEAD/public/import-orders/202009291654EtsySoldOrders2020-9.csv . Whether the switch is locale or time based: UNVERIFIED. Importer should alias these.
Sample row:
```
10/04/25,3815834288,neuivm6a,"Marina Wiley",Marina,Wiley,1,"Credit Card",,"5325 Delos Ct",,Fairfield,CA,94534,"United States",USD,35.00,COMEBACK,"% off",3.50,0.00,4.80,0,38.94,,1.42,34.88,0.00,0.00,0.00,"Marina Wiley",online,online_cc,,,
```
Facts:
- One row per order. Dates MM/DD/YY (two-digit year) for Sale Date and Date Shipped.
- Header quoting: only names containing spaces are quoted; values quoted only when needed (minimal quoting). No BOM (file starts with `"Sa`). LF line endings in the repo copies (CRLF in original download UNVERIFIED, git may normalize).
- Amounts: plain decimals, no symbol, no thousands separator in USD samples. "Sales Tax" can be "0" (integer) even when tax was charged.
- Arithmetic observed in 3 rows of the 2025 file: Order Total = Order Value - Discount Amount + Shipping + (marketplace tax collected by Etsy, NOT shown in the Sales Tax column which reads 0); Order Net = Order Total - Card Processing Fees - that hidden tax. Example: 35.00 - 3.50 + 4.80 = 36.30; Order Total 38.94 implies 2.64 tax; 38.94 - 1.42 - 2.64 = 34.88 = Order Net. Order Net does NOT subtract transaction fees, listing fees, ads, or shipping labels (those appear only in the monthly statement). Derived from https://raw.githubusercontent.com/pqueuex/store.extantra/HEAD/EtsySoldOrders2025.csv (interpretation that the gap is marketplace sales tax: UNVERIFIED but consistent across rows).
- Refunds: reflected in Adjusted Order Total / Adjusted Card Processing Fees / Adjusted Net Order Amount (0.00 when no adjustment). Exact semantics UNVERIFIED.
- Payment Type values seen: online_cc (also online_pp in older items file). Order Type: online. Payment Method: "Credit Card".
- Currency = shop listing currency.
- Caution: the ddooxhuy09 copy has implausible fee/net values (data altered); use only for headers.

### 2.3 Sold Order Items CSV (EtsySoldOrderItems*.csv)

Header, current (2023 and 2025 identical):
```
"Sale Date","Item Name",Buyer,Quantity,Price,"Coupon Code","Coupon Details","Discount Amount","Shipping Discount","Order Shipping","Order Sales Tax","Item Total",Currency,"Transaction ID","Listing ID","Date Paid","Date Shipped","Ship Name","Ship Address1","Ship Address2","Ship City","Ship State","Ship Zipcode","Ship Country","Order ID",Variations,"Order Type","Listings Type","Payment Type","InPerson Discount","InPerson Location","VAT Paid by Buyer",SKU
```
Sources: https://raw.githubusercontent.com/sarahhe05/Starry-Sticker-Shop-Analysis/HEAD/data%20files/EtsySoldOrderItems2023.csv , https://raw.githubusercontent.com/ddooxhuy09/Etsy-data-warehouse/HEAD/data/raw/2025-01/EtsySoldOrderItems2025-1.csv
2017 variant: "Coupon Discount" instead of "Discount Amount","Shipping Discount"; no SKU column. Source: https://raw.githubusercontent.com/ramyagirish/myprojects/HEAD/w241/data/EtsySoldOrderItems2017-3-2.csv
Sample rows:
```
06/22/23,"back to school essentials | sticker flakes, stickers, ...",domoniquebradley1,1,3.00,,,0.00,0.00,0,0,3,USD,3610147651,856132624,06/22/2023,08/07/2023,"Domonique McCullough","7326 S Rockwell St",,Chicago,IL,60629,"United States",2931837964,,online,listing,online_cc,,,0,
```
Facts:
- One row per transaction (line item); join to Sold Orders by Order ID. Transaction ID matches the "transaction: N" id in statement VAT Info.
- Sale Date MM/DD/YY, but Date Paid and Date Shipped MM/DD/YYYY (four-digit year) in the same row.
- Buyer is "Full Name (username)" or bare username.
- Data rows can have one MORE field than the header (trailing comma, e.g. `...,0,` above in the 2023 file): parser must tolerate ragged rows.
- QUOTED NEWLINES: Variations holds personalization text with embedded line breaks, e.g. `"Size and Style:8 in - Text White,Accessory:Rectangle Led Light,Personalization:1. A chuisle mo chroí\n2. CJ & Bondy Shay..."`. Embedded `""` escaping in Item Name (`"Funny Love Card/ ""I love you"" ..."`). UTF-8 non-ASCII text. Sources: ddooxhuy09 2025 items file and ramyagirish 2017 file above.
- Amounts can be integers without decimals ("3", "0") alongside "3.00".
- No BOM.

### 2.4 Etsy Payments sales CSV (EtsyDirectCheckoutPayments*.csv)

Header (2025, two shops identical):
```
"Payment ID","Buyer Username","Buyer Name","Order ID","Gross Amount",Fees,"Net Amount","Posted Gross","Posted Fees","Posted Net","Adjusted Gross","Adjusted Fees","Adjusted Net",Currency,"Listing Amount","Listing Currency","Exchange Rate","VAT Amount","Gift Card Applied?",Status,"Funds Available","Order Date",Buyer,"Order Type","Payment Type","Refund Amount"
```
Sample rows:
```
178053447402,jaturner01,,3707617755,27.01,1.06,25.95,27.01,1.06,25.95,,,,USD,27.01,USD,1,0.00,No,SETTLED,06/18/2025,06/05/2025,"Joshua A. Turner",online,online_cc,0
168847050666,memcspadden1,,3558932487,20233.31,1099.52,19133.79,20233.31,1099.52,19133.79,0.00,0.00,0.00,VND,88.05,USD,24847.485708,0.00,No,SETTLED,01/01/2025,01/01/2025,"Megan Davis",online,online_cc,88.05
```
Sources: https://raw.githubusercontent.com/pqueuex/store.extantra/HEAD/EtsyDirectCheckoutPayments2025.csv , https://raw.githubusercontent.com/ddooxhuy09/Etsy-data-warehouse/HEAD/data/raw/2025-01/EtsyDirectCheckoutPayments2025-1.csv
Facts: Gross/Fees/Net = payment processing only (Fees = processing fee). Currency = payment account (payout) currency; Listing Amount/Listing Currency = buyer-facing listing price; Exchange Rate links them (VND example 24847.485708; 1 for same currency). This is how Etsy currency conversion appears. Dates MM/DD/YYYY. Status e.g. SETTLED. Adjusted* empty or 0.00 when no refund. "Refund Amount" semantics UNVERIFIED (ddooxhuy09 row shows 88.05 equal to Listing Amount, data may be altered). No BOM.

### 2.5 Etsy Payments deposits CSV (EtsyDeposits*.csv)

Header:
```
Date,Amount,Currency,Status,"Bank Account Ending Digits"
```
Sample rows:
```
"July 3, 2025",116.58,USD,Executed,3517
"January 1, 2025","2,907,287",VND,Executed,2011
```
Sources: https://raw.githubusercontent.com/pqueuex/store.extantra/HEAD/EtsyDeposits2025.csv , https://raw.githubusercontent.com/ddooxhuy09/Etsy-data-warehouse/HEAD/data/raw/2025-01/EtsyDeposits2025-1.csv
Facts: dates "Month D, YYYY" (no zero pad); Amount has NO currency symbol but DOES use thousands separators when large (quoted "2,907,287"); zero-decimal currency shown without decimals; Status "Executed" (other values UNVERIFIED). No BOM, LF in repo copies.

### 2.6 Monthly Payment account statement CSV (etsy_statement_YYYY_M.csv)

Header, current (2025 and 2026 files):
```
Date,Type,Title,Info,Currency,Amount,"Fees & Taxes",Net,"Tax Details"
```
Older (Jan 2024, UK shop) had no "Tax Details" column: `Date,Type,Title,Info,Currency,Amount,Fees & Taxes,Net` (copy is a TSV re-save from Excel, so quoting lost). Sources: https://raw.githubusercontent.com/MoulikArora21/FiDAViSta-Converter/HEAD/CE/test_files/etsy_statement_2025_1.csv , https://raw.githubusercontent.com/dimenoste/etsy_invoice/HEAD/etsy_payments.csv , https://raw.githubusercontent.com/5anperez/LeetCodePractice/HEAD/python/CSVs/Avidproducts%20financials%20-%20Big%20Dave.xlsx%20-%20etsy_statement_2024_1.tsv
Encoding: UTF-8 WITH BOM (bytes EF BB BF confirmed in two independent files). bnieco loader reads with encoding="utf-8-sig" and strips headers. LF in repo copies.
No preamble or footer lines; header is line 1. Rows in reverse chronological order (newest first).

Sample rows (EUR shop, US locale dates):
```
"January 30, 2025",Deposit,"€20.51 sent to your bank account",,EUR,--,--,--,--
"January 29, 2025",Fee,"Listing fee ($0.20 USD)","Listing #532223645",EUR,--,-€0.19,-€0.19,--
"January 27, 2025",Fee,"Transaction fee: Shipping","Order #3585063501",EUR,--,-€0.20,-€0.20,--
"January 27, 2025",Fee,"Transaction fee: LABRADOR RETRIEVER Custom Embroidery Dog...","Order #3585063501",EUR,--,-€1.36,-€1.36,--
"January 27, 2025",Tax,"Sales tax paid by buyer","Order #3585063501",EUR,--,-€4.78,-€4.78,--
"January 27, 2025",Fee,"Processing fee","Order #3585063501",EUR,--,-€1.45,-€1.45,--
"January 27, 2025",Sale,"Payment for Order #3585063501",,EUR,€28.68,--,€28.68,--
"April 30, 2026",Marketing,"Etsy Ads","Bill for click-throughs to your shop on Apr 29, 2026",EUR,--,-€0.86,-€0.86,--
```
Sample rows (GBP shop, day-first dates):
```
16 January, 2024	Refund	Refund to buyer for Order #3167767010		GBP	-£17.37	--	-£17.37
16 January, 2024	Fee	Credit for processing fee	Order #3167767010	GBP	--	£0.89	£0.89
16 January, 2024	VAT	VAT: Processing Fee	order: 3167767010	GBP	--	£0.18	£0.18
15 January, 2024	Tax	Refund to buyer for sales tax	Order #3159331115	GBP	--	£3.49	£3.49
12 January, 2024	Refund	Partial refund to buyer for Order #3090148712		GBP	-£1.93	--	-£1.93
03 January, 2024	Marketing	Fee for sale made through Offsite Ads	Order #3169518410	GBP	--	-£2.45	-£2.45
03 January, 2024	VAT	VAT: Offsite Ads fee	order: 3169518410	GBP	--	-£0.49	-£0.49
03 January, 2024	Fee	Regulatory Operating fee	Order #3169774110	GBP	--	-£0.05	-£0.05
01 January, 2024	Deposit	£1,208.35 sent to your bank account		GBP	--	--	--
```
Facts:
- Date format is LOCALE-DEPENDENT: "January 30, 2025" / "January 9, 2025" (US, no zero pad) vs "16 January, 2024" / "03 January, 2024" (day-first, zero-padded, comma before year). Parse both.
- Amount columns carry the currency SYMBOL with sign before symbol: "-€0.19", "€28.68", "-£17.37", "£0.89". Placeholder "--" for empty amount/fee/net/tax details. Thousands separator appears in text ("£1,208.35" in deposit Title); bnieco parser strips "$" and "," (`'$12.34' / '-$2.13' / '--'`), so amounts over 999 likely carry "," (UNVERIFIED in an amount column). Source for parser: https://raw.githubusercontent.com/bnieco/business_analytics/HEAD/scripts/load_etsy_statements.py
- Column roles: Sale and Refund rows use Amount (Fees & Taxes "--"); Fee, Tax, VAT, Marketing rows use Fees & Taxes (Amount "--"); Net = the signed effect on balance in every non-deposit row.
- Sign: debits negative (fees, buyer sales tax, refunds, ads), credits positive (sales, "Credit for ..." fee reversals, "Refund to buyer for sales tax" positive because tax is reversed).
- Type values observed: Sale, Fee, Tax, VAT, Marketing, Refund, Deposit. Others (Shipping for labels, Reserve, Payment, Adjustment, currency conversion) UNVERIFIED. bnieco notes statements include "shipping labels" and "Offsite Ads commission".
- Titles seen: "Payment for Order #N"; "Transaction fee: <truncated item title...>" (truncated with "..."), "Transaction fee: Shipping"; "Processing fee"; "Listing fee ($0.20 USD)" (USD fee converted, so the shop-currency amount varies, e.g. -€0.19, -£0.16; one row -€0.58 = multi-quantity/renewal); "Regulatory Operating fee"; "Sales tax paid by buyer"; "Etsy Ads"; "Fee for sale made through Offsite Ads"; "Credit for transaction fee on ...", "Credit for processing fee", "Credit for listing fee ($0.20 USD)", "Credit for Offsite Ads fee", "Credit for Regulatory Operating fee"; "Refund to buyer for Order #N", "Partial refund to buyer for Order #N", "Refund to buyer for sales tax"; VAT titles "VAT: transaction", "VAT: shipping_transaction", "VAT: Processing Fee", "VAT: listing", "VAT: auto-renew sold", "VAT: Offsite Ads fee", "VAT: Regulatory Operating fee" and their "credit" forms.
- Info holds the link key: "Order #N", "Listing #N", or for VAT rows "order: N", "transaction: N", "listing: N", "auto-renew sold : N". Sale rows have EMPTY Info (order id only in Title). Etsy Ads Info is free text with commas ("Bill for click-throughs to your shop on Apr 29, 2026").
- "Sales tax paid by buyer": the Sale Amount INCLUDES buyer-paid marketplace sales tax, and a separate negative Tax row removes it (Etsy remits). Net for an order = Sale + fee rows + tax row.
- DEPOSITS: Deposit rows have "--" in Amount, Fees & Taxes, Net and Tax Details; the deposit amount exists ONLY inside Title text ("€20.51 sent to your bank account", "£1,208.35 sent to your bank account"). An importer must regex the Title. Deposits are not linked to the orders they cover; pair with EtsyDeposits CSV (2.5) by date and amount.
- Currency column = payment account currency (EUR, GBP, USD).
- "Tax Details" observed only as "--"; contents when populated UNVERIFIED.

## 3. Airbnb

### 3.1 How to export (official)

Desktop: "Click Today > Menu > Earnings", "Click Upcoming or Paid", "Filter dates, listings, and earnings types", "Click Export CSV", "Choose how to export the report and what to include", "Click Export CSV". The CSV covers each earning's amount, host service fee, cleaning fee (if charged), gross earnings, and taxes withheld. No column names, date formats or currency rules are given. Monthly/annual statements are PDF (not CSV). Source: https://www.airbnb.com/help/article/3632
Earnings page sections: Upcoming (filter by date, listing, earnings type; "export earnings to a spreadsheet"), Paid ("export your earnings to a spreadsheet"), Reports. Upcoming shows "the date it is scheduled to be sent". Source: https://www.airbnb.com/help/question/304
Older UI names ("Completed payouts", "Future payouts"/"Upcoming", "Gross earnings" tab) appear in host community threads and a county tax guide; a community post claims the per-listing "Completed Payouts" export once lacked a header row while the "Gross Earnings" export had one (UNVERIFIED, dated). Sources (search results): https://community.withairbnb.com/t5/Help-with-your-business/Problem-with-AirBnb-Transaction-History-csv-file/td-p/1741590 , https://www.marincounty.gov/departments/finance/central-collections/transient-occupancy-tax/tot-resources/airbnb-gross-earnings-report-instructions
Default filename: airbnb_.csv style names reported by users (UNVERIFIED).

### 3.2 Transaction history CSV header rows

No primary source publishes the header. Concrete sources:

(a) Sample export in scmsal/nextProject (columns Guest/Details/Reference code/Currency appear removed for anonymization):
```
Date,Arriving by date,Type,Confirmation code,Booking date,Start date,End date,Nights,Listing,Amount,Paid out,Service fee,Cleaning fee,Gross earnings,Occupancy taxes,Earnings year
```
Source: https://raw.githubusercontent.com/scmsal/nextProject/HEAD/rentalTaxes/sampleCSV/sampleTransactions.csv ; the same repo's parser type adds "Short Term", Guest, Details, "Reference code" between: Date, Arriving by date, Type, Confirmation code, Booking date, Start date, End date, Nights, Short Term, Guest, Listing, Details, Reference code, Amount, Paid out, Service fee, Cleaning fee, Gross earnings, Occupancy taxes, Earnings year. Source: https://raw.githubusercontent.com/scmsal/nextProject/HEAD/rentalTaxes/src/lib/data/importCSV.ts ("Short Term" column existence UNVERIFIED beyond this).

(b) Older full header as typed in airbnb-to-odoo-csvparser (capitalization as in that code; note "Confirmation Code", "Start Date", "Paid Out", "Gross Earnings", "Fast pay fee"):
```
Date,Arriving by date,Type,Confirmation Code,Booking date,Start Date,End date,Nights,Guest,Listing,Details,Reference code,Currency,Amount,Paid Out,Service fee,Fast pay fee,Cleaning fee,Gross Earnings,Occupancy taxes,Earnings year
```
Source: https://raw.githubusercontent.com/shaun-fitzgibbon/airbnb-to-odoo-csvparser/HEAD/src/lib/fastcsv.ts . This matches the column set in the task brief. Header casing has drifted across years ("Confirmation Code" vs "Confirmation code", "Paid Out" vs "Paid out", "Gross Earnings" vs "Gross earnings", "Fast Pay Fee" vs "Fast pay fee"): match case-insensitively.

(c) Newer (2026) column names from a production accounting engine: requires Date, Type, Confirmation code, Guest, Listing, Details, Reference code, Amount, Paid out, Service fee, Fast pay fee, Gross earnings, "Airbnb remitted tax", plus uses "Arriving by date". "Airbnb remitted tax" appears to replace or sit beside "Occupancy taxes" (UNVERIFIED which). Source: https://raw.githubusercontent.com/matmorsc/DSRL_Accounting_Engine/HEAD/src/importers/normalize.py
Spanish-locale 2026 export ("Historial de transacciones"), field-for-field: Fecha (Date), Llega en esta fecha (Arriving by date), Tipo (Type), Código de confirmación (Confirmation code), Fecha de la reservación (Booking date), Fecha de inicio (Start date), Fecha de finalización (End date), Noches (Nights), Huésped (Guest), Anuncio (Listing), Detalles (Details), Código de referencia (Reference code), Moneda (Currency), Monto (Amount), Total pagado (Paid out), Tarifa por servicio (Service fee), Tarifa de Pago rápido (Fast Pay fee), Tarifa de limpieza (Cleaning fee), Tarifa por mascotas (PET FEE, a newer column), Ingresos brutos (Gross earnings), Impuestos liquidados por Airbnb (Airbnb remitted taxes). Source: https://raw.githubusercontent.com/Fafifo92/rental-income-dashboard/HEAD/src/services/etl.ts
KEY POINT: headers and Type values are LOCALIZED to the account language (Spanish above; a Czech test uses Typ, Potvrzující kód, Datum rezervace, Datum zahájení, Datum ukončení, Počet nocí, Host, Nabídka, Částka, Hrubé výdělky, Servisní poplatek, Poplatek za úklid, Referenční kód, Datum, Datum připsání na účet, Vyplaceno: https://raw.githubusercontent.com/agame41-debug/propertx/HEAD/tests/test_source_imports.py , synthetic test). Importer needs per-language alias tables or must ask the user to switch Airbnb language to English.

### 3.3 Row structure, types, amounts

Sample (scmsal, real-looking export):
```
11/30/25,12/5/25,Payout,,,,,,,,190.95,,,,,
11/30/25,,Reservation,C8N5D1R4GF,10/29/25,11/2/25,12/7/25,35,2-bedroom with a view,190.95,,5.91,0,196.86,19.05,2025
10/11/25,10/17/25,Payout,,,,,,,,2581.58,,,,,
10/11/25,,Adjustment,HMMRT8P9FW,8/29/25,9/24/25,10/8/25,14,New studio,-629.53,,-19.47,-32.14,,-104.29,2025
10/11/25,,Resolution Payout,HMQHBJCNHZ,,9/17/25,9/27/25,10,Lovely 2-bedroom,95,,,,95,,2025
10/11/25,,Reservation,HMPFTDY5DX,9/29/25,10/10/25,11/10/25,31,Cozy getaway,3116.11,,96.37,110,3212.48,310.94,2025
```
Source: https://raw.githubusercontent.com/scmsal/nextProject/HEAD/rentalTaxes/sampleCSV/sampleTransactions.csv
Facts:
- PAYOUT GROUPING: each `Payout` row comes FIRST and is followed by the rows it pays (Reservation, Adjustment, Resolution Payout, etc.). Paid out on the Payout row = sum of Amount of the following rows until the next Payout: 2581.58 = -629.53 + 95 + 3116.11 (verified arithmetic). Payout rows carry only Date, Arriving by date (bank arrival date), Paid out (and in full exports Details, Reference code, Currency); component rows have empty Paid out and empty Arriving by date. The Fafifo importer groups exactly this way ("cada fila Payout abre un grupo con las filas siguientes"). Sources: scmsal sample above, https://raw.githubusercontent.com/Fafifo92/rental-income-dashboard/HEAD/src/services/etl.ts
- Payout Details text: e.g. "Transfer to <Name>, Savings 7840 (COP)" (Spanish "Transferir a ..."); last 4 digits and payout currency in parentheses. Reference code on payout rows looks like "G-XXXX..." (test "G-ONE"). Sources: Fafifo etl.ts parsePayoutAccount, https://raw.githubusercontent.com/matmorsc/DSRL_Accounting_Engine/HEAD/tests/test_airbnb_adjustment_aware_pipeline_v12.py (exact G- format UNVERIFIED).
- One booking can appear in SEVERAL Reservation rows (long stays paid monthly, or payouts split between two bank accounts). Source: Fafifo etl.ts header comment.
- Reservation rows: Gross earnings = accommodation + cleaning fee; Amount = Gross earnings - Service fee (- Fast pay fee). 196.86 - 5.91 = 190.95. Service fee is a POSITIVE number on reservation rows in this sample (one synthetic Czech test shows it negative, "-10": UNVERIFIED; handle both by deriving from Gross - Amount). Cleaning fee is informational, already inside Gross earnings. DSRL: "reservations: Gross earnings less service fees equals Amount; payouts: Paid out is the transfer amount; adjustments/cancellation fees: Paid out and Gross earnings may be blank or zero even though Amount and fees carry the payout effect."
- Occupancy taxes (or "Airbnb remitted tax") are informational: collected and remitted by Airbnb, NOT included in Amount or Paid out (19.05 not in 190.95). "Pass Through Tax" rows (tax Airbnb pays the host to remit) DO move money (type name from a synthetic-looking converter, UNVERIFIED): https://raw.githubusercontent.com/Duncan-Haywood/oss-monorepo/HEAD/ventures/sales-export-to-journal/engines/airbnb.mjs
- Adjustment rows (alterations, cancellations): negative Amount, negative Service fee and Cleaning fee, Gross earnings may be blank. Resolution Payout rows: positive Amount = Gross, no fees. Other Type values seen: "Resolution Adjustment" (negative), "Cancellation Fee" (negative, e.g. -50.00), "Miscellaneous credit" (Spanish "Varios tipos de crédito", referral bonuses etc.), Co-host payouts (UNVERIFIED in CSV). Sources: DSRL test (types "adjustment", "resolution adjustment", "cancellation fee" with exported sign preserved), Fafifo etl.ts, airbnb-to-odoo enum (Payout, Reservation, Adjustment, Resolution Payout).
- Dates: US export uses M/D/YY without zero padding ("11/30/25", "12/5/25"); other repos assume MM/DD/YYYY; scmsal parser handles 2- or 4-digit years. Locale changes order (Fafifo auto-detects dmy vs mdy). Date = payout send date or transaction date; Arriving by date = expected bank arrival; Start/End = stay dates; Booking date = reservation date. Timezone: none stated (UNVERIFIED).
- Amounts: plain numbers, no currency symbol in the sample, integers allowed ("95", "110", "0"), no thousands separators in the sample (2180.07). Parsers defensively strip "$", "," and parentheses (DSRL `_money`; Fafifo `parseUSNumber` strips `[$\s,]`), so symbols/commas may appear in some exports (UNVERIFIED).
- Currency: Currency column is the payout currency on Payout rows; component rows can be in listing currency while payout is in another (COP reservation lines, USD payout: Fafifo pro-rates Paid out across items). Source: Fafifo etl.ts.
- Earnings year: tax year the earning is attributed to (e.g. 2025).
- Upcoming export: contains future (not yet paid) earnings; whether it includes Payout rows UNVERIFIED (likely not, since nothing is paid yet).
- Encoding: sample has CRLF line endings and no BOM (bytes start "Dat"). Quoted fields when listing names contain commas (UNVERIFIED in sample, standard CSV). Source: scmsal sample above (CR count 27 of 27 lines).

## 4. Confirmation summary

Confirmed header rows (from real or real-derived files):
- Stripe Reports itemized balance change (default v1/v2 order; v-suffix ".7" adds created/available_on non-UTC), payout reconciliation with automatic_payout_id (Banana, Wikimedia), Connect payouts itemized (Lainyshell). Column sets for all report versions confirmed from docs.stripe.com (alphabetical tables).
- Stripe legacy balance_history.csv (17-column "all columns" form and 9-column default), 3+ independent files.
- Etsy Sold Orders (2025 and 2020 variant), Sold Order Items (2017, 2023, 2025), Etsy Payments sales (EtsyDirectCheckoutPayments), Deposits, monthly statement (with and without Tax Details).
- Airbnb transaction history: only partial real sample (16 cols) plus parser-declared full headers in English, Spanish; no untouched full English file found.

UNVERIFIED: Stripe Dashboard Payouts list export header; Stripe live-download BOM/CRLF; default column ORDER of balance_change_from_activity.itemized.7 in Dashboard downloads; Etsy timezone; Etsy statement Type list beyond Sale/Fee/Tax/VAT/Marketing/Refund/Deposit; Airbnb exact current English header with Airbnb remitted tax / Pet fee placement; Airbnb Upcoming export shape; Airbnb Service fee sign across versions.

---

# Appendix C: Import targets


Purpose: hard import rules for each output format the converter writes. Every claim carries a source URL. UNVERIFIED marks anything not confirmed from a primary or concrete source. Findings appended as research proceeds.

## (4) QuickBooks Online bank upload (CSV, and file limits that also apply to QBO/QFX/OFX manual upload)

Source A (US, primary): https://quickbooks.intuit.com/learn-support/en-us/help-article/import-transactions/manually-upload-transactions-quickbooks-online/L0rE9OXBz_US_en_US
Source B (US, primary): https://quickbooks.intuit.com/learn-support/en-us/banking/import-bank-transactions-using-excel-csv-files/00/261910
Source C (AU, primary, same wording): https://quickbooks.intuit.com/learn-support/en-au/help-article/import-transactions/manually-upload-transactions-quickbooks-online/L0rE9OXBz_AU_en_AU

Hard rules stated by Intuit:
- Accepted transaction-list types: QBO recommended; QFX and CSV accepted; "Upload a list" section names .csv, .txt, .qbo, .ofx (Source A).
- "Your upload file must be in English and 350 KB or less." (Source A, C). Community report: a 369 KB QBO was rejected as too large: https://quickbooks.intuit.com/community/banking-4/i-am-trying-to-download-transactions-from-my-bank-into-quickbooks-it-says-file-too-large-what-can-i-do-23633 (secondary).
- "You can include up to 1,000 lines per upload. Each line contains one transaction." (Source A, C). An older page cited 500 lines (search snippet only, UNVERIFIED; treat 1,000 as current).
- No explicit max date range for manual upload. Intuit: "For larger uploads, shorten the date range and download transactions in smaller batches." The 90-day figure is the online-banking-connection backfill; manual upload is the documented way to get more than 90 days (Source B, search snippet of en-za/en-au variants).
- File should "start at least one day before your oldest QuickBooks transaction in that account" (Source A). Advisory, not a parser rule.
- Columns: "Each file needs either 3 (Date, Description, Amount) or 4 (Date, Description, Credit, and Debit) columns." Column order as listed (Source A, B).
- Remove the word "amount" from Credit and Debit headers; headers should read just "Credit" and "Debit" (Source A, B).
- "Leave any cells in Amount, Credit, or Debit that only contain zero (0) blank." (Source A). So in 4-column, the unused side must be empty, not 0.
- "Remove numbers from cells in the Description column." (Source A). Intuit troubleshooting tip; likely about description cells that are purely numeric being misread. Exact parser behavior UNVERIFIED.
- Dates: "Enter all Dates in the same format. We recommend the dd/mm/yyyy format." (Source A, US page says this too). During import QBO asks the user to pick the date format in the mapping step (mapping step: "Match the columns in the file with the correct fields", Source C). Exact list of selectable formats UNVERIFIED (commonly MM/dd/yyyy, dd/MM/yyyy, yyyy-MM-dd etc.).
- Weekday inside the date cell (e.g. "20/11/2018 TUE") must be removed (Source B).
- 3-column sign: money out negative ("-100.00"), money in positive ("200.00") (Source B example rows).
- Credit card CSVs may be sign-reversed; select the credit card account when uploading (Source B).
- "Mac users must save the file as a Windows CSV file." (Source B). Implies CRLF line endings / Windows encoding are safest.
- Currency symbols and thousands separators: not stated in Intuit articles fetched. Converter practice is to emit plain numbers with "." decimal and no symbols or commas. Explicit Intuit prohibition UNVERIFIED.
- Header row: the mapping step lets the user say whether the first row is a header (UNVERIFIED wording; widely reported). Writer should always emit a single header row.

QBO upload error messages (primary, CA article, same product): https://quickbooks.intuit.com/learn-support/en-ca/help-article/bank-transactions/fix-bank-upload-errors-quickbooks-online/L6FBh3zDC_CA_en_CA
- "The uploaded file contains invalid transaction amount information." Cause: "A transaction has 12 or more digits". Writer rule: abs(amount) digit count (cents included, per Intuit wording ambiguous) must stay under 12; treat 11 total digits as the hard cap and fail loudly above it.
- "The uploaded file is of a different type than these accounts." Cause: file account type (e.g. savings) differs from the selected QBO account (e.g. checking). Applies to QBO/OFX: ACCTTYPE / BANKACCTFROM vs CCACCTFROM must match the target account. User can click OK to continue anyway.
- "We were unable to upload the file. Please start over..." timeout; also importing into a subaccount is a current limitation.
- "Parent Account Error" / "Sub-account Error": related account already connected to a bank feed.

## (1) QBO / QuickBooks Web Connect

### INTU.BID, the FI directory, and the "unable to verify" error

- Intuit's own error text (QuickBooks Desktop Web Connect): "QuickBooks is unable to verify the Financial Institution information for this download." Other listed errors: "QuickBooks found an error. We can't read the file [Your financial institution] sent.", "An error occurred while processing your online banking data.", "Your data was not imported into QuickBooks.", "To download and import transactions, sign in with your Intuit account". Intuit says .qbo is "the only type Web Connect can read", import requires an Intuit Account sign-in, and a supported Desktop version. Intuit does not mention INTU.BID on this page. https://quickbooks.intuit.com/learn-support/en-ca/help-article/bank-connectivity/fix-web-connect-import-errors/L8o5eQjO4_CA_en_CA
- Cause of "unable to verify" per ProperSoft (converter vendor, concrete but secondary): (1) QuickBooks Desktop "imports QBO files only in its last three releases"; (2) the INTU.BID names a bank Intuit has removed from its list; (3) malformed QBO; (4) wrong country (each country's QuickBooks "expects its own bank details and currency"). ProperSoft suggests INTU.BID 3000 for the US or 2 for Canada. "The bank name shown during import comes from the INTU.BID. Transactions still go into the account you select." https://propersoft.net/howto/quickbooks-errors
- What INTU.BID is: an Intuit-assigned bank identifier placed in the SIGNONMSGSRSV1 SONRS block of a QBO file; QuickBooks looks it up in its FI directory. The lookup-against-directory mechanism is described by vendors (above) and is consistent with Intuit shipping a directory file; Intuit itself does not document INTU.BID publicly (UNVERIFIED as an Intuit-stated rule).
- Intuit FI directory (primary, Intuit-hosted):
  - QuickBooks Desktop Canada article names file fidir-c.txt in `C:\ProgramData\Intuit\QuickBooks XXXX\Components\OLB\branding\filist`, download URL https://ofx-prod-filist.intuit.com/qb3400-can/data/fidir-c.txt . Source: https://quickbooks.intuit.com/learn-support/en-ca/help-article/bank-feeds/update-financial-institutions-directory-quickbooks/L9CuK0RjS_CA_en_CA
  - US QuickBooks Desktop list (inferred US equivalent path, fetched OK, 1.5 MB, TSV, line 1 "FILIST", line 2 a count "8457"): https://ofx-prod-filist.intuit.com/qb3400/data/fidir.txt
  - Quicken list (TSV, "FILIST", count 15431): https://ofx-prod-filist.intuit.com/qw2800/data/fidir.txt
  - Rows have 4 leading ID columns in the QB list (3 in Quicken), then name, URLs, phone, ACTIVE, and a service column like "BANKING,CREDIT&WEB-CONNECT". Which ID column is the INTU.BID QuickBooks matches is UNVERIFIED (evidence below suggests column 1).
- Concrete rows from the QuickBooks US list (qb3400, fetched 2026-11-04):
  - "03000 | 03000 | 03000 | 03000 | Wells Fargo | ACTIVE | BANKING,CREDIT&WEB-CONNECT"  -> the widely used converter value INTU.BID 3000 is Wells Fargo Web Connect, active for banking and credit.
  - "12721 | 12721 | 12721 | 03000 | Wells Fargo Bank - DirectConnect | ACTIVE | ...&DIRECT"
  - "02430 | 02430 | 02430 | 10898 | Chase Web Download | ACTIVE"  -> 2430 is "Chase Web Download"; 10898 appears as the 4th column (Chase's FID per common QBO files; UNVERIFIED that 10898 alone verifies).
  - "11162 | 11162 | 05358 | 06526 | Bank of America - QB WebConnect | ACTIVE | BANKING,CREDIT&WEB-CONNECT"
  - "02102 ... Citibank | ACTIVE"; "07028 ... Capital One - Credit Cards | ACTIVE"
  - Quicken list also has "03000 ... Wells Fargo ... ACTIVE ... BANKING,CREDIT,ACCOUNTINFO,PAYMENT&DIRECT".
- Writer implication: pick an INTU.BID whose row is ACTIVE with WEB-CONNECT and with the right service (BANKING for checking/savings, CREDIT for credit cards). 3000 (Wells Fargo) covers both BANKING and CREDIT in the QB list, which is why converters default to it. Values can be removed by Intuit at any time, so the engine should keep INTU.BID configurable and re-check the directory periodically. Whether leading zeros matter ("3000" vs "03000") UNVERIFIED; converters and bank files commonly write 3000 without padding.
- The bank name/logo QuickBooks shows during import comes from the INTU.BID entry, not from ORG (ProperSoft, above).

### Account mapping, account type, FITID dedupe (QuickBooks)

- ProperSoft QBO settings (vendor docs): "QuickBooks accepts a QBO file only from a bank it allows."; pick an INTU.BID allowed for the account type, "a credit card code does not work for a checking account."; default 3000 (Wells Fargo) "allows every account type", 2 for QuickBooks Canada. "QuickBooks Desktop US edition needs US dollars." (CURDEF USD); Canadian edition accepts USD or CAD. Leave BANKID/BRANCHID empty "unless your app requires them" (note: OFX spec makes BANKID required inside BANKACCTFROM, so this means a dummy/real routing number, see OFX section). Payee appears in QuickBooks as "Downloaded as". https://www.propersoft.net/howto/output-settings-qbo/
- Account binding: "Every later file with the same Account ID and INTU.BID goes into that account without asking." If several accounts share an Account ID, "QuickBooks imports all of them into the first account". QuickBooks offers only existing accounts of the file's type. https://www.propersoft.net/howto/quickbooks-intubid/
  Writer rule: ACCTID must be stable per real account and distinct across accounts; keep INTU.BID stable per account too.
- FITID dedupe: "QuickBooks remembers the IDs it imported for each account and skips a transaction whose ID it has seen before", "even if you deleted that transaction." https://www.propersoft.net/howto/quickbooks-import-duplicates/
  Writer rule: FITID must be unique within the account forever, and deterministic (same source row -> same FITID) so a re-import is idempotent, but two distinct same-day same-amount rows must still get different FITIDs. Whether the dedupe key also includes the account / INTU.BID is per-account per the quote. Max FITID length QuickBooks tolerates: see OFX spec (A-255); practical safe length UNVERIFIED for QuickBooks specifically (many converters keep FITID <= 32 chars, UNVERIFIED).

## (3) OFX generic spec rules

Source note: FDX hosts the specs at https://financialdataexchange.org/about-fdx/ofx-work-group/ . OFX 1.0.2 (https://financialdataexchange.org/wp-content/uploads/2025/12/ofx1.0.2spec.zip), 1.0.3 and 1.6 are zips only (not readable via WebFetch, not downloaded per rules). The element definitions below are quoted from the OFX 2.2 spec PDF (https://financialdataexchange.org/wp-content/uploads/2025/12/OFX-2.2.pdf, dated 11/26/2017), whose "V1 message sets" wording explicitly covers the 1.x SGML banking elements. Page numbers are the printed page numbers. Where 1.0.2 could differ, noted.

- FITID (sec 3.2.3, p84-85): "Format: A-255". "FITIDs must be unique within the scope of an account but need not be sequential or even increasing." Clients use FI + ACCTID + FITID as a global key. "Note: Although the specification allows FITIDs of up to 255 characters, client performance may significantly improve if servers use fewer characters. It is recommended that servers use 32 characters or fewer." -> Writer: FITID <= 32 chars.
- TRNAMT (3.2.5, p86): "Format: Amount".
- MEMO (3.2.6, p86): "Format: A-255 for <MEMO>, used in V1 message sets".
- DTSTART/DTEND (3.2.7, p87): Datetime. In responses, DTSTART is where the server began looking; DTEND is exclusive ("the exclusive date and time in history where the server stopped looking").
- Datetime (3.2.8.1-3.2.8.2, p89-90): "YYYYMMDDHHMMSS.XXX [gmt offset[:tz name]]", example "19961005132200.124[-5:EST]". Fields may be omitted from the right; YYYYMMDD defaults to "12:00 AM (the start of the day), GMT"; YYYYMMDDHHMMSS and .XXX forms default to GMT. Offsets -12 to +12; "+12.00 to -12.00 for fractional offsets, plus sign may be omitted." "Note: Open Financial Exchange does not require servers or clients to use the full precision specified. However, they are REQUIRED to accept any of these forms without complaint." Ranges: MM 1-12, DD 1-31, HH 0-23, SS 0-60.
- Timezone shift trap (3.2.8.4, p91-92): a datetime may be converted to local time by clients; "A datetime value in the GMT timezone with a time of 12:00:00 (noon) would be converted to another time on the same date in every timezone. For example, 199812251200 remains Christmas Day in every timezone." -> Writer: emit DTPOSTED as YYYYMMDD120000 (noon) or YYYYMMDD120000[0:GMT] to avoid off-by-one-day shifts. Bare YYYYMMDD means midnight GMT, which a US client can render as the previous day (inference from spec; QuickBooks behavior UNVERIFIED but this is the reason many converters emit 120000).
- Amounts (3.2.9.1, p92): "Format: A-32". No decimal point means implied point at end. Leading sign; minus for negative; plus may be omitted. "Amounts that do not represent whole numbers (for example, 540.32), must include a decimal point or comma to indicate the start of the fractional amount. Amounts should not include any punctuation separating thousands, millions, and so forth." -> Writer: `-1234.56`, `.` decimal, no thousands separators, no currency symbol.

- Spec convention: in OFX element tables, bold tags are required, plain tags optional (visible in the 2.2 PDF tables; same convention in 1.x specs per common knowledge, UNVERIFIED for 1.0.2 text itself).
- SONRS (2.5.1.6, p53): required STATUS, DTSERVER, LANGUAGE; optional FI, others. STATUS code 0 = "Success (INFO)" (2.5.1.7, p54). Signon response is not inside a transaction wrapper.
- FI aggregate (2.5.1.8, p55): ORG "Organization defining this FI name space, A-32" (required inside FI), FID "Financial Institution ID (unique within <ORG>), A-32" (optional per spec, but QuickBooks/Quicken files always carry it).
- STMTRS (11.4.2.2, p208-209): required CURDEF (currsymbol, e.g. USD), BANKACCTFROM, LEDGERBAL (BALAMT amount + DTASOF datetime both required). BANKTRANLIST optional but if present requires DTSTART and DTEND ("date"). Optional AVAILBAL (BALAMT, DTASOF), BALLIST, MKTGINFO A-360. STMTRS must be inside STMTTRNRS (which also needs TRNUID and STATUS).
- CCSTMTRS (11.4.3.2, p212): same shape with CCACCTFROM instead of BANKACCTFROM; must be inside CCSTMTTRNRS.
- Element order: OFX 1.x SGML is order-sensitive per the DTD (UNVERIFIED as a QuickBooks parser behavior, but write tags in the exact table order to be safe).
- STMTTRN (11.4.4.1, p214-216), table order:
  TRNTYPE (required), DTPOSTED (required, datetime), DTUSER, DTAVAIL, TRNAMT (required, amount), FITID (required), CORRECTFITID, CORRECTACTION, SRVRTID, CHECKNUM (A-12), REFNUM (A-32), SIC (N-6), PAYEEID (A-12), then NAME (A-32) or PAYEE aggregate ("Provide NAME or PAYEE, not both"), EXTDNAME (A-100), BANKACCTTO or CCACCTTO, MEMO (A-255), IMAGEDATA, CURRENCY or ORIGCURRENCY, INV401KSOURCE.
  "TRNTYPE ... does not change the effect of the transaction upon the balance (increases and decreases are indicated by the sign of the <TRNAMT>)."
  "Transaction amounts are signed from the perspective of the customer. For example, a credit card payment is positive while a credit card purchase is negative."
  NAME is A-32: writer must truncate NAME to 32 chars (put the full text in MEMO). EXTDNAME and LOANPMTINFO, STMTTRNP, HOLD, CORRECTACTION are later additions; do not emit them in 1.02 files.
- TRNTYPE values (11.4.4.3, p219-220): CREDIT, DEBIT, INT, DIV, FEE, SRVCHG, DEP, ATM, POS, XFER, CHECK, PAYMENT, CASH, DIRECTDEP, DIRECTDEBIT, REPEATPMT, HOLD (only in STMTTRNP, 2.2 only), OTHER. Safe 1.02 subset: all except HOLD. Simplest safe writer choice: CREDIT for positive, DEBIT for negative (CHECK when CHECKNUM present).
- BANKACCTFROM (11.3.1, p187-188): BANKID required (A-9, USA = routing and transit number), BRANCHID optional (A-22, USA not present), ACCTID required (A-22), ACCTTYPE required, ACCTKEY optional (A-22, USA not present).
- ACCTTYPE values (11.3.1.1, p190): CHECKING, SAVINGS, MONEYMRKT, CREDITLINE, CD. (CD's presence in 1.0.2 UNVERIFIED; CHECKING/SAVINGS/MONEYMRKT/CREDITLINE are the long-standing set.)
- CCACCTFROM (11.3.2, p191): ACCTID required (A-22), ACCTKEY optional. No BANKID, no ACCTTYPE. Credit cards must use CREDITCARDMSGSRSV1 > CCSTMTTRNRS > CCSTMTRS > CCACCTFROM; bank accounts use BANKMSGSRSV1 > STMTTRNRS > STMTRS > BANKACCTFROM.
- ACCTID A-22: writer must cap at 22 chars.
- Statement status codes (p209-210): 2020 "Invalid date", 2027 "Invalid date range" (server-side codes; informative only).

### OFX 1.x SGML header and end tags (primary: OFX 2.2 spec sec 2.8, p74-75)

- "OFX 1.0.2 required any parser to accept end tags but did not require clients or servers to send elements with end tags." (2.8). So in 1.x, closing tags for elements (leaf values) are optional; aggregates must be closed. Emitting element end tags is legal; real bank QBO files mostly omit them (see examples below).
- The old (1.x) header, verbatim from the spec:
  ```
  OFXHEADER:100
  DATA:OFXSGML
  VERSION:102
  SECURITY:NONE
  ENCODING:USASCII
  CHARSET:NONE
  COMPRESSION:NONE
  OLDFILEUID:NONE
  NEWFILEUID:NONE
  ```
- 9 header lines in this order. Spec header example uses CHARSET:NONE; real-world QuickBooks/Quicken files almost always use CHARSET:1252 (see examples below). "OFX 1.x only required support for USASCII and UTF-8" (2.8.3).
- The blank line between the header block and `<OFX>` is required by the 1.x spec (UNVERIFIED from the 1.0.2 text here; confirmed by parser behavior notes below if found).

### Real bank QBO headers that import (concrete examples)

Source: Intuit community thread https://quickbooks.intuit.com/learn-support/en-us/banking/cannot-import-qbo-to-credit-card-account-type-only-other-current/00/970740
- BECU file that imported fine for years (tags reconstructed from the forum's mangled rendering, values verbatim):
  ```
  OFXHEADER:100
  DATA:OFXSGML
  VERSION:102
  SECURITY:NONE
  ENCODING:USASCII
  CHARSET:1252
  COMPRESSION:NONE
  OLDFILEUID:NONE
  NEWFILEUID:NONE

  <OFX>
  <SIGNONMSGSRSV1>
  <SONRS>
  <STATUS>
  <CODE>0
  <SEVERITY>INFO
  </STATUS>
  <DTSERVER>20210709033103.078
  <LANGUAGE>ENG
  <DTPROFUP>20050531070000.000
  <FI>
  <ORG>BECU
  <FID>3670
  </FI>
  <INTU.BID>11974
  <INTU.USERID>XXXXXX
  </SONRS>
  </SIGNONMSGSRSV1>
  <BANKMSGSRSV1>
  <STMTTRNRS>
  <TRNUID>0
  <STATUS>
  <CODE>0
  <SEVERITY>INFO
  </STATUS>
  <STMTRS>
  <CURDEF>USD
  <BANKACCTFROM>
  <BANKID>[removed]
  <ACCTID>XXXXXXXXXXXXX
  <ACCTTYPE>CREDITLINE
  </BANKACCTFROM>
  ```
  Key facts: CHARSET:1252; INTU.BID and INTU.USERID sit inside SONRS after </FI> and before </SONRS>; INTU.BID (11974) differs from FID (3670), so QuickBooks does not require INTU.BID == FID; element end tags omitted; LANGUAGE ENG; TRNUID 0 accepted.
- Second file from the same thread uses element end tags (`<CODE>0</CODE>` style), DTSERVER with offset `20211104164155.625[-7]`, and an extra 10th header line `STANDALONE:NONE`; these parse too (the user's problem was account type, not syntax).
- Account-type lesson from the same thread: a credit card exported as BANKACCTFROM with ACCTTYPE CREDITLINE would only import into a QuickBooks Desktop "Other Current Liability" account, not a Credit Card account; converting the file to a credit-card-type OFX fixed it. Writer rule: credit cards must be written as CREDITCARDMSGSRSV1 / CCSTMTTRNRS / CCSTMTRS / CCACCTFROM, never BANKACCTFROM+CREDITLINE.

## (2) QFX (Quicken Web Connect)

- Quicken official troubleshooting (primary): https://www.quicken.com/support/web-connect-troubleshooting
  - "Only a QFX file will allow you to download transactions" (checking, savings, credit card, brokerage, retirement). QIF does not work with Web Connect.
  - Web Connect "requires online access to validate the file"; expired subscriptions or unsupported Quicken versions cannot import Web Connect files.
  - "OL-221" error: "may be caused by your system date and time settings"; otherwise the QFX file itself may be the problem.
  - Files from third-party converters (e.g. PDF-to-QFX) are explicitly "not supported" by Quicken support.
  - Import paths: Windows File > File Import > Web Connect (.QFX) File. Mac: File > Import > Bank or Brokerage File (OFX, QFX).
- Quicken community (moderators and users; pages are login-walled, so quoted from search-result snippets, treat as secondary):
  - OL-221-A "has two meanings. One is there is a syntax error, and the other is that it isn't a participating partner supporting Web Connect." https://community.quicken.com/discussion/comment/20144145
  - The bank's row in Intuit's public FI directory must carry WEB-CONNECT ("The line has to have WEB-CONNECT on it."); the INTU.BID "refers to the first number on this line for each financial institution listing". Quicken connect log (Help > Log Files > Connect Log) shows syntax errors. Search snippets of https://community.quicken.com/discussion/comment/20250125 and https://community.quicken.com/discussion/7947601/cant-import-qfx-file-downloaded-from-my-bank-allsouth-fcu-edit . This supports reading column 1 of fidir.txt as the INTU.BID (still UNVERIFIED from Intuit).
  - Error text "Quicken is currently unable to verify the financial institution information for this download" means Quicken could not contact its server to validate, or "the value of the FID (or INTU.BID) in the QFX is not valid"; "it is the <INTU.BID> that is critical", FID is "ignored by Quicken" (user claim). Placeholder 01234 failed. Also reported as OL-220 (user claim, UNVERIFIED). https://community.quicken.com/discussion/comment/20513111 (snippet)
  - Quicken Mac: users report modern Quicken Mac will not import "a straight OFX file, it has to have the extra QFX entries in it" (INTU.BID); older Quicken Essentials imported plain OFX. https://community.quicken.com/discussion/comment/20542807 (snippet). So treat Mac like Windows: write QFX with a valid INTU.BID. UNVERIFIED by Quicken officially.
  - Known regression: Quicken R65.17 (Dec 2025) produced OL-221-A/B on valid Vanguard QFX files: https://community.quicken.com/discussion/7968795/new-12-2-25-vanguard-qfx-fail-leads-to-ol-221-a-and-ol-221-b-errors
- ProperSoft QFX settings (vendor): INTU.BID default 3000 (Wells Fargo, "allows every account type") or 2 for Canada; US Quicken needs USD, Canadian accepts USD or CAD, no other currencies; QFX "is an extended OFX file"; Quicken imports QFX but not plain OFX. https://www.propersoft.net/howto/output-settings-qfx/
- QFX vs QBO differences (synthesis): same OFX 1.02 SGML body and same INTU.BID / INTU.USERID extension tags in SONRS. Differences: file extension (.qfx vs .qbo), the directory consulted (Quicken list qw2800 vs QuickBooks list qb3400; an INTU.BID can be ACTIVE for Web Connect in one list and absent from the other), and Quicken validates online against its server. 3000 is listed in both (Quicken row shows DIRECT services; QB row shows WEB-CONNECT). Whether Quicken accepts 3000 from the qw2800 row lacking a WEB-CONNECT flag in the fetched excerpt is UNVERIFIED; vendors default to it successfully.

## (5) Xero bank statement CSV import

Note: central.xero.com articles are JavaScript-rendered and return empty to WebFetch, so Xero help text below comes from search-engine extracts of the official pages (URLs given) plus the official template file, which was fetched directly.

- Official template file (primary, fetched 2026-11-04):
  - https://go.xero.com/Bank/TemplateDownloader.aspx?americanise=false returns exactly: `*Date,*Amount,Payee,Description,Reference,Cheque Number`
  - https://go.xero.com/Bank/TemplateDownloader.aspx?americanise=true returns exactly: `*Date,*Amount,Payee,Description,Reference,Check Number`
  - Asterisks mark the required columns (Date, Amount). Column order as above.
- Official help articles (search extracts, primary pages):
  - Import a CSV bank statement: https://central.xero.com/0/article/Import-a-CSV-bank-statement-US (old URL https://help.xero.com/BankAccounts_Details_ImportTransCSV redirects to https://central.xero.com/s/article/Import-a-CSV-bank-statement)
    - "Only Date and Amount are required"; Payee, Description, Reference recommended. Payee names should match existing contacts exactly.
    - Column headings optional but help mapping; header row must be row 1; column names unique.
    - Single amount column: expenses negative, "either with a minus sign or in brackets"; decimal point, not comma.
    - Recommended date formats DD/MM/YYYY, MM/DD/YYYY, YYYY/MM/DD; also accepted DD-MM-YYYY, DD.MM.YYYY, DD/MMM/YYYY. If dates are ambiguous Xero asks the user to confirm and the choice sticks for the statement and future CSV imports.
    - Remove opening/closing balance columns, account number lines, and empty rows.
    - Files over 100,000 rows cannot be imported.
    - Two optional extra columns can be added for the bank's Analysis code and Transaction type.
    - Column mapping set on first import is remembered unless headers or column count change. (Related: https://central.xero.com/0/article/Change-the-way-Xero-imports-CSV-bank-statements )
  - Import a precoded CSV bank statement: https://central.xero.com/0/article/Import-a-precoded-CSV-bank-statement . Creates statement lines and reconciles them against new spend/receive money transactions. Required fields per Schema CPA's paraphrase: Date, Amount, Account code, Tax Rate (display name) https://schemacpa.com/blog/xero-bank-statement-csv-import-template . Exact precoded header text UNVERIFIED (could not fetch Xero's precoded example file). Lines that match existing invoices/bills should not be precoded (paraphrase).
  - Xero also imports OFX, QFX and QBO: https://central.xero.com/0/article/Import-an-OFX-bank-statement (title only confirmed; rules UNVERIFIED).
- Sign convention: money in positive, money out negative. For credit card accounts, payments to the card positive, purchases negative (Schema CPA paraphrase, consistent with OFX customer-perspective rule).
- File size limit in bytes: not found. UNVERIFIED. Third-party claims of 500 or 1,000 line caps are unconfirmed; treat 100,000 rows as the only official cap.
- Currency symbols / thousands separators: Xero says decimal point not comma; symbols not explicitly addressed in extracts. Writer: plain `-1234.56`.
- Date safety: YYYY/MM/DD is unambiguous; but a format that matches the org's region (DD/MM/YYYY for non-US, MM/DD/YYYY for US) avoids the confirmation prompt. Writer should prefer the region format chosen by the user, fall back to YYYY/MM/DD? Note: whether Xero accepts ISO YYYY-MM-DD with hyphens is UNVERIFIED (only YYYY/MM/DD listed).

## (6) QuickBooks Online journal entry import (Settings > Import data > Journal entries)

- Intuit US help (primary): https://quickbooks.intuit.com/learn-support/en-us/help-article/import-export-data-files/import-journal-entries-quickbooks-online/L4tQBwbs7_US_en_US
  - File should include headers: "Journal No.", "Journal Date", "Account Name", "Journal/Description", "Debits", "Credits". (The UI then has a mapping step: "map each file header to a QuickBooks field", so exact header spelling is matched by the user, but using these names makes auto-mapping work. Exact auto-map behavior UNVERIFIED.)
  - Name column: when Account Name is Accounts Payable or Accounts Receivable, "the system will request the Name column to have a vendor selected" (customer for A/R presumably).
  - Turn off account numbers before importing.
  - Line items must use the full account path for subaccounts: "Parent account:Sub Account"; subaccount alone gives "Line Account Invalid".
  - Accounts must already exist in the chart of accounts.
  - "Warn if duplicate journal number is used" preference blocks entries with existing numbers.
  - Class and Location tracking must be on to import those columns.
  - Sample file available via "Download a sample file" in the import screen (contents not fetchable without login; UNVERIFIED).
- Intuit Canada help (primary): https://quickbooks.intuit.com/learn-support/en-ca/help-article/import-export-files/import-journal-entries-quickbooks-online/L4tQBwbs7_CA_en_CA
  - Lists Journal No., Journal Date, Account Name, Description, Debits, Credits.
  - "If you are using MacOS, the column separator in your file will be a semicolon." (Windows: comma). Writer: always emit comma-separated; the note is about Excel-on-Mac regional export. Whether the importer accepts semicolons UNVERIFIED.
- Intuit Firm of the Future (Intuit-owned, primary-ish): https://www.firmofthefuture.com/quickbooks-proadvisor/in-the-know-s1-e9-journal-entries-import/
  - "you can upload journal entry CSV files with up to 1,000 lines."
  - Mandatory: account name, debits, credits, journal numbers. Optional: location, class, multi-currency.
- Grouping (secondary): lines belonging to one entry share the same Journal No. and same Date ("If you needed to add more lines to the same journal entry add them with the same Date, and the same Number." https://insightfulaccountant.com/accounting-tech/general-ledger/batch-import-journal-entries-into-quickbooks/ ). Community thread: a "Reference Number" column does not split entries, Journal No. does: https://quickbooks.intuit.com/community/importing-and-exporting-data-86/i-m-importing-journal-entries-via-csv-but-quickbooks-groups-them-all-into-one-even-though-each-line-has-a-different-reference-number-177565 (title-level evidence).
  Insightful Accountant lists sample columns as "Journal No.", "Journal Date", "Account Name", "Journal Entry Description", "Journal Entry Names (Vendor, Customer, etc.)", "Debits", "Credits", "Location", "Class", "Memo" (paraphrase of a screenshot; exact sample header text UNVERIFIED). A Currency column for multicurrency companies is mentioned as optional but its header name is UNVERIFIED.
- Balancing: "Ensure total debits equal total credits for each journal entry" (third party: https://www.mycloudbookkeeping.org/post/how-to-import-journal-entries-into-quickbooks-online-using-excel-or-csv ). This is an accounting invariant QBO enforces on any journal entry; the exact import error text is UNVERIFIED.
- Date formats: not stated by Intuit; third party says date mapping is "one of the most common causes of failed imports". Writer: use the company's date format (US MM/DD/YYYY) consistently; accepted list UNVERIFIED.
- Debit and credit on the same line: not addressed; writer should put a positive number in exactly one of Debits/Credits and leave the other blank (convention, UNVERIFIED as a hard rule).

### More QBO/OFX writer evidence

- csv2ofx (reubano, widely used) MS Money / OFX 1.x writer: header lines OFXHEADER:100, DATA:OFXSGML, VERSION:102, SECURITY:NONE, ENCODING:USASCII, CHARSET:1252, COMPRESSION:NONE, OLDFILEUID:NONE, NEWFILEUID:NONE; NAME truncated `payee[:32]`; midnight times moved to noon; DTSTART/DTEND as `%Y%m%d120000`; writes explicit element end tags; TRNUID 1. https://raw.githubusercontent.com/reubano/csv2ofx/master/csv2ofx/ofx.py
- ofxtools (csingley) header parser/writer: allowed values OFXHEADER 100; DATA OFXSGML; VERSION 3 digits; SECURITY NONE|TYPE1; ENCODING USASCII|UNICODE|UTF-8; CHARSET ISO-8859-1|1252|NONE; COMPRESSION optional NONE; OLDFILEUID/NEWFILEUID up to 36 chars. Writer joins header lines with CRLF and appends a blank line (two CRLFs) before `<OFX>`, noting newer spec versions require the separation. https://raw.githubusercontent.com/csingley/ofxtools/master/ofxtools/header.py
- SGML special characters: in SGML element content `&` and `<` must be escaped (`&amp;`, `&lt;`; `&gt;` for symmetry). Converters (csv2ofx `xmlize`) escape. Exact QuickBooks behavior on raw `&` UNVERIFIED but an unescaped `&` is a classic import breaker; always escape.
- QBO Online dedupe of uploaded files (secondary): Intuit community says QBO remembers previously uploaded transactions, including excluded ones, and refuses re-uploads; transaction IDs must be unique per bank account. Intuit help on excluding duplicates: https://quickbooks.intuit.com/learn-support/en-us/help-article/bank-transactions/exclude-duplicate-transactions-quickbooks-online/L8jyr7WpC_US_en_US . No Intuit statement that QBO Online keys on FITID explicitly (UNVERIFIED for Online; confirmed behavior for Desktop per ProperSoft). Thread: https://quickbooks.intuit.com/learn-support/en-ca/banking-currency/i-excluded-previously-uploaded-banking-transactions-and-now-when/00/1555518
- QBO Online and INTU.BID: Online manual upload maps to the account the user selects. Whether QBO Online validates INTU.BID against the FI directory at all is UNVERIFIED (vendor guides claim Online does not rely on it the way Desktop does). Safe rule: always include a valid INTU.BID anyway so one file works in both.
- Date range: no Intuit-stated maximum date range for a manually uploaded QBO/CSV in QBO Online beyond the 350 KB / 1,000 line caps; the 90-day limit is the bank-feed initial download. QuickBooks Desktop Web Connect date-range limit: none found (UNVERIFIED).
- QuickBooks Desktop version gate: only the last three releases import QBO (ProperSoft; consistent with Intuit's "supported version" requirement). Intuit-stated version list UNVERIFIED.

### Addendum to (4): QBO CSV common errors (primary)

Source: https://quickbooks.intuit.com/learn-support/en-ca/help-article/import-transactions/common-errors-importing-bank-transactions-using/L02IgW462_CA_en_CA (same article exists for AU/IE/SG/ZA)
- "The columns that are required by QuickBooks are: Date, Description, Amount." Remove other columns; "Change the names of the columns in your CSV to match the titles in QuickBooks."
- "Check the date format to make sure it matches the one you chose at the mapping stage." (confirms the user picks the date format during mapping; the list of options is UNVERIFIED).
- Amounts: "it is best to keep the amounts column as simple as possible"; Excel Currency number format must be changed to General. -> no currency symbols, no thousands commas.
- "Special characters in the bank description can prevent you from importing your file." -> writer should strip non-printable and non-ASCII-safe characters from Description (exact disallowed set UNVERIFIED; safest: printable ASCII plus common punctuation, quote fields containing commas).
- 4-column Debit/Credit file with only money-out rows "could give you an error"; workaround is adding a positive line. -> writer: when a 4-column file has no credits, prefer the 3-column layout instead.
- Importing into a subaccount is "a current limitation".

---

# Writer checklist

## QBO (QuickBooks Web Connect, Desktop and Online)
Exact header (CRLF line endings, no leading whitespace, then one blank line, then `<OFX>`):
```
OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

```
Tag order (bank account):
```
<OFX>
<SIGNONMSGSRSV1><SONRS>
  <STATUS><CODE>0<SEVERITY>INFO</STATUS>
  <DTSERVER>{YYYYMMDDHHMMSS}
  <LANGUAGE>ENG
  <FI><ORG>{org, <=32}<FID>{fid, <=32}</FI>
  <INTU.BID>{intu_bid}
  <INTU.USERID>{any stable id}
</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS>
  <TRNUID>{id}
  <STATUS><CODE>0<SEVERITY>INFO</STATUS>
  <STMTRS>
    <CURDEF>USD
    <BANKACCTFROM><BANKID>{9-digit routing}<ACCTID>{<=22}<ACCTTYPE>CHECKING|SAVINGS|MONEYMRKT|CREDITLINE</BANKACCTFROM>
    <BANKTRANLIST><DTSTART>{date}<DTEND>{date}
      <STMTTRN><TRNTYPE>..<DTPOSTED>..<TRNAMT>..<FITID>..[<CHECKNUM>..]<NAME>..[<MEMO>..]</STMTTRN> ...
    </BANKTRANLIST>
    <LEDGERBAL><BALAMT>{amount}<DTASOF>{datetime}</LEDGERBAL>
  </STMTRS>
</STMTTRNRS></BANKMSGSRSV1>
</OFX>
```
Credit card: replace BANKMSGSRSV1/STMTTRNRS/STMTRS/BANKACCTFROM with CREDITCARDMSGSRSV1/CCSTMTTRNRS/CCSTMTRS/`<CCACCTFROM><ACCTID>..</CCACCTFROM>` (no BANKID, no ACCTTYPE). Never BANKACCTFROM+CREDITLINE for a card.
Enforce:
- INTU.BID: default 3000 (Wells Fargo, ACTIVE, BANKING,CREDIT&WEB-CONNECT in qb3400 list); configurable; 2 for QuickBooks Canada. Keep INTU.BID and ACCTID constant per real account; distinct ACCTID per account.
- CURDEF USD for US QuickBooks (CAD or USD for Canada).
- FITID: unique per account forever, deterministic, <=32 chars (spec max 255), safe charset [A-Za-z0-9-_.:].
- DTPOSTED: `YYYYMMDD120000` (noon avoids timezone day shift); DTSERVER full timestamp.
- TRNAMT: signed from customer perspective, `.` decimal, no thousands separators, no symbol, under 12 total digits (QBO "invalid transaction amount" at 12+ digits).
- TRNTYPE: CREDIT if amount > 0, DEBIT if < 0 (CHECK with CHECKNUM <=12). Never HOLD.
- NAME <=32 chars (truncate, full text to MEMO); MEMO <=255; CHECKNUM <=12; REFNUM <=32; ACCTID <=22; BANKID <=9.
- Escape `&`, `<`, `>` in values. Use only characters representable in Windows-1252; strip control chars.
- LEDGERBAL required (BALAMT + DTASOF). DTSTART/DTEND required inside BANKTRANLIST.
- Element end tags: omit for leaf elements (bank-style) or write consistently; always close aggregates.
- File limits for QBO Online manual upload: <=350 KB and <=1,000 transactions; split into multiple files by date range otherwise.

## QFX (Quicken)
- Byte-identical to QBO body and header (same INTU.BID / INTU.USERID in SONRS), extension `.qfx`.
- INTU.BID must be a Quicken-recognized Web Connect bank (validated online against Intuit's server; list https://ofx-prod-filist.intuit.com/qw2800/data/fidir.txt). Default 3000; 2 for Canada. Invalid ID gives "unable to verify the financial institution" or OL-221-A.
- Currency USD (US) or USD/CAD (Canada).
- Treat Quicken Mac the same: QFX with INTU.BID (plain OFX reported rejected).
- Same field limits and FITID rules as QBO.

## OFX 1.02 generic (for Xero, GnuCash, Money, etc.)
- Same header block; CHARSET:1252 or NONE; blank line before `<OFX>`.
- Same aggregate order as QBO minus INTU.BID / INTU.USERID (allowed to keep them; non-Intuit parsers ignore unknown INTU.* tags, UNVERIFIED for every parser).
- Required: SONRS(STATUS, DTSERVER, LANGUAGE); STMTTRNRS(TRNUID, STATUS); STMTRS(CURDEF, BANKACCTFROM, LEDGERBAL); STMTTRN(TRNTYPE, DTPOSTED, TRNAMT, FITID, then NAME or PAYEE).
- Datetime `YYYYMMDDHHMMSS[.XXX][[offset:TZ]]`; readers must accept truncated forms.
- Lengths: NAME A-32, MEMO A-255, FITID A-255 (use <=32), CHECKNUM A-12, REFNUM A-32, ACCTID A-22, BANKID A-9, ORG/FID A-32, amounts A-32.

## QuickBooks Online bank CSV
- Choose 3-column unless the source has separate columns and both directions exist:
  - 3-col header exactly: `Date,Description,Amount`
  - 4-col header exactly: `Date,Description,Credit,Debit` (no word "amount")
- One header row, comma delimiter, CRLF line endings, UTF-8 without BOM or plain ASCII (encoding rule UNVERIFIED; "Windows CSV").
- Dates: one consistent format across the file matching what the user will pick at mapping; default MM/DD/YYYY for US companies, DD/MM/YYYY elsewhere; never append weekday.
- Amount: money out negative, money in positive; `-1234.56`; no `$`, no thousands commas, no parentheses (parentheses acceptance UNVERIFIED).
- 4-col: positive numbers only, unused side blank (never 0); zero-amount rows: leave amount cells blank or drop the row.
- Description: no purely numeric descriptions; strip special characters; quote fields containing commas or quotes.
- Limits: <=350 KB, <=1,000 transaction rows per file; split by date otherwise; no amount with 12+ digits.
- Credit card CSVs: emit customer-perspective sign (purchase negative) and tell user to pick the credit card account.

## Xero bank statement CSV
- Header exactly (non-US): `*Date,*Amount,Payee,Description,Reference,Cheque Number`
- Header exactly (US, americanised): `*Date,*Amount,Payee,Description,Reference,Check Number`
- Optional extra trailing columns: Analysis code, Transaction type (exact header spelling UNVERIFIED).
- Header in row 1; unique column names; no balance columns, no account-number lines, no blank rows.
- Amount: single signed column, money out negative (minus sign), decimal point, no symbol, no thousands separator.
- Date: DD/MM/YYYY (non-US) or MM/DD/YYYY (US) matching org region; YYYY/MM/DD as unambiguous alternative.
- <=100,000 rows. Byte size limit UNVERIFIED.
- Payee should match existing Xero contact names exactly when known.
- Precoded variant: adds account code and tax rate columns (exact headers UNVERIFIED); only for lines that do not match existing invoices/bills.

## QuickBooks Online journal entry CSV
- Header: `Journal No.,Journal Date,Account Name,Debits,Credits,Description,Name` (+ optional `Location`, `Class`, `Memo`, `Currency`; optional header spellings UNVERIFIED; user maps headers in the UI).
- One row per line; rows of one entry share identical Journal No. and Journal Date; new number = new entry.
- Per Journal No.: sum(Debits) == sum(Credits) to the cent; each row has exactly one of Debits/Credits filled with a positive number.
- Account Name must exist in the chart of accounts; subaccounts as `Parent:Sub` (full path); account numbers turned off by user before import.
- Name required on A/R (customer) and A/P (vendor) lines and must match an existing name.
- Journal numbers must not collide with existing ones if the duplicate-number warning is on.
- <=1,000 lines per file; comma delimiter; one consistent date format (US MM/DD/YYYY).

