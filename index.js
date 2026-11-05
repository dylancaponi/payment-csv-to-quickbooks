// Books import engine: payment-app and marketplace CSV exports in,
// accounting-software import files out. Plain ES module, zero dependencies,
// runs unchanged in browsers and Node 20+. No network access.
import { EngineError, fail } from './src/errors.js';
import { parseCSV, writeCSV } from './src/csv.js';
import { SOURCES, TARGETS } from './src/catalog.js';
import * as venmo from './src/sources/venmo.js';
import * as cashapp from './src/sources/cashapp.js';
import * as paypal from './src/sources/paypal.js';
import * as stripe from './src/sources/stripe.js';
import * as etsy from './src/sources/etsy.js';
import * as airbnb from './src/sources/airbnb.js';
import * as gumroad from './src/sources/gumroad.js';
import * as generic from './src/sources/generic.js';
import { writeOfx } from './src/targets/ofx.js';
import { writeQboCsv, writeXeroCsv } from './src/targets/csvbank.js';
import { writeJournal } from './src/targets/journal.js';
import { summarizePayouts as summarize } from './src/payouts.js';
import { normalizeTxns } from './src/targets/common.js';
import { checkParseOptions } from './src/locale.js';
import { parseMoney, setRoundingReporter } from './src/money.js';
import { parseDate } from './src/dates.js';
import { norm, finishMeta } from './src/util.js';

export { SOURCES, TARGETS, EngineError, parseCSV, writeCSV };

const PARSERS = {
  venmo: { detect: (rows) => venmo.detect(rows), parse: venmo.parse },
  cashapp: { detect: (rows) => cashapp.detect(rows), parse: cashapp.parse },
  paypal: { detect: (rows) => paypal.detect(rows), parse: paypal.parse },
  'stripe-balance': { detect: (rows) => stripe.detect(rows, 'stripe-balance'), parse: stripe.parse },
  'stripe-payouts': { detect: (rows) => stripe.detect(rows, 'stripe-payouts'), parse: stripe.parse },
  etsy: { detect: (rows) => etsy.detect(rows), parse: etsy.parse },
  airbnb: { detect: (rows) => airbnb.detect(rows), parse: airbnb.parse },
  gumroad: { detect: (rows) => gumroad.detect(rows), parse: gumroad.parse },
  'generic-bank': { detect: (rows) => generic.detect(rows), parse: generic.parse },
};

const MAX_BYTES = 50 * 1024 * 1024;

// Reject things that are clearly not a CSV, with a message a person can act on.
function sniffNonCsv(text) {
  if (typeof text !== 'string') return 'The file could not be read as text. Please upload the .csv file exactly as it was downloaded.';
  const head = text.slice(0, 512);
  if (!text.trim()) return 'This file is empty. Please upload the CSV file exactly as you downloaded it.';
  if (head.startsWith('%PDF')) return 'This is a PDF statement. Please download the CSV version of your activity instead (PDF statements cannot be converted reliably).';
  if (head.startsWith('PK')) return 'This looks like an Excel (.xlsx) or zip file. Open it in Excel or Google Sheets and save or download it as CSV, then upload the CSV.';
  if (/^\s*OFXHEADER:|^\s*<\?xml[^>]*\?>\s*<\?OFX|^\s*<OFX>/i.test(head)) return 'This file is already an OFX/QFX/QBO file, which accounting software can import directly.';
  if (/^\s*!(Type|Account|Option)/i.test(head)) return 'This is a QIF file, not a CSV. Please download a CSV export instead.';
  if (/^\s*<(!doctype|html)/i.test(head)) return 'This is a web page, not a CSV export. Save the download link target, or use the export button in the app.';
  if (head.includes('\u0000')) return 'This file is not plain text (it may be a spreadsheet or a UTF-16 file). Save it as "CSV UTF-8" and try again.';
  if (text.length > MAX_BYTES) return 'This file is larger than 50 MB. Please export a shorter date range.';
  return null;
}

function rowsOf(text, options = {}) {
  const bad = sniffNonCsv(text);
  if (bad) fail('NOT_CSV', bad);
  return parseCSV(text, { delimiter: options.delimiter });
}

