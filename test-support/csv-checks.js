// Independent checkers for the CSV targets, used only by tests. Includes its
// own small strict RFC 4180 reader so a bug in the engine's CSV code cannot
// mask a bug in the writers.

export function strictParse(text) {
  const rows = [];
  let row = [];
  let f = '';
  let q = false;
  let i = 0;
  let quotedField = false;
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i += 2; continue; } q = false; i++; continue; }
      f += c; i++; continue;
    }
    if (c === '"') {
      if (f !== '' || quotedField) throw new Error(`Quote inside unquoted field at offset ${i}`);
      q = true; quotedField = true; i++; continue;
    }
    if (c === ',') { row.push(f); f = ''; quotedField = false; i++; continue; }
    if (c === '\r') {
      if (text[i + 1] !== '\n') throw new Error(`Bare CR at offset ${i}`);
      row.push(f); rows.push(row); row = []; f = ''; quotedField = false; i += 2; continue;
    }
    if (c === '\n') throw new Error(`Bare LF record ending at offset ${i}`);
    f += c; i++;
  }
  if (q) throw new Error('Unterminated quote');
  if (f !== '' || row.length) throw new Error('Missing final CRLF');
  return rows;
}

const DATE_RE = {
  'MM/DD/YYYY': /^(\d{2})\/(\d{2})\/(\d{4})$/,
  'DD/MM/YYYY': /^(\d{2})\/(\d{2})\/(\d{4})$/,
  'YYYY-MM-DD': /^(\d{4})-(\d{2})-(\d{2})$/,
};

