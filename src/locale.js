// Decisions that change money or dates are never guessed silently. These
// helpers either decide from the data (and say so in a warning), use the
// caller's explicit option, or throw an EngineError whose `details` lists the
// candidate interpretations so the UI can ask the user.
import { fail } from './errors.js';
import { analyzeDecimal, parseMoney, decimalVote } from './money.js';
import { parseDate, sniffDateOrder, utcToZoneDate, isValidTimeZone, parseIsoTimestamp } from './dates.js';

export function checkParseOptions(options) {
  if (options === null || typeof options !== 'object') fail('BAD_OPTION', 'Options must be an object.');
  if (options.decimal !== undefined && options.decimal !== '.' && options.decimal !== ',') fail('BAD_OPTION', 'The decimal option must be "." or ",".');
  if (options.dateOrder !== undefined && options.dateOrder !== 'mdy' && options.dateOrder !== 'dmy') fail('BAD_OPTION', 'The dateOrder option must be "mdy" (month first) or "dmy" (day first).');
  if (options.timeZone !== undefined && !isValidTimeZone(options.timeZone)) fail('BAD_OPTION', `"${String(options.timeZone)}" is not a time zone we recognize. Use a name like "America/Los_Angeles" or "Europe/Berlin".`);
  if (options.mapping !== undefined && (options.mapping === null || typeof options.mapping !== 'object')) fail('BAD_OPTION', 'The mapping option must be an object such as { date: "Date", amount: "Amount" }.');
  if (options.currency !== undefined && !/^[A-Za-z]{3}$/.test(String(options.currency))) fail('BAD_OPTION', 'The currency option must be a 3-letter code such as USD.');
}

// Record that a value was assumed rather than confirmed by the data.
function assume(options, key, sample) {
  const ctx = options._ctx;
  if (!ctx) return;
  ctx.meta[key] = true;
  if (!ctx.meta.assumptionSamples) ctx.meta.assumptionSamples = [];
  if (!ctx.meta.assumptionSamples.some((s) => s.kind === sample.kind)) ctx.meta.assumptionSamples.push(sample);
}

function decimalSample(sample) {
  return { kind: 'decimal', option: 'decimal', sample, readings: [{ decimal: '.', amount: centsToNumber(parseMoney(sample, '.')) }, { decimal: ',', amount: centsToNumber(parseMoney(sample, ',')) }] };
}

function dateSample(sample) {
  return { kind: 'dateOrder', option: 'dateOrder', sample, readings: [{ dateOrder: 'mdy', date: parseDate(sample, 'mdy') }, { dateOrder: 'dmy', date: parseDate(sample, 'dmy') }] };
}

