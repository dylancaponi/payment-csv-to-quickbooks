# payment-csv-to-quickbooks

Convert CSV exports from Venmo, Cash App, PayPal, Stripe, Square, Shopify Payments, Wise, Etsy, Airbnb, Gumroad and any bank into files QuickBooks, Quicken and Xero accept: Web Connect (.qbo), .qfx, OFX, QuickBooks Online bank CSV, Xero bank statement CSV, and balanced QuickBooks Online journal entries per payout.

Plain ES modules, zero dependencies, no network calls. The same code runs in the browser and in Node 20+.

Want to convert a file without writing code? The free hosted converter runs this engine entirely in your browser (the file never leaves your device):

https://booksready.dylan-caponi.workers.dev

Sources: Venmo, Cash App, PayPal, Stripe (balance and payouts), Square, Shopify Payments (transactions and payouts), Wise (bank files only, no journal), Etsy, Airbnb, Gumroad, any bank CSV.
Targets: QuickBooks Web Connect (.qbo), Quicken (.qfx), OFX 1.0.2, QuickBooks Online bank CSV (3 or 4 columns), Xero bank statement CSV, QuickBooks Online journal entries (one balanced entry per payout or month).

Format rules and their sources: `FORMATS.md`. Every id and option: `OPTIONS.md`.

## Use

```js
import { SOURCES, TARGETS, detectSource, parse, write, summarizePayouts, EngineError } from './index.js';

const text = await file.text();               // the uploaded CSV, as text
const d = detectSource(text);                 // { sourceId, confidence, reason }
try {
  const { transactions, warnings, meta } = parse(d.sourceId, text);
  const out = write('qbo', transactions, { accountType: 'checking', sourceId: d.sourceId });
  // out = { filename, mime, content, warnings, parts? }
  download(out.filename, out.mime, out.content);
} catch (e) {
  if (e instanceof EngineError) showToUser(e.message);  // messages are written for end users
  else throw e;
}
```

In Node: `import { parse, write } from './index.js'` with `fs.readFileSync(path, 'utf8')`.

### API

- `SOURCES`: `[{ id, name, vendor, fileHint, howToExport[], quirks[], sampleHeader }]`
- `TARGETS`: `[{ id, name, software, extension, mime, howToImport[], requirements[] }]`
- `detectSource(text)` -> `{ sourceId | null, confidence 0..1, reason }`. Never throws. `reason` is user-readable (also explains PDFs, Excel files, OFX files, empty files).
- `parse(sourceId | 'auto', text, options?)` -> `{ transactions, warnings, meta: { rowsRead, rowsSkipped, currency, dateRange: { from, to }, ... } }`. Transactions are sorted oldest first.
- `write(targetId, transactions, options?)` -> `{ filename, mime, content, warnings, parts? }`.
- `summarizePayouts(transactions, { groupBy: 'payout' | 'month' })` -> rows used by the journal target.
- `convert(sourceId, text, targetId, options?)`: parse and write in one call.

Txn: `{ date: 'YYYY-MM-DD', description, amount, gross?, fee?, net?, tax?, currency, id?, type, counterparty?, payoutId?, payoutDate?, raw }`. `amount` is signed from the point of view of the account the export describes (money in positive), so a payout to the bank is negative. `type: 'transfer'` means money the user moved to or from their own bank; the journal books it as a transfer. See `OPTIONS.md` for every option.

All thrown errors are `EngineError` (`code`, user-facing `message`, optional `details`), including bad option values and malformed transactions passed to `write()`. Unexpected internal failures surface as code `INTERNAL`.

Journal entries are not supported for Wise statements: `write('qbo-journal', ...)` throws `NOT_SUPPORTED` when `options.sourceId` is `wise` or the transactions' `raw` rows carry a TransferWise ID / Wise ID column. Keep `raw` (or pass `sourceId`) when calling the API directly, or the check cannot see that the data came from Wise.

### Common write options

| Option | Targets | Default | Notes |
|---|---|---|---|
| `accountType` | qbo, qfx, ofx | `checking` | `savings`, `moneymrkt`, `creditline`, `creditcard` |
| `accountId` | qbo, qfx, ofx | derived from source | Keep it stable per real account; QuickBooks binds files to accounts by it |
| `intuBid` | qbo, qfx | `3000` (`2` for CAD) | Intuit bank id QuickBooks/Quicken check |
| `bankName` | qbo, qfx, ofx | `Books Import` | ORG tag |
| `currency` | all | most common in the data | Other currencies are left out with a warning |
| `ledgerBalance` | qbo, qfx, ofx | sum of transactions | Ending balance shown by the app |
| `dateFormat` | CSV targets | `MM/DD/YYYY` (Xero non-US: `DD/MM/YYYY`) | |
| `includeFeesAsSeparateRows` | bank targets | `false` | Writes gross and fee as two lines |
| `region` | xero-csv | `US` | Non-US uses `Cheque Number` and day-first dates |
| `groupBy`, `accounts`, `journalPrefix` | qbo-journal | payout if ids exist, else month | Account names must exist in QuickBooks; `accounts.paymentsSent` (default `Payments sent (uncategorized expense)`) and `accounts.transfers` (default: the bank account) |