function validDate(v, fmt) {
  const m = DATE_RE[fmt].exec(v);
  if (!m) return false;
  let y; let mo; let d;
  if (fmt === 'MM/DD/YYYY') { mo = +m[1]; d = +m[2]; y = +m[3]; }
  else if (fmt === 'DD/MM/YYYY') { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else { y = +m[1]; mo = +m[2]; d = +m[3]; }
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

const MONEY = /^-?\d+\.\d{2}$/;
const POS_MONEY = /^\d+\.\d{2}$/;
const cents = (v) => { const neg = v.startsWith('-'); const [a, b] = v.replace('-', '').split('.'); return (Number(a) * 100 + Number(b)) * (neg ? -1 : 1); };

export function checkQboCsv(text, { columns = 3, dateFormat = 'MM/DD/YYYY', maxRows = Infinity } = {}) {
  const errors = [];
  if (text.charCodeAt(0) === 0xfeff) errors.push('BOM present');
  let rows;
  try { rows = strictParse(text); } catch (e) { return { errors: [e.message], sumCents: 0, rows: [] }; }
  const head = columns === 3 ? ['Date', 'Description', 'Amount'] : ['Date', 'Description', 'Credit', 'Debit'];
  if (JSON.stringify(rows[0]) !== JSON.stringify(head)) errors.push(`Header is ${JSON.stringify(rows[0])}`);
  let sum = 0;
  const data = rows.slice(1);
  if (data.length > maxRows) errors.push(`${data.length} rows exceeds ${maxRows}`);
  data.forEach((r, i) => {
    const at = `row ${i + 2}`;
    if (r.length !== head.length) { errors.push(`${at}: ${r.length} fields`); return; }
    if (!validDate(r[0], dateFormat)) errors.push(`${at}: bad date "${r[0]}"`);
    if (!r[1] || /^[\d\s.,\-+#]+$/.test(r[1])) errors.push(`${at}: description empty or numeric only`);
    if (/[^\x20-\x7e]/.test(r[1])) errors.push(`${at}: non-ASCII description`);
    if (columns === 3) {
      if (!MONEY.test(r[2]) || cents(r[2]) === 0) errors.push(`${at}: bad amount "${r[2]}"`);
      else sum += cents(r[2]);
    } else {
      const [cr, dr] = [r[2], r[3]];
      if ((cr === '') === (dr === '')) errors.push(`${at}: exactly one of Credit/Debit must be filled`);
      else if (cr !== '') { if (!POS_MONEY.test(cr) || cents(cr) === 0) errors.push(`${at}: bad credit "${cr}"`); else sum += cents(cr); }
      else if (!POS_MONEY.test(dr) || cents(dr) === 0) errors.push(`${at}: bad debit "${dr}"`); else sum -= cents(dr);
    }
  });
  return { errors, sumCents: sum, rows: data };
}

export function checkXeroCsv(text, { dateFormat = 'MM/DD/YYYY', us = true } = {}) {
  const errors = [];
  let rows;
  try { rows = strictParse(text); } catch (e) { return { errors: [e.message], sumCents: 0, rows: [] }; }
  const head = ['*Date', '*Amount', 'Payee', 'Description', 'Reference', us ? 'Check Number' : 'Cheque Number'];
  if (JSON.stringify(rows[0]) !== JSON.stringify(head)) errors.push(`Header is ${JSON.stringify(rows[0])}`);
  let sum = 0;
  const data = rows.slice(1);
  if (data.length > 100000) errors.push('More than 100,000 rows');
  data.forEach((r, i) => {
    const at = `row ${i + 2}`;
    if (r.length !== head.length) { errors.push(`${at}: ${r.length} fields`); return; }
    if (!validDate(r[0], dateFormat)) errors.push(`${at}: bad date "${r[0]}"`);
    if (!MONEY.test(r[1]) || cents(r[1]) === 0) errors.push(`${at}: bad amount "${r[1]}"`); else sum += cents(r[1]);
    if (!r[3] && !r[2]) errors.push(`${at}: no payee or description`);
    if (r.some((v) => /[\u0000-\u001f]/.test(v))) errors.push(`${at}: control character in a field`);
  });
  return { errors, sumCents: sum, rows: data };
}

export function checkJournal(text, { dateFormat = 'MM/DD/YYYY', maxLines = Infinity } = {}) {
  const errors = [];
  let rows;
  try { rows = strictParse(text); } catch (e) { return { errors: [e.message], entries: new Map() }; }
  const head = ['Journal No.', 'Journal Date', 'Account Name', 'Debits', 'Credits', 'Description', 'Name'];
  if (JSON.stringify(rows[0]) !== JSON.stringify(head)) errors.push(`Header is ${JSON.stringify(rows[0])}`);
  const data = rows.slice(1);
  if (data.length > maxLines) errors.push(`${data.length} lines exceeds ${maxLines}`);
  const entries = new Map();
  let lastNo = null;
  const closed = new Set();
  data.forEach((r, i) => {
    const at = `line ${i + 2}`;
    if (r.length !== head.length) { errors.push(`${at}: ${r.length} fields`); return; }
    const [no, date, account, dr, cr] = r;
    if (!no || no.length > 21) errors.push(`${at}: Journal No. must be 1-21 characters`);
    if (!validDate(date, dateFormat)) errors.push(`${at}: bad date "${date}"`);
    if (!account) errors.push(`${at}: empty account`);
    if ((dr === '') === (cr === '')) errors.push(`${at}: exactly one of Debits/Credits must be filled`);
    for (const v of [dr, cr]) if (v !== '' && (!POS_MONEY.test(v) || cents(v) === 0)) errors.push(`${at}: bad money "${v}"`);
    if (no !== lastNo) { if (closed.has(no)) errors.push(`${at}: entry ${no} lines are not contiguous`); if (lastNo) closed.add(lastNo); lastNo = no; }
    if (!entries.has(no)) entries.set(no, { date, debit: 0, credit: 0, lines: [] });
    const e = entries.get(no);
    if (e.date !== date) errors.push(`${at}: entry ${no} has more than one date`);
    if (dr) e.debit += cents(dr);
    if (cr) e.credit += cents(cr);
    e.lines.push({ account, dr, cr, desc: r[5] });
  });
  for (const [no, e] of entries) if (e.debit !== e.credit) errors.push(`Entry ${no} does not balance: debits ${e.debit} credits ${e.credit}`);
  return { errors, entries };
}
