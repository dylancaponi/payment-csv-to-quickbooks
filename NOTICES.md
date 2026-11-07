# Third-party samples

The MT940 and camt.053 parsers were developed and tested against bank statement samples that other people published. This page names them. Nothing from them is used except as a reference for the file format.

## Files in `fixtures/` that are copies of published samples

These are used as published, for format reference and as test input only. They are not edited, apart from one restored trailing space noted below.

| Fixture | Where it comes from |
|---|---|
| `mt940-ing-sample.sta` | ING "Sample Files NL MT940", https://assets.ing.com/m/33b5fb41d9d72026/original/Sample-Files-MT940.pdf (text extracted from the PDF; one trailing space restored at a 65-character line wrap). The sample's balances do not add up as published, and the parser reports that. |
| `camt053-ing-sample.xml` | ING "Sample Files NL CAMT.053", https://assets.ing.com/m/19ba05999348c5c7/original/Sample-Files-CAMT.pdf (the statement part). It is a truncated sample, so it does not reconcile. |
| `mt940-rabobank-gist.sta` and `mt940-rabobank-from-feb.sta` | The GitHub gist "RABO MT940 Structured", https://gist.github.com/spoetnik/046c2e9dd4242d2603ad (the second file is the tail of the first). |
| `mt940-german-sepa.sta` | `mt940_tests/betterplace/sepa_mt9401.sta` from https://github.com/WoLpH/mt940 |
| `mt942-mbank.sta` | `mt940_tests/mBank/mt942.sta` from https://github.com/WoLpH/mt940 (used only to test that MT942 is refused) |

The two WoLpH files come from the test suite of the mt940 parser by Rick van Hattem, which is released under the BSD 3-Clause license:

    Copyright (c) 2014, Rick van Hattem
    All rights reserved.

The full license text is in that repository: https://github.com/WoLpH/mt940/blob/develop/LICENSE

The ING files are published by ING for people who build software that reads its statements. The Rabobank gist was published by its author on GitHub. We have no separate license from either; they are included in small size as format references for the tests. If you own one of these samples and want it removed, open an issue and it will be replaced with a constructed file.

## Fixtures that are constructed

Every other fixture in `fixtures/` was written for this repository with invented names, account numbers, dates and amounts:

- Built on a published layout: `mt940-abnamro.sta` follows the structure of the ABN AMRO free-text MT940 test file in the WoLpH repository (tags, field layouts and description style), with all values invented and balances that add up. `camt053-multi.xml` and `camt053-v08.xml` follow the ING camt.053 sample layout and ISO 20022 element names.
- Built on the provider's own documentation or on header rows seen in public projects: the CSV fixtures for Venmo, Cash App, PayPal, Stripe, Square, Shopify, Wise, Etsy, Airbnb, Gumroad and generic bank files.
- Built from documentation and field-by-field format notes: `amazon-settlement-*.txt` and `ebay-transaction-report.csv`. No real settlement or transaction report is included.

No fixture contains a real person's or business's transactions.
