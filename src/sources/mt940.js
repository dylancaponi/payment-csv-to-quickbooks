// SWIFT MT940 customer statement (the .sta / .940 / .txt files European
// banks offer as "MT940"). Plain text, one field per tag:
//   :20: reference  :25: account  :28C: statement/sequence number
//   :60F:/:60M: opening balance (F = first page, M = intermediate page)
//   :61: statement line (one entry)  :86: information for the line above
//   :62F:/:62M: closing balance  :64: available balance  :65: forward balance
// Optional SWIFT envelope {1:...}{2:...}{4: ... -} around each message.
// :61: layout (SWIFT MT940 field 61): 6!n[4!n]2a[1!a]15d1!a3!c16x[//16x]
//   [34x on a second line]: value date YYMMDD, optional entry date MMDD,
//   D/C mark (D, C, RD = reversal of debit = money in, RC = reversal of
//   credit = money out), optional funds code letter, amount with a decimal
//   comma, transaction type (N/S/F + 3 characters), customer reference,
//   // bank reference, supplementary details.
// :86: dialects read here:
//   German "structured field 86" (DFU-Abkommen Anlage 3): GVC code then
//     ?00 booking text, ?20-?29 and ?60-?63 purpose, ?30 BIC/BLZ,
//     ?31 IBAN/account, ?32-?33 name; SEPA keywords EREF+, SVWZ+ etc inside
//     the purpose.
//   Dutch-style /TAG/value/ (ING, Rabobank, ABN AMRO): /TRTP/ /IBAN/ /BIC/
//     /NAME/ /REMI/ /EREF/ /CNTP/ and others.
//   Anything else is kept as free text.
import { fail } from '../errors.js';
import { isValidYMD } from '../dates.js';
import { finishStatements, swiftYear } from './statement.js';

const FIELD = /^:(\d{2}[A-Z]?):(.*)$/;

// Detection uses the start of the file for the header fields and the whole
// file for the closing balance, so a long statement is never refused for
// its size.
export function sniff(text) {
  const all = String(text).replace(/^\ufeff/, '');
  const head = all.slice(0, 20000);
  const at = (re, t = head) => re.test(t);
  const has20 = at(/(^|[\r\n{]|\{4:\s*):20:/);
  const has25 = at(/(^|[\r\n]):25[A-Z]?:/);
  const bal = at(/(^|[\r\n]):60[FM]:/);
  if (has20 && has25 && bal && (at(/(^|[\r\n]):6[12][FM]?:/) || at(/(^|[\r\n]):62[FM]:/, all))) return { kind: 'mt940' };
  if (has20 && has25 && (at(/(^|[\r\n]):34F:/) || at(/(^|[\r\n]):13D:/))) return { kind: 'mt942' };
  // Statement-shaped but incomplete: say what is missing instead of
  // falling through to the CSV message.
  if (has20 && has25 && at(/(^|[\r\n]):6[01][a-z]?:/i)) {
    if (at(/(^|[\r\n]):6[02][fm]:/)) return { kind: 'mt940-bad', reason: 'This looks like an MT940 statement, but its field letters are lower case (":60f:" instead of ":60F:"), so the file was changed after it was downloaded. Download the MT940 file again and upload it without opening it in another program.' };
    return { kind: 'mt940-bad', reason: 'This looks like an MT940 statement, but it has no opening balance (:60F:) or closing balance (:62F:). The file may be cut off. Download the MT940 file again and upload the whole file.' };
  }
  return null;
}

export function detect(text) {
  const s = sniff(text);
  if (s && s.kind === 'mt940') return { score: 0.98, reason: 'Found MT940 statement fields (:20:, :25:, :60F:, :61:, :62F:).' };
  return { score: 0 };
}

// Split the text into [tag, value] fields, dropping the SWIFT envelope.
function fieldsOf(text) {
  let t = String(text).replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
  t = t.replace(/\{1:[^}]*\}/g, '\n').replace(/\{2:[^}]*\}/g, '\n').replace(/\{3:(\{[^}]*\})*\}/g, '\n').replace(/\{5:(\{[^}]*\})*\}/g, '\n').replace(/\{4:/g, '\n').replace(/-\}/g, '\n');
  const out = [];
  out.stray = [];
  let cur = null;
  for (const line of t.split('\n')) {
    // Trailing spaces are kept: a :86: line cut at 65 characters can end
    // with the space between two words.
    const l = line;
    const m = FIELD.exec(l.trimEnd());
    if (m) { cur = [m[1], line.slice(m[1].length + 2)]; out.push(cur); continue; }
    const tl = l.trim();
    if (tl === '-' || tl === '') { if (tl === '-') cur = null; continue; }
    if (cur) cur[1] += '\n' + l;
    // Lines outside any field. Short header lines some banks put before each
    // message (a BIC such as ABNANL2A, "940", ":940:") are expected; anything
    // else is reported, never dropped silently.
    else if (!/^(:?940:?|[A-Z0-9]{1,11})$/.test(tl)) out.stray.push(tl);
  }
  return out;
}