// values: raw amount strings from the money columns.
// fallback: the platform's fixed convention, used instead of an error when
// the values cannot decide (platform exports never raise).
export function resolveDecimal(values, options, warnings, label = 'this file', fallback = null) {
  const commaDelimited = !!(options._ctx && options._ctx.delimiter === ',');
  const a = analyzeDecimal(values, { commaDelimited });
  const sample = a.ambiguousSample || values.find((v) => v && /[.,]/.test(String(v))) || values.find((v) => v && String(v).trim()) || '';
  // The file's own data wins whenever it settles the question; the option
  // only breaks a genuine tie.
  if (a.votes.dot && a.votes.comma) {
    const dotEx = values.find((v) => decimalVote(v, { commaDelimited }) === '.');
    const commaEx = values.find((v) => decimalVote(v, { commaDelimited }) === ',');
    fail('AMBIGUOUS_NUMBER_FORMAT', `The amounts in ${label} mix two number styles: "${dotEx}" only makes sense with "." as the decimal point and "${commaEx}" only with ",". Check the file; it may combine exports from different places.`, {
      kind: 'decimal', option: 'decimal', mixed: true, sample: dotEx,
      samples: [{ decimal: '.', value: dotEx }, { decimal: ',', value: commaEx }],
      candidates: [{ decimal: '.', amount: centsToNumber(parseMoney(dotEx, '.')) }, { decimal: ',', amount: centsToNumber(parseMoney(dotEx, ',')) }],
    });
  }
  if (options.decimal && !a.decimal) {
    if (a.votes.ambiguous) {
      assume(options, 'decimalAssumed', decimalSample(sample));
      warnings.push(`Amounts in ${label} such as "${sample}" can be read two ways; we used "${options.decimal}" as the decimal separator as chosen. Please confirm in the preview.`);
    }
    return options.decimal;
  }
  if (options.decimal && a.decimal && a.decimal !== options.decimal) {
    const ex = values.find((v) => decimalVote(v, { commaDelimited }) === a.decimal);
    warnings.push(`You chose "${options.decimal}" as the decimal separator, but amounts in ${label} such as "${ex}" can only be read with "${a.decimal}", so we used "${a.decimal}" and ignored the setting.`);
  }
  if (a.decimal) {
    if (a.votes.ambiguous) {
      warnings.push(`${a.votes.ambiguous} amount(s) in ${label}, like "${a.ambiguousSample}", could be read two ways. Other amounts in the file use "${a.decimal}" as the decimal separator, so we read them that way.`);
    }
    return a.decimal;
  }
  if (fallback) {
    assume(options, 'decimalAssumed', decimalSample(sample));
    warnings.push(`Amounts in ${label} such as "${sample}" could be read two ways; this platform writes "${fallback}" as the decimal separator, so we read them that way.`);
    return fallback;
  }
  const asDot = parseMoney(sample, '.');
  const asComma = parseMoney(sample, ',');
  fail('AMBIGUOUS_NUMBER_FORMAT', a.votes.dot && a.votes.comma
    ? `The amounts in ${label} mix "1,234.56" and "1.234,56" styles, so we cannot tell which separator is the decimal point. Tell us which one your bank uses.`
    : `We can't tell how to read amounts like "${sample}" in ${label}: it could be ${fmt(asDot)} or ${fmt(asComma)}. Tell us whether "." or "," is the decimal separator.`,
  {
    kind: 'decimal',
    option: 'decimal',
    sample,
    candidates: [
      { decimal: '.', amount: centsToNumber(asDot) },
      { decimal: ',', amount: centsToNumber(asComma) },
    ],
  });
  return '.';
}

