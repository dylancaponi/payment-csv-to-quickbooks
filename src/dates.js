// Date helpers. Output is always an ISO calendar date 'YYYY-MM-DD'.
// Dates that an export prints in local time are kept exactly as printed.
// Timestamps an export prints in UTC (Venmo, Stripe *_utc, Gumroad) are
// converted to options.timeZone before the date is taken (see utcToZoneDate);
// without that option they stay UTC dates, which can be one day later than the
// user's local date for evening transactions, and the parser warns about it.

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function pad(n) { return String(n).padStart(2, '0'); }

export function isValidYMD(y, m, d) {
  if (!Number.isInteger(y) || y < 1900 || y > 2200) return false;
  if (m < 1 || m > 12 || d < 1) return false;
  const dim = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= dim[m - 1];
}

function ymd(y, m, d) {
  return isValidYMD(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
}

function year2(y) {
  if (y.length === 4) return Number(y);
  const n = Number(y);
  return n >= 70 ? 1900 + n : 2000 + n;
}

const NUMERIC = /^(\d{1,2})([\/.\-])(\d{1,2})\2(\d{4}|\d{2})(?:[\sT,].*)?$/;

// Parse a date string. order: 'mdy' | 'dmy' for ambiguous numeric dates.
export function parseDate(input, order = 'mdy') {
  if (input === undefined || input === null) return null;
  const s = String(input).trim().replace(/^'/, '');
  if (!s) return null;
  let m;
  // ISO: 2025-04-08, 2025-04-08T11:37:36, 2025-04-08 11:37:36 EDT, 2025-04-08 11:37:36 +0000
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/.exec(s))) return ymd(+m[1], +m[2], +m[3]);
  // YYYY/MM/DD or YYYY.MM.DD
  if ((m = /^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})(?:$|[T\s])/.exec(s))) return ymd(+m[1], +m[2], +m[3]);
  // YYYYMMDD
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = NUMERIC.exec(s))) {
    const a = +m[1]; const b = +m[3]; const y = year2(m[4]);
    return order === 'dmy' ? ymd(y, b, a) : ymd(y, a, b);
  }
  // "January 30, 2025", "Jan 5 2025"
  if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:$|[\s,])/.exec(s))) {
    const mo = MONTHS[m[1].toLowerCase()];
    return mo ? ymd(+m[3], mo, +m[2]) : null;
  }
  // "16 January, 2024", "03 Jan 2024", "30-Jan-2025", "30 Jan. 2025"
  if ((m = /^(\d{1,2})[\s\-]+([A-Za-z]{3,9})\.?[\s,\-]+(\d{4}|\d{2})(?:$|[\s,])/.exec(s))) {
    const mo = MONTHS[m[2].toLowerCase()];
    return mo ? ymd(year2(m[3]), mo, +m[1]) : null;
  }
  return null;
}

// Inspect a column of date strings and decide month/day order for numeric
// dates. Returns { order, ambiguous, conflicting, numeric, sample, evidence, dotted }.
// ambiguous: numeric dates exist but none has a part above 12 and they are
// not dotted (DD.MM.YYYY is treated as day first).
export function sniffDateOrder(values, fallback = 'mdy') {
  let mdy = 0; let dmy = 0; let numeric = 0; let dots = 0; let twoWay = 0;
  let sample = null; let evidence = null; let first = null; let mdyEvidence = null; let dmyEvidence = null;
  for (const raw of values) {
    const v = String(raw || '').trim();
    const m = NUMERIC.exec(v);
    if (!m) continue;
    numeric++;
    if (!first) first = v;
    if (m[2] === '.') dots++;
    const a = +m[1]; const b = +m[3];
    if (a !== b && a <= 12 && b <= 12) { twoWay++; if (!sample) sample = v; }
    if (a > 12 && b <= 12) { dmy++; if (!evidence) evidence = v; if (!dmyEvidence) dmyEvidence = v; }
    else if (b > 12 && a <= 12) { mdy++; if (!evidence) evidence = v; if (!mdyEvidence) mdyEvidence = v; }
  }
  const dotted = numeric > 0 && dots === numeric;
  if (!sample) sample = first;
  if (dmy && mdy) return { order: fallback, ambiguous: true, conflicting: true, numeric, sample: evidence || sample, evidence, dotted, mdyEvidence, dmyEvidence };
  if (dmy) return { order: 'dmy', ambiguous: false, conflicting: false, numeric, sample, evidence, dotted };
  if (mdy) return { order: 'mdy', ambiguous: false, conflicting: false, numeric, sample, evidence, dotted };
  if (dotted) return { order: 'dmy', ambiguous: false, conflicting: false, numeric, sample, evidence: null, dotted };
  // Dates like 01/01 or 05/05 read the same either way and decide nothing.
  return { order: fallback, ambiguous: twoWay > 0, conflicting: false, numeric, sample, evidence: null, dotted };
}

// Parse "YYYY-MM-DD[ T]HH:MM[:SS[.fff]][ ][Z|UTC|GMT|+HH:MM|+HHMM|+HH]".
// Returns { ms, explicit } (milliseconds since epoch, treating a timestamp
// without zone text as UTC) or null when the text is not in that shape.
export function parseIsoTimestamp(input) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|UTC|GMT|[+-]\d{2}(?::?\d{2})?)?\s*$/i.exec(String(input || '').trim());
  if (!m) return null;
  if (!isValidYMD(+m[1], +m[2], +m[3]) || +m[4] > 23 || +m[5] > 59) return null;
  let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const z = m[7];
  if (z && /^[+-]/.test(z)) {
    const sign = z[0] === '-' ? -1 : 1;
    const digits = z.slice(1).replace(':', '');
    const mins = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0);
    ms -= sign * mins * 60000;
  }
  return { ms, explicit: !!z };
}

// Convert a timestamp to the calendar date in an IANA time zone. An explicit
// offset or Z in the text is honoured; text without one is taken as UTC.
// Returns null when the text is not an ISO timestamp with a time.
const fmtCache = new Map();
export function utcToZoneDate(input, timeZone) {
  const p = parseIsoTimestamp(input);
  if (!p) return null;
  let f = fmtCache.get(timeZone);
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); fmtCache.set(timeZone, f); }
  const parts = {};
  for (const x of f.formatToParts(new Date(p.ms))) parts[x.type] = x.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// Format 'YYYY-MM-DD' into a target pattern made of YYYY, MM, DD tokens.
export function formatDate(iso, pattern = 'YYYY-MM-DD') {
  const [y, m, d] = iso.split('-');
  return pattern.replace('YYYY', y).replace('MM', m).replace('DD', d);
}

export const DATE_FORMATS = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'YYYY/MM/DD', 'DD-MM-YYYY', 'DD.MM.YYYY', 'MM-DD-YYYY'];

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function lastDayOfMonth(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m, 0));
  return `${y}-${pad(m)}-${pad(dt.getUTCDate())}`;
}