function ymd(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function swiftDate(s) {
  const y = swiftYear(s.slice(0, 2)), m = +s.slice(2, 4), d = +s.slice(4, 6);
  return isValidYMD(y, m, d) ? ymd(y, m, d) : null;
}

// "1234,56" -> 123456 cents. More than two decimals: null.
function commaAmount(s) {
  const m = /^(\d{1,15}),(\d*)$/.exec(s);
  if (!m) return null;
  const frac = m[2].replace(/0+$/, '');
  if (frac.length > 2) return null;
  return +m[1] * 100 + +(frac.padEnd(2, '0') || '0');
}

function balance(v, tag) {
  const m = /^([CD])(\d{6})([A-Z]{3})([\d,]+)/.exec(v.replace(/\s+/g, ''));
  if (!m) return { bad: `the ${tag} balance "${v.trim()}" could not be read` };
  const date = swiftDate(m[2]);
  const cents = commaAmount(m[4]);
  if (!date || cents === null) return { bad: `the ${tag} balance "${v.trim()}" could not be read` };
  return { cents: m[1] === 'D' ? -cents : cents, date, currency: m[3] };
}

// :61: first line, see the header comment.
const LINE61 = /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?(\d{1,15},\d*)([NSF][A-Z0-9]{3})(.*)$/;

function line61(v) {
  const [first, ...rest] = v.split('\n');
  const m = LINE61.exec(first.replace(/\s+$/, ''));
  if (!m) return null;
  const valueDate = swiftDate(m[1]);
  if (!valueDate) return null;
  let entryDate = null;
  if (m[2]) {
    const em = +m[2].slice(0, 2), ed = +m[2].slice(2, 4);
    let y = +valueDate.slice(0, 4);
    const vm = +valueDate.slice(5, 7);
    if (vm === 12 && em === 1) y++;
    else if (vm === 1 && em === 12) y--;
    entryDate = isValidYMD(y, em, ed) ? ymd(y, em, ed) : 'bad';
  }
  const cents = commaAmount(m[5]);
  if (cents === null) return null;
  const mark = m[3];
  const sign = mark === 'C' || mark === 'RD' ? 1 : -1;
  const refs = m[7];
  const cut = refs.indexOf('//');
  const custRef = (cut >= 0 ? refs.slice(0, cut) : refs).trim();
  const bankRef = cut >= 0 ? refs.slice(cut + 2).trim() : '';
  return { valueDate, entryDate, mark, cents: sign * cents, typeCode: m[6], custRef, bankRef, extra: rest.join(' ').trim() };
}

const SEPA = /(EREF|KREF|MREF|CRED|DEBT|SVWZ|ABWA|ABWE|IBAN|BIC|COAM|OAMT)\+/g;
const TAGS = ['TRTP', 'EREF', 'IBAN', 'BIC', 'NAME', 'REMI', 'ORDP', 'BENM', 'CNTP', 'MARF', 'CSID', 'PREF', 'ULTD', 'ULTC', 'ULTB', 'PURP', 'RTRN', 'ISDT', 'ADDR', 'USTD', 'STRD', 'CDTRREF', 'CDTRREFTP', 'SVCL', 'TRCD', 'BUSP', 'IREF', 'CREF', 'CHGS', 'EXCH', 'OCMT'];
const TAG_AT = new RegExp(`(?=/(${TAGS.join('|')})/)`, 'g');
// ING's charges, exchange rate and original amount code words. They follow
// the other code words ("...//CHGS/EUR2,50/"), so they count as structure
// only right after a closing "/", never at the start of the field and never
// inside free text such as "Fee /CHGS/ text".
const WEAK_TAGS = new Set(['CHGS', 'EXCH', 'OCMT']);

function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function notProvided(s) {
  const v = clean(s);
  // ING's :61: subfield 7 can hold the reference TYPE (EREF, CREF, PREF,
  // IREF) instead of a reference; like NONREF it is not a reference.
  return !v || /^(NOTPROVIDED|NONREF|NONE|EREF|CREF|PREF|IREF)$/i.test(v) ? '' : v;
}

// German structured :86: (GVC + ?NN subfields).
function german(v) {
  const t = v.replace(/\n/g, '');
  const gvc = t.slice(0, 3);
  const sub = {};
  const re = /\?(\d{2})/g;
  const marks = [];
  let m;
  while ((m = re.exec(t))) marks.push([m[1], m.index]);
  marks.forEach(([code, at], i) => {
    const end = i + 1 < marks.length ? marks[i + 1][1] : t.length;
    (sub[code] = sub[code] || []).push(t.slice(at + 3, end));
  });
  const get = (codes) => codes.flatMap((c) => sub[c] || []);
  const purposeParts = get(['20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '60', '61', '62', '63']);
  const joined = purposeParts.join('');
  let description = '';
  let reference = '';
  let counterpartyAccount = clean(get(['31']).join(''));
  if (SEPA.test(joined)) {
    SEPA.lastIndex = 0;
    const tags = {};
    const ms = [...joined.matchAll(SEPA)];
    ms.forEach((x, i) => { const end = i + 1 < ms.length ? ms[i + 1].index : joined.length; tags[x[1]] = clean(joined.slice(x.index + x[0].length, end)); });
    description = tags.SVWZ || '';
    reference = notProvided(tags.EREF) || notProvided(tags.KREF);
    if (!counterpartyAccount && tags.IBAN) counterpartyAccount = tags.IBAN;
    if (!description) description = clean(joined.replace(SEPA, ' '));
  } else {
    description = clean(purposeParts.join(' '));
  }
  SEPA.lastIndex = 0;
  const bookingText = clean(get(['00']).join(''));
  return { counterparty: clean(get(['32', '33']).join('')), counterpartyAccount, description: description || bookingText, reference, bookingText, gvc };
}

// /TAG/value/ style :86:.
function tagged(v) {
  const t = v.replace(/\n/g, '');
  const pos = [...t.matchAll(TAG_AT)].filter((x) => !WEAK_TAGS.has(x[1]) || (x.index > 0 && t[x.index - 1] === '/')).map((x) => [x[1], x.index]);
  const vals = [];
  pos.forEach(([tag, at], i) => {
    const start = at + tag.length + 2;
    const end = i + 1 < pos.length ? pos[i + 1][1] : t.length;
    vals.push([tag, end > start ? t.slice(start, end) : '']);
  });
  const first = (tag) => { const f = vals.find((x) => x[0] === tag && clean(x[1].replace(/^\/+|\/+$/g, ''))); return f ? clean(f[1].replace(/^\/+|\/+$/g, '')) : ''; };
  let counterparty = first('NAME');
  let counterpartyAccount = first('IBAN');
  // CNTP (ING): /CNTP/account/BIC/name/city/ with empty parts kept.
  const cntpRaw = vals.find((x) => x[0] === 'CNTP');
  if (cntpRaw) {
    const p = cntpRaw[1].split('/');
    if (!counterpartyAccount && p[0]) counterpartyAccount = clean(p[0]);
    if (!counterparty && p[2]) counterparty = clean(p[2]);
  }
  let description = first('USTD') || first('REMI');
  let reference = notProvided(first('EREF'));
  const strd = first('STRD');
  // /REMI/STRD/CUR/<reference>/ (ING): a structured creditor reference.
  if (strd && !reference) reference = clean(strd.split('/').filter(Boolean).pop());
  const bookingText = first('TRTP');
  return { counterparty, counterpartyAccount, description: description || bookingText, reference, bookingText };
}

export function info86(v) {
  if (!v) return { counterparty: '', counterpartyAccount: '', description: '', reference: '', bookingText: '' };
  const flat = v.replace(/\n/g, '');
  if (/^\d{3}\?\d{2}/.test(flat)) return { dialect: 'german', ...german(v) };
  if (TAGS.some((tag) => !WEAK_TAGS.has(tag) && flat.startsWith(`/${tag}/`))) return { dialect: 'tagged', ...tagged(v) };
  return { dialect: 'free', counterparty: '', counterpartyAccount: '', description: clean(v), reference: '', bookingText: '' };
}

export function parse(text, options = {}, warnings = []) {
  const s = sniff(text);
  if (s && s.kind === 'mt942') fail('WRONG_SOURCE', 'This is an MT942 interim (intraday) report, not an MT940 statement. MT942 has no opening and closing balances, so it cannot be checked. Download the MT940 statement (end of day) from your bank instead.');
  if (s && s.kind === 'mt940-bad') fail('BAD_FILE', s.reason);
  if (!s) fail('WRONG_SOURCE', "This doesn't look like an MT940 statement: we couldn't find the :20:, :25:, :60F: and :62F: fields. In your online banking choose the MT940 (sometimes called SWIFT or .sta) statement download.");
  const fields = fieldsOf(text);
  const statements = [];
  let st = null;
  let last = null;
  let bad = 0, read = 0;
  const dialects = new Set();
  const start = () => { st = { account: '', currency: '', number: '', opening: null, closing: null, entries: [], ref: '' }; statements.push(st); last = null; };
  for (const [tag, value] of fields) {
    if (tag === '20' || (tag.startsWith('25') && st && st.account && (st.entries.length || st.closing))) start();
    if (!st) start();
    if (tag === '20') st.ref = clean(value);
    else if (tag.startsWith('25')) st.account = clean(value);
    else if (tag === '28C' || tag === '28') st.number = clean(value);
    else if (tag === '60F' || tag === '60M') {
      const b = balance(value, 'opening');
      if (b.bad) fail('BAD_FILE', `This MT940 file is damaged: ${b.bad}.`);
      st.opening = b; st.currency = b.currency;
    } else if (tag === '62F' || tag === '62M') {
      const b = balance(value, 'closing');
      if (b.bad) fail('BAD_FILE', `This MT940 file is damaged: ${b.bad}.`);
      st.closing = b;
      if (!st.currency) st.currency = b.currency;
      else if (b.currency !== st.currency) warnings.push(`Statement ${st.number || st.ref} opens in ${st.currency} but closes in ${b.currency}. Check this file with your bank.`);
      last = null;
    } else if (tag === '61') {
      read++;
      const e = line61(value);
      if (!e) { bad++; last = null; warnings.push(`Skipped an MT940 entry we could not read: ":61:${value.split('\n')[0]}". The statement balance check below will show the difference.`); continue; }
      if (e.entryDate === 'bad') { warnings.push(`The entry ":61:${value.split('\n')[0]}" has an impossible booking date; its value date was used.`); e.entryDate = null; }
      last = { e, raw61: value, raw86: '' };
      st.entries.push(last);
    } else if (tag === '86') {
      if (last) last.raw86 = value;
    }
  }
  if (fields.stray.length) warnings.push(`${fields.stray.length === 1 ? '1 line of this file is' : `${fields.stray.length} lines of this file are`} outside any MT940 statement and ${fields.stray.length === 1 ? 'was' : 'were'} not read: "${fields.stray[0].slice(0, 60)}"${fields.stray.length === 1 ? '' : ' and others'}. If ${fields.stray.length === 1 ? 'it holds a booking' : 'they hold bookings'}, the file is damaged or several files were joined in an unusual way; check the totals against your bank.`);
  for (const s2 of statements) {
    if (!s2.account && !s2.opening) fail('BAD_FILE', `Part of this MT940 file starting at ":20:${s2.ref}" has no account (:25:) and no opening balance (:60F:). The file may be damaged, or a description line starts with ":20:". Download the statement again from your bank.`);
  }
  for (const s2 of statements) {
    if (!s2.closing) fail('BAD_FILE', `Statement ${s2.number || s2.ref || '(no number)'} in this MT940 file has no closing balance (:62F:), which every MT940 statement carries. The file is probably cut off. Download the MT940 file again and upload the whole file.`);
    if (!s2.currency) fail('BAD_FILE', `Statement ${s2.number || s2.ref || '(no number)'} in this MT940 file has no :60F: opening balance, so its currency is unknown. We do not guess currencies. Download the statement again from your bank.`);
    if (!s2.account) s2.account = '(no account number)';
    // "NL20INGB0001234567EUR" (ING) and "NL68RABO0123456789 EUR" (Rabobank)
    // carry the currency after the account number.
    const am = /^(.*\d)\s*([A-Z]{3})$/.exec(s2.account);
    if (am && am[2] === s2.currency) s2.account = am[1];
    s2.entries = s2.entries.map(({ e, raw61, raw86 }, i) => {
      const info = info86(raw86);
      if (raw86) dialects.add(info.dialect);
      const custRef = notProvided(e.custRef);
      const reference = info.reference || custRef;
      const idParts = [custRef, notProvided(e.bankRef)].filter(Boolean);
      // Rabobank writes the counterparty account on the second :61: line;
      // ING writes codes such as /TRCD/00100/ there.
      const line2 = clean(e.extra);
      const ibanLine = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(line2) ? line2 : '';
      const description = info.description || (ibanLine || line2.startsWith('/') ? '' : line2) || custRef || info.bookingText || e.typeCode;
      return {
        date: e.entryDate || e.valueDate,
        valueDate: e.valueDate,
        cents: e.cents,
        counterparty: info.counterparty || undefined,
        counterpartyAccount: info.counterpartyAccount || ibanLine || undefined,
        description: (e.mark === 'RC' || e.mark === 'RD') ? `Reversal: ${description}` : description,
        reference: reference || undefined,
        id: idParts.length ? idParts.join('//') : undefined,
        type: /^[NSF](CHG|COM)$/.test(e.typeCode) ? 'fee' : 'other',
        raw: { 'MT940 :61:': raw61, 'MT940 :86:': raw86, 'Statement': s2.number || s2.ref || '', 'Entry': String(i + 1) },
      };
    });
  }
  const res = finishStatements(statements, options, warnings, 'MT940');
  res.meta.rowsRead = read;
  res.meta.rowsSkipped = bad;
  res.meta.format = 'MT940';
  if (dialects.size) res.meta.infoDialects = [...dialects].sort();
  return res;
}