function centsToNumber(c) { return c === null || Number.isNaN(c) ? null : c / 100; }
function fmt(c) { return c === null || Number.isNaN(c) ? 'unreadable' : (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

const ORDER_NAME = { mdy: 'month/day/year', dmy: 'day/month/year' };

// hint: { order, reason } from source knowledge (the time zone a PayPal export
// prints, a platform's fixed format), used only when the dates cannot decide.
export function resolveDateOrder(values, options, warnings, label = 'this file', hint = null) {
  const sn = sniffDateOrder(values);
  if (sn.conflicting) {
    fail('MIXED_DATE_FORMATS', `${label[0].toUpperCase() + label.slice(1)} mixes date formats: "${sn.mdyEvidence}" only makes sense as month/day/year, but "${sn.dmyEvidence}" only makes sense as day/month/year. Check the file; it may combine exports from different places.`, {
      kind: 'dateOrder', mixed: true,
      samples: [{ dateOrder: 'mdy', value: sn.mdyEvidence, date: parseDate(sn.mdyEvidence, 'mdy') }, { dateOrder: 'dmy', value: sn.dmyEvidence, date: parseDate(sn.dmyEvidence, 'dmy') }],
    });
  }
  if (!sn.numeric) return options.dateOrder || 'mdy';
  // Evidence in the data (a part above 12) always wins over the option.
  if (sn.evidence) {
    if (options.dateOrder && options.dateOrder !== sn.order) warnings.push(`You chose ${ORDER_NAME[options.dateOrder]}, but dates in ${label} such as "${sn.evidence}" can only be ${ORDER_NAME[sn.order]}, so we read every date that way and ignored the setting.`);
    else warnings.push(`Dates in ${label} are read as ${ORDER_NAME[sn.order]} because "${sn.evidence}" can only be read that way.`);
    return sn.order;
  }
  if (options.dateOrder) {
    if (sn.ambiguous || sn.dotted) {
      assume(options, 'dateOrderAssumed', dateSample(sn.sample));
      warnings.push(`Dates in ${label} such as "${sn.sample}" can be read as month/day or day/month; we used ${ORDER_NAME[options.dateOrder]} as chosen. Please confirm in the preview.`);
    }
    return options.dateOrder;
  }
  if (!sn.ambiguous) {
    if (sn.dotted) warnings.push(`Dates in ${label} use dots (like "${sn.sample}"), which means day/month/year, so we read them that way.`);
    return sn.order;
  }
  if (hint && hint.order) {
    assume(options, 'dateOrderAssumed', dateSample(sn.sample));
    warnings.push(`Dates in ${label} like "${sn.sample}" could be month/day or day/month; ${hint.reason}, so we read them as ${ORDER_NAME[hint.order]}.`);
    return hint.order;
  }
  fail('AMBIGUOUS_DATE_ORDER', `We can't tell whether "${sn.sample}" in ${label} is ${long(parseDate(sn.sample, 'mdy'))} or ${long(parseDate(sn.sample, 'dmy'))}. Tell us whether your dates are month/day/year or day/month/year.`, {
    kind: 'dateOrder',
    option: 'dateOrder',
    sample: sn.sample,
    candidates: [
      { dateOrder: 'mdy', date: parseDate(sn.sample, 'mdy') },
      { dateOrder: 'dmy', date: parseDate(sn.sample, 'dmy') },
    ],
  });
  return 'mdy';
}

const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function long(iso) {
  if (!iso) return 'not a valid date';
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTH[m - 1]} ${d}, ${y}`;
}

// UTC timestamp handling shared by Venmo, Stripe and Gumroad.
// Returns a function raw -> 'YYYY-MM-DD'.
// - ISO timestamps with a time are converted to options.timeZone (an
//   explicit offset or Z in the text is honoured; none means UTC).
// - Anything else (a date only, or a timestamp re-saved by a spreadsheet such
//   as "7/1/2025 2:12") has lost its time zone meaning: it is not converted
//   and a warning says so.
// Without options.timeZone dates stay UTC dates and a warning says so.
export function utcDateReader(options, warnings, meta, label, values = []) {
  const tz = options.timeZone;
  // Non-ISO values (re-saved files) use the order the data settles, else the
  // platform's US convention, marked as assumed.
  const nonIso = values.filter((v) => v && !parseIsoTimestamp(v));
  const order = nonIso.length ? resolveDateOrder(nonIso, options, warnings, `this ${label} file`, { order: 'mdy', reason: `${label} and spreadsheets in the US write month/day/year` }) : 'mdy';
  meta.timeZone = tz || 'UTC';
  let unconverted = 0;
  let warnedFormat = false;
  if (!tz) warnings.push(`${label} times are in UTC and no time zone was chosen, so dates are UTC dates. A transaction late in the evening in the Americas (or early morning in Asia) can land on the next (or previous) day, and possibly in another month. Choose your time zone to fix this.`);
  return (raw) => {
    const p = parseIsoTimestamp(raw);
    if (p) {
      if (tz) return utcToZoneDate(raw, tz);
      if (p.explicit) return utcToZoneDate(raw, 'UTC');
      return parseDate(raw);
    }
    const d = parseDate(raw, order);
    if (d && tz && /\d{1,2}:\d{2}/.test(String(raw))) {
      unconverted++;
      meta.timeZone = `${tz} (some dates not converted)`;
      meta.datesNotConverted = unconverted;
      if (!warnedFormat) {
        warnedFormat = true;
        warnings.push(`Some ${label} timestamps (like "${String(raw).trim()}") are not in ${label}'s own format, which usually means the file was opened and re-saved in a spreadsheet. Their time zone can no longer be trusted, so those dates were not converted to ${tz} and are kept as printed. Download the file again from ${label} for exact dates.`);
      }
    }
    return d;
  };
}
