// Money helpers. All arithmetic is done in integer cents (hundredths of the
// currency unit). Parsing never goes through floating point.

const SYMBOLS = /[$€£¥₹₩₦₱₫₪₺₴₽¢]|R\$|A\$|C\$|NZ\$|HK\$|US\$|CHF|kr/g;

// Classify one amount string by what its separators say about the decimal
// convention: '.', ',', 'ambiguous' (one separator followed by exactly three
// digits, e.g. "1.000" or "2,500") or null (no separator, says nothing).
export function decimalVote(raw, ctx = {}) {
  if (raw === undefined || raw === null) return null;
  const v = String(raw).replace(/[^\d.,]/g, '');
  if (!/\d/.test(v)) return null;
  const dots = (v.match(/\./g) || []).length;
  const commas = (v.match(/,/g) || []).length;
  if (dots && commas) return v.lastIndexOf('.') > v.lastIndexOf(',') ? '.' : ',';
  if (!dots && !commas) return null;
  const sep = dots ? '.' : ',';
  const other = dots ? ',' : '.';
  if ((dots || commas) > 1) return other; // repeated separator = thousands grouping
  const after = v.length - v.indexOf(sep) - 1;
  if (after === 3 && v.indexOf(sep) > 0) {
    // In a comma-delimited file a value containing a comma had to be quoted
    // on purpose, and money never has three decimals: "1,000" is thousands.
    if (sep === ',' && ctx.commaDelimited && v.indexOf(',') <= 3) return '.';
    return 'ambiguous';
  }
  return sep;
}

// Decide the decimal separator used by a column of amount strings.
// Returns { decimal: '.'|','|null, votes: {dot, comma, ambiguous}, ambiguousSample }.
// decimal is null when the values cannot decide it (ambiguous samples only,
// or contradicting votes).
export function analyzeDecimal(values, ctx = {}) {
  let dot = 0; let comma = 0; let ambiguous = 0; let ambiguousSample = null;
  for (const raw of values) {
    const vote = decimalVote(raw, ctx);
    if (vote === '.') dot++;
    else if (vote === ',') comma++;
    else if (vote === 'ambiguous') { ambiguous++; if (!ambiguousSample) ambiguousSample = String(raw).trim(); }
  }
  let decimal;
  if (dot && comma) decimal = null;
  else if (dot) decimal = '.';
  else if (comma) decimal = ',';
  else decimal = ambiguous ? null : '.';
  return { decimal, votes: { dot, comma, ambiguous }, ambiguousSample };
}

// Back-compatible helper: '.' or ',' (falls back to '.').
export function sniffDecimal(values) {
  return analyzeDecimal(values).decimal || '.';
}

// Parse a money string into integer cents.
// Returns null for empty or placeholder values ("", "--", "-", "N/A").
// Returns NaN when the text is not a recognizable amount.
// Handles: "+ $25.00", "- $1,000.00", "-$5.00", "$2", "(12.34)", "12.34-",
// "-€0.19", "1.234,56" (decimal ','), "1,234.56", "USD 10.00", "10.00 USD".
// Rounding reporter: parse() installs one so that every amount with more than
// two decimals is reported per row instead of being rounded silently.
let roundingReporter = null;
export function setRoundingReporter(fn) { roundingReporter = fn; }

export function parseMoney(input, decimal = '.') {
  if (input === undefined || input === null) return null;
  let s = String(input).trim();
  if (s === '' || s === '--' || s === '-' || s === '\u2014' || /^n\/?a$/i.test(s) || s === '(None)') return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }
  // Leading sign possibly separated from the symbol by spaces: "- $1.00", "+ $1.00", "$-1.00"
  s = s.replace(/[A-Z]{3}\s*$/, '').replace(/^[A-Z]{3}\s*/, '');
  s = s.replace(SYMBOLS, '');
  s = s.replace(/\s+/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
  if (s.endsWith('-')) { negative = !negative; s = s.slice(0, -1); }
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
  if (s === '') return NaN;
  if (decimal === ',') {
    s = s.replace(/[.' ]/g, '').replace(',', '.');
  } else {
    // Thousands separators must be in groups of three.
    if (s.includes(',')) {
      if (!/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) return NaN;
      s = s.replace(/,/g, '');
    }
  }
  if (!/^\d*\.?\d*$/.test(s) || s === '.') return NaN;
  const [intPart, fracPart = ''] = s.split('.');
  const whole = intPart === '' ? 0 : Number(intPart);
  if (!Number.isSafeInteger(whole) || whole > 9e13) return NaN;
  let cents = whole * 100 + Number((fracPart + '00').slice(0, 2));
  // Round half away from zero on the third decimal.
  if (fracPart.length > 2 && Number(fracPart[2]) >= 5) cents += 1;
  if (roundingReporter && /[1-9]/.test(fracPart.slice(2))) roundingReporter(String(input).trim(), negative ? -cents : cents);
  if (cents === 0) return 0;
  return negative ? -cents : cents;
}

// Format integer cents as a plain decimal string: -1234.56
export function formatCents(cents) {
  if (!Number.isInteger(cents)) throw new Error('formatCents expects integer cents, got ' + cents);
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const s = Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
  return neg ? '-' + s : s;
}

// Convert a Txn number (major units) back to integer cents.
export function toCents(n) {
  if (n === undefined || n === null) return null;
  if (typeof n !== 'number' || !Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

export function fromCents(c) {
  if (c === null || c === undefined) return undefined;
  return c / 100 + 0; // + 0 turns -0 into 0
}
