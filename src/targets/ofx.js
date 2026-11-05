// OFX 1.0.2 SGML writer used for three targets:
//  qbo: QuickBooks Web Connect (.qbo), with INTU.BID
//  qfx: Quicken Web Connect (.qfx), with INTU.BID
//  ofx: generic OFX 1.0.2 (.ofx), no Intuit extensions
// Rules applied (see FORMATS.md): 9-line header + blank line, CRLF, ASCII
// only, & < > escaped, NAME <= 32, MEMO <= 255, ACCTID <= 22, FITID
// deterministic and <= 32, DTPOSTED at noon, CREDIT/DEBIT by sign, credit
// cards in CREDITCARDMSGSRSV1/CCSTMTRS/CCACCTFROM, LEDGERBAL always present.
import { fail } from '../errors.js';
import { formatCents, toCents, parseMoney } from '../money.js';
import { addDays } from '../dates.js';
import { fnv1a64 } from '../hash.js';
import { noteSplit, validateTxns, selectCurrency, toLines, asciiText, truncate, dateRange, sumCents, slug, checkAmountDigits } from './common.js';

const ACCT_TYPES = { checking: 'CHECKING', savings: 'SAVINGS', moneymrkt: 'MONEYMRKT', moneymarket: 'MONEYMRKT', creditline: 'CREDITLINE', creditcard: 'CREDITCARD', credit: 'CREDITCARD', cc: 'CREDITCARD' };

export const QBO_ONLINE_MAX_ROWS = 1000;
export const QBO_ONLINE_MAX_BYTES = 350 * 1024;

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clean(s, n) {
  const v = truncate(asciiText(s), n);
  return esc(v);
}

function dt(iso, time = '120000') {
  return iso.replace(/-/g, '') + time;
}

function header() {
  return [
    'OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:102', 'SECURITY:NONE', 'ENCODING:USASCII', 'CHARSET:1252',
    'COMPRESSION:NONE', 'OLDFILEUID:NONE', 'NEWFILEUID:NONE', '', '',
  ].join('\r\n');
}

// Serialize a nested [tag, value|children] tree. Leaf elements get end tags
// when closeLeaves is true (allowed by OFX 1.0.2 and safest for strict
// non-Intuit parsers); aggregates always get end tags.
function render(node, closeLeaves, out, depth = 0) {
  const [tag, val] = node;
  const ind = '';
  void depth;
  if (Array.isArray(val)) {
    out.push(`${ind}<${tag}>`);
    for (const child of val) if (child) render(child, closeLeaves, out, depth + 1);
    out.push(`${ind}</${tag}>`);
  } else {
    out.push(closeLeaves ? `${ind}<${tag}>${val}</${tag}>` : `${ind}<${tag}>${val}`);
  }
}

export function accountKind(options) {
  const k = String(options.accountType || 'checking').toLowerCase().replace(/[^a-z]/g, '');
  const v = ACCT_TYPES[k];
  if (!v) fail('BAD_OPTION', `Unknown account type "${options.accountType}". Use checking, savings, moneymrkt, creditline or creditcard.`);
  return v;
}

function buildStatementBlock(lines, opts) {
  const { kind, currency, acctId, bankId, from, to, balanceCents, trnuid } = opts;
  const trns = lines.map((l) => {
    const name = clean(l.name || l.memo || 'Transaction', 32) || 'Transaction';
    const memo = clean(l.memo, 255);
    const children = [
      ['TRNTYPE', l.cents >= 0 ? 'CREDIT' : 'DEBIT'],
      ['DTPOSTED', dt(l.date)],
      ['TRNAMT', formatCents(l.cents)],
      ['FITID', l.fitid],
      ['NAME', name],
    ];
    if (memo && memo !== name) children.push(['MEMO', memo]);
    return ['STMTTRN', children];
  });
  const tranList = ['BANKTRANLIST', [['DTSTART', dt(from, '000000')], ['DTEND', dt(to, '235959')], ...trns]];
  const ledger = ['LEDGERBAL', [['BALAMT', formatCents(balanceCents)], ['DTASOF', dt(to, '235959')]]];
  const status = ['STATUS', [['CODE', '0'], ['SEVERITY', 'INFO']]];
  if (kind === 'CREDITCARD') {
    return ['CREDITCARDMSGSRSV1', [['CCSTMTTRNRS', [['TRNUID', trnuid], status, ['CCSTMTRS', [
      ['CURDEF', currency], ['CCACCTFROM', [['ACCTID', acctId]]], tranList, ledger,
    ]]]]]];
  }
  return ['BANKMSGSRSV1', [['STMTTRNRS', [['TRNUID', trnuid], status, ['STMTRS', [
    ['CURDEF', currency], ['BANKACCTFROM', [['BANKID', bankId], ['ACCTID', acctId], ['ACCTTYPE', kind]]], tranList, ledger,
  ]]]]]];
}