export function detectSource(text) {
  try { return detectImpl(text); } catch (e) { return { sourceId: null, confidence: 0, reason: internal(e).message }; }
}

function detectImpl(text) {
  const bad = sniffNonCsv(text);
  if (bad) return { sourceId: null, confidence: 0, reason: bad };
  let rows;
  try {
    rows = parseCSV(text.slice(0, 200000), { maxRows: 60 });
  } catch (e) {
    return { sourceId: null, confidence: 0, reason: e instanceof EngineError ? e.message : 'The file could not be read as CSV.' };
  }
  let best = { sourceId: null, confidence: 0, reason: '' };
  for (const [id, p] of Object.entries(PARSERS)) {
    let r;
    try { r = p.detect(rows); } catch { r = { score: 0 }; }
    if (r.score > best.confidence) best = { sourceId: id, confidence: r.score, reason: r.reason || '' };
  }
  if (!best.sourceId || best.confidence < 0.3) {
    return { sourceId: null, confidence: best.confidence, reason: best.reason || "We couldn't recognize this file. It needs a header row with at least a date column and an amount column. If it came from Venmo, Cash App, PayPal, Stripe, Etsy, Airbnb or Gumroad, make sure you uploaded the original CSV download." };
  }
  if (best.confidence < 0.5 && best.reason) best.reason += ' Check the preview before converting.';
  return best;
}

// Sources whose id identifies exactly one source row. Gumroad is left out on
// purpose: one purchase id appears on its sale and on every partial refund,
// and two identical partial refunds are real money.
const ROW_UNIQUE_IDS = new Set(['venmo', 'cashapp', 'paypal', 'stripe-balance', 'stripe-payouts', 'etsy', 'airbnb']);

function headerLike(row) {
  let filled = 0;
  for (const v of row) {
    const t = v.trim();
    if (!t) continue;
    filled++;
    const m = parseMoney(t);
    if ((m !== null && !Number.isNaN(m)) || parseDate(t)) return false;
  }
  return filled >= 3;
}

// Several exports pasted into one file repeat the header row. Drop every
// exact repeat of an earlier header-like row.
function dropRepeatedHeaders(rows, warnings) {
  const seen = new Set();
  const out = [];
  let repeats = 0;
  for (const r of rows) {
    if (headerLike(r)) {
      const k = r.map(norm).join('\u0001');
      if (seen.has(k)) { repeats++; continue; }
      seen.add(k);
    }
    out.push(r);
  }
  if (repeats) warnings.push(`The column header row appears ${repeats + 1} times, so this file looks like several exports pasted together. The extra header rows were ignored.`);
  return out;
}

// A row is dropped only when the source guarantees row-unique ids and the
// entire source row (every cell) is identical to an earlier row with the same
// id: that only happens when exports are pasted together.
function dropRepeatedTransactions(txns, warnings) {
  const seen = new Map();
  const out = [];
  let dropped = 0;
  let droppedCents = 0;
  let clashes = 0;
  for (const t of txns) {
    if (!t.id) { out.push(t); continue; }
    const sig = JSON.stringify(t.raw) + '|' + t.date + '|' + Math.round(t.amount * 100);
    const prev = seen.get(t.id);
    if (prev === undefined) { seen.set(t.id, sig); out.push(t); continue; }
    if (prev === sig) { dropped++; droppedCents += Math.round(t.amount * 100); continue; }
    clashes++;
    out.push(t);
  }
  if (dropped) warnings.push(`Removed ${dropped} duplicate transaction(s) totalling ${(droppedCents / 100).toFixed(2)}: each is an exact copy of an earlier row with the same transaction id, which happens when overlapping exports are combined. Each transaction is now included once.`);
  if (clashes) warnings.push(`${clashes} transaction(s) share an id with a different row. Both were kept; please check them in the preview.`);
  return out;
}

function internal(e) {
  if (e instanceof EngineError) return e;
  return new EngineError('INTERNAL', 'Something unexpected went wrong while handling this file. Nothing was saved or sent anywhere. Please try again; if it keeps happening, the file may use a layout we do not support yet.', { cause: String((e && e.message) || e) });
}

function guarded(fn) {
  return (...args) => { try { return fn(...args); } catch (e) { throw internal(e); } };
}

