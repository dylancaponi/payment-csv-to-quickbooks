// RFC 4180 CSV reader and writer. Zero dependencies, browser and Node safe.
// Reader handles: UTF-8 BOM, CRLF / LF / CR line endings, quoted fields with
// embedded delimiters, quotes ("") and newlines, ragged rows, and sniffs the
// delimiter (comma, semicolon or tab) when not given.
import { fail } from './errors.js';

export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export const MAX_CELL_CHARS = 100000;

// Pick the delimiter (comma, semicolon or tab) whose quote-aware parse of the
// first lines gives the most consistent column count. A single-column parse
// never wins. Ties go to the wider table, then to comma.
export function sniffDelimiter(text) {
  const sample = text.slice(0, 50000);
  let best = { d: ',', score: -1, width: 0 };
  for (const d of [',', ';', '\t']) {
    let rows;
    try { rows = parseRows(sample, d, 40, true); } catch { continue; }
    if (rows.length > 1 && sample.length === 50000) rows.pop(); // last row may be cut
    const counts = rows.filter((r) => r.some((v) => v.trim() !== '')).map((r) => r.length);
    if (!counts.length) continue;
    const freq = new Map();
    for (const n of counts) if (n > 1) freq.set(n, (freq.get(n) || 0) + 1);
    let width = 0; let hits = 0;
    for (const [n, f] of freq) if (f > hits || (f === hits && n > width)) { width = n; hits = f; }
    if (!width) continue;
    const score = hits / counts.length;
    if (score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && width > best.width)) best = { d, score, width };
  }
  return best.d;
}

// Parse CSV text into an array of rows (arrays of strings).
// options: { delimiter, maxRows }
export function parseCSV(input, options = {}) {
  if (typeof input !== 'string') fail('NOT_TEXT', 'The file could not be read as text. Please upload a .csv file.');
  const text = stripBom(input);
  if (options.delimiter !== undefined && !(typeof options.delimiter === 'string' && options.delimiter.length === 1 && options.delimiter !== '"' && options.delimiter !== '\n' && options.delimiter !== '\r')) {
    fail('BAD_OPTION', 'The delimiter option must be a single character such as "," or ";".');
  }
  const delim = options.delimiter || sniffDelimiter(text);
  const rows = parseRows(text, delim, options.maxRows || Infinity, !!options.maxRows);
  Object.defineProperty(rows, 'delimiter', { value: delim, enumerable: false });
  return rows;
}

function parseRows(text, delim, maxRows, lenient) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let quoteStartLine = 0;
  let line = 1;
  let i = 0;
  const n = text.length;
  let fieldStarted = false; // true once any char of the field was consumed

  const endField = () => {
    if (field.length > MAX_CELL_CHARS) fail('CELL_TOO_LONG', `A single value on line ${line} is longer than ${MAX_CELL_CHARS.toLocaleString('en-US')} characters, which no real export has. The file may be damaged or not a transaction export.`);
    row.push(field); field = ''; fieldStarted = false;
  };
  const endRow = () => { endField(); rows.push(row); row = []; };

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      if (c === '\r') {
        // Normalize CRLF and bare CR inside quoted fields to LF.
        field += '\n';
        if (text[i + 1] === '\n') i++;
        line++; i++; continue;
      }
      if (c === '\n') line++;
      field += c; i++; continue;
    }
    if (c === '"' && !fieldStarted) { inQuotes = true; fieldStarted = true; quoteStartLine = line; i++; continue; }
    if (c === delim) { endField(); i++; continue; }
    if (c === '\r' || c === '\n') {
      endRow();
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++; line++;
      if (rows.length >= maxRows) return rows;
      continue;
    }
    // Lenient: a quote in the middle of an unquoted field is literal text.
    field += c; fieldStarted = true; i++;
  }
  if (inQuotes) {
    if (lenient) { endRow(); return rows; }
    fail('UNTERMINATED_QUOTE', `This file looks cut off or damaged: a quoted value that starts on line ${quoteStartLine} never ends. Download the export again and upload the original file without opening it in a spreadsheet first.`);
  }
  if (fieldStarted || field !== '' || row.length > 0) endRow();
  return rows;
}

export function isBlankRow(row) {
  for (const v of row) if (v.trim() !== '') return false;
  return true;
}

function quoteField(v, delim) {
  const s = v == null ? '' : String(v);
  if (s === '') return '';
  if (s.includes('"') || s.includes(delim) || s.includes('\n') || s.includes('\r') || /^\s|\s$/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Serialize rows to CSV. Default CRLF per RFC 4180, trailing CRLF included.
export function writeCSV(rows, options = {}) {
  const delim = options.delimiter || ',';
  const eol = options.eol || '\r\n';
  let out = '';
  for (const r of rows) out += r.map((v) => quoteField(v, delim)).join(delim) + eol;
  return out;
}