export function renderOfx(lines, cfg) {
  const { from, to } = dateRange(lines);
  const balanceCents = cfg.ledgerBalanceCents !== null && cfg.ledgerBalanceCents !== undefined ? cfg.ledgerBalanceCents : sumCents(lines);
  const sonrs = [
    ['STATUS', [['CODE', '0'], ['SEVERITY', 'INFO']]],
    ['DTSERVER', dt(addDays(to, 0), '120000')],
    ['LANGUAGE', 'ENG'],
    ['FI', [['ORG', cfg.org], ['FID', cfg.fid]]],
  ];
  if (cfg.intuBid) sonrs.push(['INTU.BID', cfg.intuBid]);
  const tree = ['OFX', [
    ['SIGNONMSGSRSV1', [['SONRS', sonrs]]],
    buildStatementBlock(lines, { kind: cfg.kind, currency: cfg.currency, acctId: cfg.acctId, bankId: cfg.bankId, from, to, balanceCents, trnuid: cfg.trnuid }),
  ]];
  const out = [];
  render(tree, cfg.closeLeaves, out);
  return header() + out.join('\r\n') + '\r\n';
}

const PROFILES = {
  qbo: { ext: 'qbo', mime: 'application/vnd.intu.qbo', intuit: true, product: 'QuickBooks' },
  qfx: { ext: 'qfx', mime: 'application/vnd.intu.qfx', intuit: true, product: 'Quicken' },
  ofx: { ext: 'ofx', mime: 'application/x-ofx', intuit: false, product: 'OFX' },
};