function parseImpl(sourceId, text, options = {}) {
  let id = sourceId;
  const warnings = [];
  const bad = sniffNonCsv(text);
  if (bad) fail('NOT_CSV', bad);
  if (options === null || typeof options !== 'object') fail('BAD_OPTION', 'Options must be an object.');
  checkParseOptions(options);
  if (sourceId !== undefined && sourceId !== null && typeof sourceId !== 'string') fail('UNKNOWN_SOURCE', 'The source must be one of the source ids, or "auto".');
  if (!id || id === 'auto') {
    const d = detectSource(text);
    if (!d.sourceId) fail('UNRECOGNIZED', d.reason);
    id = d.sourceId;
  }
  const p = Object.prototype.hasOwnProperty.call(PARSERS, id) ? PARSERS[id] : null;
  if (!p) fail('UNKNOWN_SOURCE', `Unknown source "${sourceId}". Choose one of: ${Object.keys(PARSERS).join(', ')}.`);
  const raw = rowsOf(text, options);
  const ctx = { meta: {}, delimiter: raw.delimiter };
  const rows = dropRepeatedHeaders(raw, warnings);
  const popts = { ...options, _ctx: ctx };
  const rounded = new Map();
  setRoundingReporter((orig, cents) => { if (!rounded.has(orig)) rounded.set(orig, cents); });
  let res;
  try { res = p.parse(rows, popts, warnings); } finally { setRoundingReporter(null); }
  for (const [orig, cents] of rounded) {
    const t = res.transactions.find((x) => Object.values(x.raw || {}).some((v) => String(v).trim() === orig));
    if (!t) continue; // value from a skipped or non-money column
    warnings.push(`The row dated ${t.date} (${t.description || 'no description'}) has the amount "${orig}", which has more than two decimals; we used ${(cents / 100).toFixed(2)}. Check that row.`);
  }
  Object.assign(res.meta, ctx.meta);
  let transactions = res.transactions;
  if (ROW_UNIQUE_IDS.has(id)) transactions = dropRepeatedTransactions(transactions, warnings);
  if (!transactions.length) warnings.push('No transactions were found in this file. Check that you exported the right date range and the right report.');
  res.meta.sourceId = id;
  if (transactions.length !== res.transactions.length) {
    res.meta.duplicatesRemoved = res.transactions.length - transactions.length;
    Object.assign(res.meta, finishMeta(transactions, res.meta.rowsRead, res.meta.rowsSkipped + res.meta.duplicatesRemoved, {}), { sourceId: id, duplicatesRemoved: res.meta.duplicatesRemoved });
  }
  return { transactions, warnings: dedupe(res.warnings), meta: res.meta };
}

function dedupe(arr) {
  return [...new Set(arr)];
}

function writeImpl(targetId, transactions, options = {}) {
  if (options === null || typeof options !== 'object') fail('BAD_OPTION', 'Options must be an object.');
  let res;
  switch (targetId) {
    case 'qbo':
    case 'qfx':
    case 'ofx':
      res = writeOfx(targetId, transactions, options); break;
    case 'qbo-csv-3':
    case 'qbo-csv-4':
      res = writeQboCsv(targetId, transactions, options); break;
    case 'xero-csv':
      res = writeXeroCsv(transactions, options); break;
    case 'qbo-journal':
      res = writeJournal(transactions, options); break;
    default:
      fail('UNKNOWN_TARGET', `Unknown output format "${String(targetId)}". Choose one of: ${TARGETS.map((t) => t.id).join(', ')}.`);
  }
  res.warnings = dedupe(res.warnings);
  return res;
}

export const parse = guarded(parseImpl);
export const write = guarded(writeImpl);

export const summarizePayouts = guarded((transactions, options = {}) => {
  if (options === null || typeof options !== 'object') fail('BAD_OPTION', 'Options must be an object.');
  return summarize(normalizeTxns(transactions), options);
});

// Convenience: parse then write in one call.
export const convert = guarded((sourceId, text, targetId, options = {}) => {
  const parsed = parseImpl(sourceId, text, options);
  const out = writeImpl(targetId, parsed.transactions, { sourceId: parsed.meta.sourceId, ...options });
  return { ...out, warnings: dedupe([...parsed.warnings, ...out.warnings]), meta: parsed.meta };
});