Common parse options: `dateOrder` (`mdy`/`dmy`), `decimal` (`.`/`,`), `timeZone` (IANA name such as `America/Los_Angeles`, used to convert UTC timestamps from Venmo, Stripe and Gumroad), `delimiter`, `mapping`, `invertSign`.

## How it guarantees clean imports

- Money is integer cents end to end. Parsing never touches floating point; output is formatted from cents.
- FITIDs are a 64-bit FNV-1a hash of the row's date, amount in cents, description, platform id (if any) and type, plus an occurrence number among rows identical on all of those, decided row by row. The same row in two overlapping exports gets the same FITID and two different rows never share one. With `includeFeesAsSeparateRows` the gross line is the base FITID plus `G` and the fee line plus `F`, so a net line and a gross line are never confused; do not import the same period in both modes (the writer warns).
- Nothing that changes money or dates is guessed silently. With no `decimal` / `dateOrder` option, an ambiguous file throws `AMBIGUOUS_NUMBER_FORMAT` / `AMBIGUOUS_DATE_ORDER` with the candidate readings in `error.details`. With the option given, parsing proceeds, `meta.decimalAssumed` / `meta.dateOrderAssumed` is set and `meta.assumptionSamples` shows one value read both ways. Platform exports with fixed formats (Stripe, Etsy, Venmo, Cash App, Gumroad) never raise either error.
- Repeated header rows are removed. A transaction is dropped as a duplicate only when its source guarantees row-unique ids and the whole source row is identical to an earlier one (pasted-together exports); the warning gives the count and total. Gumroad rows are never merged.
- Fees on transfers and payouts are expenses: the bank or card line is only what actually reached it. Funding from a card or any source that is not recognisably the user's bank goes to `accounts.fundingCard`, never to the bank.
- Every CSV text cell starting with `=`, `+`, `-`, `@`, tab or CR gets a leading apostrophe; guards already in the source file are kept.
- Every writer enforces the hard limits in `FORMATS.md` (tag order, field lengths, ASCII, escaping, date formats, amounts under 12 digits, 1,000 row / 350 KB QuickBooks Online limits with automatic splitting between days where possible; split QBO parts carry the running balance on their last day).
- Tests check every output with validators in `test-support/` that were written separately from the writers (an OFX SGML parser and a strict RFC 4180 reader), so a writer bug cannot pass because the test shares its assumptions.

## Tests

```
node --test
```

Golden files in `golden/` cover every fixture x target. After an intentional output change: `UPDATE_GOLDEN=1 node --test`, then review the diff. Fixtures in `fixtures/` are synthetic (invented names and amounts) but reproduce the real header rows and quirks; the wide ones and the byte-level quirks (BOM, CRLF) are produced by `node test-support/make-fixtures.mjs`.

## Adding a source

1. Research the export: real header row(s), preamble/footer lines, date and amount formats, sign conventions, how fees, refunds and payouts appear. Add it to `FORMATS.md` with a URL per claim and UNVERIFIED where unconfirmed.
2. Create `src/sources/<id>.js` exporting:
   - `detect(rows)` -> `{ score, reason }` where `rows` is the first ~60 parsed CSV rows. Score 0.95+ only for a unique header signature; 0 when it is not yours.
   - `parse(rows, options, warnings)` -> `{ transactions, warnings, meta }`. Use the helpers in `src/util.js` (`findHeaderRow`, `columnMap`, `pick`, `cell`, `makeTxn`, `finishMeta`, `sortByDate`) and `parseMoney` / `parseDate` (cents and ISO dates). Map columns by name, never position. Throw `fail('WRONG_SOURCE', '<what is missing and how to export the right file>')` when the header is not found. Push a warning for every row you skip and why.
3. Register it in `PARSERS` in `index.js` and add its entry to `SOURCES` in `src/catalog.js` (export steps and quirks are shown to users).
4. Add a fixture in `fixtures/` with the exact real header and quirks, add a line to `CASES` in `test-support/fixtures.js` with the hand-computed count and total, add source-specific assertions in `test/sources.test.js`, then run `UPDATE_GOLDEN=1 node --test` once and review the new golden files.

## Adding a target

Write `src/targets/<name>.js` using `validateTxns`, `selectCurrency` and `toLines` from `src/targets/common.js` (they handle currency selection, fee splitting, cents and FITIDs), register it in `write()` in `index.js` and in `TARGETS`, and add an independent checker in `test-support/` before trusting it.