export function writeOfx(targetId, transactions, options = {}) {
  const p = PROFILES[targetId];
  const warnings = [];
  transactions = validateTxns(transactions);
  const { currency, kept } = selectCurrency(transactions, options, warnings);
  const kind = accountKind(options);
  const lines = toLines(kept, options);
  noteSplit(options, warnings);
  checkAmountDigits(lines);
  let intuBid = null;
  if (!p.intuit && options.intuBid !== undefined) warnings.push('The intuBid option only applies to QBO and QFX files and was ignored for this OFX file.');
  if (p.intuit) {
    if (options.intuBid !== undefined && typeof options.intuBid !== 'string' && typeof options.intuBid !== 'number') fail('BAD_OPTION', 'The intuBid option must be a number such as 3000.');
    intuBid = String(options.intuBid || (currency === 'CAD' ? '2' : '3000'));
    if (!/^\d{1,5}$/.test(intuBid)) fail('BAD_OPTION', `INTU.BID must be a number of up to 5 digits from Intuit's bank list, got "${intuBid}".`);
    if (currency !== 'USD' && !(currency === 'CAD' && intuBid === '2')) {
      warnings.push(`${p.product} US editions only accept US dollar Web Connect files, and this file is in ${currency}. QuickBooks Canada accepts CAD or USD with bank id 2. For other currencies use the Xero CSV or generic OFX instead.`);
    }
  }
  const bankName = asciiText(options.bankName || (p.intuit ? 'Books Import' : 'Books Import'));
  const org = esc(truncate(bankName, 32)) || 'Books Import';
  const fid = p.intuit ? intuBid : String(options.fid || '1001');
  if (options.accountId !== undefined && options.accountId !== null && typeof options.accountId !== 'string' && typeof options.accountId !== 'number') fail('BAD_OPTION', 'The accountId option must be text.');
  if (options.bankName !== undefined && options.bankName !== null && typeof options.bankName !== 'string') fail('BAD_OPTION', 'The bankName option must be text.');
  const rawAcct = options.accountId ? asciiText(options.accountId).replace(/[^A-Za-z0-9-]/g, '') : '';
  let acctId = rawAcct || ('BI' + fnv1a64(`${options.sourceId || ''}|${currency}`).slice(0, 10).toUpperCase());
  if (acctId.length > 22) { warnings.push('Account ID was longer than 22 characters and was shortened (OFX limit).'); acctId = acctId.slice(-22); }
  const bankId = String(options.routingNumber || options.bankId || '000000000').replace(/\D/g, '').slice(0, 9) || '000000000';
  let ledgerBalanceCents = null;
  if (options.ledgerBalance !== undefined && options.ledgerBalance !== null && options.ledgerBalance !== '') {
    const lb = options.ledgerBalance;
    ledgerBalanceCents = typeof lb === 'number' ? toCents(lb) : typeof lb === 'string' ? parseMoney(lb) : NaN;
    if (ledgerBalanceCents === null || Number.isNaN(ledgerBalanceCents) || !Number.isFinite(ledgerBalanceCents) || Math.abs(ledgerBalanceCents) > 99999999999) {
      fail('BAD_OPTION', `The ending balance "${String(lb)}" is not a number we can read. Use a plain number such as 1234.56.`);
    }
  }
  const closeLeaves = options.closeLeafTags !== undefined ? !!options.closeLeafTags : true;
  const trnuid = '1';
  const cfg = { kind, currency, acctId, bankId, intuBid, org, fid, ledgerBalanceCents, closeLeaves, trnuid };
  const content = renderOfx(lines, cfg);
  const { from, to } = dateRange(lines);
  const base = `${slug(options.filenameBase || options.sourceId || 'transactions')}-${from}-to-${to}`;
  const result = { filename: `${base}.${p.ext}`, mime: p.mime, content, warnings };
  if (ledgerBalanceCents === null) warnings.push('No ending balance was provided, so the statement balance in the file is the sum of these transactions. QuickBooks and Quicken only display it; it does not change your books.');
  if (targetId === 'qbo') {
    const bytes = new TextEncoder().encode(content).length;
    if (lines.length > QBO_ONLINE_MAX_ROWS || bytes > QBO_ONLINE_MAX_BYTES) {
      // Each part's statement balance is the running balance at its last day,
      // counted back from the full file's ending balance.
      const endBalance = ledgerBalanceCents !== null ? ledgerBalanceCents : sumCents(lines);
      const total = sumCents(lines);
      const parts = splitLines(lines, (chunk, endIdx) => {
        let after = 0;
        if (endIdx < lines.length) after = total - sumCents(lines.slice(0, endIdx));
        return renderOfx(chunk, { ...cfg, ledgerBalanceCents: endBalance - after });
      }, QBO_ONLINE_MAX_ROWS, QBO_ONLINE_MAX_BYTES);
      result.parts = parts.map((c, i) => ({ filename: `${base}-part${i + 1}of${parts.length}.${p.ext}`, content: c }));
      warnings.push(`QuickBooks Online accepts at most ${QBO_ONLINE_MAX_ROWS} transactions and 350 KB per upload. This file has ${lines.length} transactions (${Math.ceil(bytes / 1024)} KB), so it is also provided as ${parts.length} smaller files, split between days where possible, each ending with the running balance on its last day. QuickBooks Desktop can take the single full file.`);
    }
  }
  return result;
}

// Split lines (sorted by date) into chunks that satisfy row and byte limits.
// A chunk boundary is moved back to the start of a day when that day would
// otherwise be split, unless the day alone is bigger than a chunk.
// renderChunk(chunk, endIndex) returns the file text for lines[start..endIndex).
export function splitLines(lines, renderChunk, maxRows, maxBytes) {
  const enc = new TextEncoder();
  const out = [];
  let start = 0;
  const dayStart = (end) => {
    if (end >= lines.length || lines[end - 1].date !== lines[end].date) return end;
    let j = end - 1;
    while (j > start && lines[j - 1].date === lines[end].date) j--;
    return j > start ? j : end;
  };
  while (start < lines.length) {
    let end = dayStart(Math.min(lines.length, start + maxRows));
    let content = renderChunk(lines.slice(start, end), end);
    while (enc.encode(content).length > maxBytes && end - start > 1) {
      end = dayStart(start + Math.max(1, Math.floor((end - start) * 0.9)));
      content = renderChunk(lines.slice(start, end), end);
    }
    out.push(content);
    start = end;
  }
  return out;
}
