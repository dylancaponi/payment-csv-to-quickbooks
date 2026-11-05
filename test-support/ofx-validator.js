// Independent OFX 1.0.2 SGML structural validator, used only by tests.
// Written from the spec rules in FORMATS.md, NOT from the writer's code, so a
// writer bug cannot hide behind the writer's own assumptions.
//
// validateOfx(text, expect?) -> { errors: string[], header, tree, stmttrns, sumCents }
// expect: { intuBid: string|null, count, sumCents, kind: 'bank'|'cc', currency }

const HEADER_ORDER = ['OFXHEADER', 'DATA', 'VERSION', 'SECURITY', 'ENCODING', 'CHARSET', 'COMPRESSION', 'OLDFILEUID', 'NEWFILEUID'];
const HEADER_ALLOWED = {
  OFXHEADER: /^100$/,
  DATA: /^OFXSGML$/,
  VERSION: /^1\d\d$/,
  SECURITY: /^(NONE|TYPE1)$/,
  ENCODING: /^(USASCII|UTF-8)$/,
  CHARSET: /^(1252|ISO-8859-1|NONE)$/,
  COMPRESSION: /^NONE$/,
  OLDFILEUID: /^[A-Za-z0-9-]{1,36}$/,
  NEWFILEUID: /^[A-Za-z0-9-]{1,36}$/,
};
const TRNTYPES = new Set(['CREDIT', 'DEBIT', 'INT', 'DIV', 'FEE', 'SRVCHG', 'DEP', 'ATM', 'POS', 'XFER', 'CHECK', 'PAYMENT', 'CASH', 'DIRECTDEP', 'DIRECTDEBIT', 'REPEATPMT', 'OTHER']);
const ACCTTYPES = new Set(['CHECKING', 'SAVINGS', 'MONEYMRKT', 'CREDITLINE', 'CD']);
const DATETIME = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})(?:\.\d{3})?)?(?:\[[+-]?\d{1,2}(?:\.\d{2})?(?::[A-Za-z]+)?\])?$/;
const AMOUNT = /^[+-]?\d+(?:\.\d{1,2})?$/;

// Spec order of children (subset we emit or require). Elements not listed
// are allowed but checked for relative order only among listed ones.
const ORDER = {
  SONRS: ['STATUS', 'DTSERVER', 'USERKEY', 'TSKEYEXPIRE', 'LANGUAGE', 'DTPROFUP', 'DTACCTUP', 'FI', 'SESSCOOKIE', 'ACCESSKEY', 'INTU.BID', 'INTU.USERID'],
  STATUS: ['CODE', 'SEVERITY', 'MESSAGE'],
  FI: ['ORG', 'FID'],
  STMTTRNRS: ['TRNUID', 'STATUS', 'CLTCOOKIE', 'STMTRS'],
  CCSTMTTRNRS: ['TRNUID', 'STATUS', 'CLTCOOKIE', 'CCSTMTRS'],
  STMTRS: ['CURDEF', 'BANKACCTFROM', 'BANKTRANLIST', 'LEDGERBAL', 'AVAILBAL', 'BALLIST', 'MKTGINFO'],
  CCSTMTRS: ['CURDEF', 'CCACCTFROM', 'BANKTRANLIST', 'LEDGERBAL', 'AVAILBAL', 'BALLIST', 'MKTGINFO'],
  BANKACCTFROM: ['BANKID', 'BRANCHID', 'ACCTID', 'ACCTTYPE', 'ACCTKEY'],
  CCACCTFROM: ['ACCTID', 'ACCTKEY'],
  BANKTRANLIST: ['DTSTART', 'DTEND', 'STMTTRN'],
  STMTTRN: ['TRNTYPE', 'DTPOSTED', 'DTUSER', 'DTAVAIL', 'TRNAMT', 'FITID', 'CORRECTFITID', 'CORRECTACTION', 'SRVRTID', 'CHECKNUM', 'REFNUM', 'SIC', 'PAYEEID', 'NAME', 'PAYEE', 'BANKACCTTO', 'CCACCTTO', 'MEMO', 'CURRENCY', 'ORIGCURRENCY'],
  LEDGERBAL: ['BALAMT', 'DTASOF'],
};
const REQUIRED = {
  OFX: ['SIGNONMSGSRSV1'],
  SIGNONMSGSRSV1: ['SONRS'],
  SONRS: ['STATUS', 'DTSERVER', 'LANGUAGE'],
  STATUS: ['CODE', 'SEVERITY'],
  FI: ['ORG'],
  STMTTRNRS: ['TRNUID', 'STATUS'],
  CCSTMTTRNRS: ['TRNUID', 'STATUS'],
  STMTRS: ['CURDEF', 'BANKACCTFROM', 'LEDGERBAL'],
  CCSTMTRS: ['CURDEF', 'CCACCTFROM', 'LEDGERBAL'],
  BANKACCTFROM: ['BANKID', 'ACCTID', 'ACCTTYPE'],
  CCACCTFROM: ['ACCTID'],
  BANKTRANLIST: ['DTSTART', 'DTEND'],
  STMTTRN: ['TRNTYPE', 'DTPOSTED', 'TRNAMT', 'FITID'],
  LEDGERBAL: ['BALAMT', 'DTASOF'],
};

function unescape(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function validDate(v) {
  const m = DATETIME.exec(v);
  if (!m) return false;
  const y = +m[1]; const mo = +m[2]; const d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > dim) return false;
  if (m[4] !== undefined && (+m[4] > 23 || +m[5] > 59 || +m[6] > 60)) return false;
  return true;
}

// Tokenize SGML body into a tree. Leaf = open tag followed by non-blank text.
function parseBody(body, errors) {
  const re = /<(\/?)([A-Za-z0-9.]+)>([^<]*)/g;
  const tokens = [];
  let m;
  let last = 0;
  while ((m = re.exec(body))) {
    if (body.slice(last, m.index).trim()) errors.push(`Stray text before <${m[1]}${m[2]}>: "${body.slice(last, m.index).trim().slice(0, 40)}"`);
    tokens.push({ close: m[1] === '/', tag: m[2], text: m[3] });
    last = re.lastIndex;
  }
  if (body.slice(last).trim()) errors.push('Stray text after the last tag');
  const root = { tag: '#root', children: [] };
  const stack = [root];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const top = stack[stack.length - 1];
    if (t.close) {
      if (top.tag !== t.tag) { errors.push(`Closing </${t.tag}> does not match open <${top.tag}>`); return root; }
      stack.pop();
      if (t.text.trim()) errors.push(`Text after </${t.tag}>: "${t.text.trim().slice(0, 40)}"`);
      continue;
    }
    if (t.text.trim() !== '') {
      const raw = t.text.replace(/\r?\n$/, '').replace(/\s+$/, '');
      if (/&(?!(amp|lt|gt);)/.test(raw)) errors.push(`Unescaped & in <${t.tag}>`);
      const node = { tag: t.tag, value: unescape(raw), rawValue: raw, children: null };
      top.children.push(node);
      const nx = tokens[i + 1];
      if (nx && nx.close && nx.tag === t.tag) { i++; if (nx.text.trim()) errors.push(`Text after </${t.tag}>`); }
    } else {
      const node = { tag: t.tag, children: [] };
      top.children.push(node);
      stack.push(node);
    }
  }
  if (stack.length !== 1) errors.push(`Unclosed aggregate(s): ${stack.slice(1).map((n) => n.tag).join(', ')}`);
  return root;
}

function child(node, tag) { return node && node.children ? node.children.find((c) => c.tag === tag) : undefined; }
function children(node, tag) { return node && node.children ? node.children.filter((c) => c.tag === tag) : []; }

function checkNode(node, errors, path) {
  if (!node.children) return;
  const req = REQUIRED[node.tag];
  if (req) for (const r of req) if (!child(node, r)) errors.push(`${path}${node.tag} is missing required <${r}>`);
  const order = ORDER[node.tag];
  if (order) {
    let pos = -1;
    for (const c of node.children) {
      const idx = order.indexOf(c.tag);
      if (idx === -1) continue;
      if (idx < pos) errors.push(`${path}${node.tag}: <${c.tag}> is out of spec order`);
      pos = Math.max(pos, idx);
    }
  }
  for (const c of node.children) {
    if (c.children && REQUIRED[c.tag] === undefined && ORDER[c.tag] === undefined && !['OFX', 'SIGNONMSGSRSV1', 'BANKMSGSRSV1', 'CREDITCARDMSGSRSV1', 'SONRS'].includes(c.tag)) {
      // Unknown aggregate: allowed but unusual.
    }
    checkNode(c, errors, `${path}${node.tag} > `);
  }
}

export function validateOfx(text, expect = {}) {
  const errors = [];
  const result = { errors, header: {}, stmttrns: [], sumCents: 0 };
  if (typeof text !== 'string' || !text) { errors.push('Empty file'); return result; }
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(text)) errors.push('Non-ASCII or control character in file (ENCODING:USASCII)');
  const lt = text.indexOf('<');
  if (lt < 0) { errors.push('No tags found'); return result; }
  const headerText = text.slice(0, lt);
  if (/\n/.test(headerText.replace(/\r\n/g, ''))) errors.push('Header uses bare LF line endings; expected CRLF');
  const hlines = headerText.split(/\r?\n/);
  // Expect 9 header lines then at least one blank line.
  const nonBlank = hlines.filter((l) => l.trim() !== '');
  if (nonBlank.length !== 9) errors.push(`Expected 9 header lines, found ${nonBlank.length}`);
  nonBlank.forEach((l, i) => {
    const mm = /^([A-Z]+):(.*)$/.exec(l);
    if (!mm) { errors.push(`Bad header line "${l}"`); return; }
    if (mm[1] !== HEADER_ORDER[i]) errors.push(`Header line ${i + 1} is ${mm[1]}, expected ${HEADER_ORDER[i]}`);
    if (HEADER_ALLOWED[mm[1]] && !HEADER_ALLOWED[mm[1]].test(mm[2])) errors.push(`Header ${mm[1]} has invalid value "${mm[2]}"`);
    result.header[mm[1]] = mm[2];
  });
  if (!/NEWFILEUID:[^\r\n]*(\r?\n)[ \t]*\r?\n\s*$/.test(headerText)) errors.push('Missing blank line between the header and <OFX>');
  const root = parseBody(text.slice(lt), errors);
  const ofx = child(root, 'OFX');
  if (!ofx || root.children.length !== 1) { errors.push('Body must be exactly one <OFX> aggregate'); return result; }
  result.tree = ofx;
  checkNode(ofx, errors, '');
  const sonrs = child(child(ofx, 'SIGNONMSGSRSV1'), 'SONRS');
  if (sonrs) {
    const code = child(child(sonrs, 'STATUS'), 'CODE');
    if (!code || code.value !== '0') errors.push('SONRS STATUS CODE must be 0');
    const dts = child(sonrs, 'DTSERVER');
    if (dts && !validDate(dts.value)) errors.push(`DTSERVER "${dts.value}" is not an OFX datetime`);
    const lang = child(sonrs, 'LANGUAGE');
    if (lang && !/^[A-Z]{3}$/.test(lang.value)) errors.push('LANGUAGE must be a 3-letter code');
    const fi = child(sonrs, 'FI');
    if (fi) for (const t of ['ORG', 'FID']) { const n = child(fi, t); if (n && n.value.length > 32) errors.push(`${t} longer than 32`); }
    const bid = child(sonrs, 'INTU.BID');
    if ('intuBid' in expect) {
      if (expect.intuBid === null && bid) errors.push('Generic OFX must not carry INTU.BID');
      if (expect.intuBid && (!bid || bid.value !== expect.intuBid)) errors.push(`INTU.BID should be ${expect.intuBid}, got ${bid ? bid.value : 'none'}`);
    }
    if (bid && !/^\d{1,5}$/.test(bid.value)) errors.push('INTU.BID must be numeric');
  }
  const bank = child(ofx, 'BANKMSGSRSV1');
  const cc = child(ofx, 'CREDITCARDMSGSRSV1');
  if (!!bank === !!cc) { errors.push('Exactly one of BANKMSGSRSV1 or CREDITCARDMSGSRSV1 required'); return result; }
  if (expect.kind === 'cc' && !cc) errors.push('Credit card file must use CREDITCARDMSGSRSV1');
  if (expect.kind === 'bank' && !bank) errors.push('Bank file must use BANKMSGSRSV1');
  const trnrs = bank ? child(bank, 'STMTTRNRS') : child(cc, 'CCSTMTTRNRS');
  const stmtrs = bank ? child(trnrs, 'STMTRS') : child(trnrs, 'CCSTMTRS');
  if (!stmtrs) { errors.push('Missing statement response'); return result; }
  const curdef = child(stmtrs, 'CURDEF');
  if (curdef && !/^[A-Z]{3}$/.test(curdef.value)) errors.push('CURDEF must be an ISO currency code');
  if (expect.currency && curdef && curdef.value !== expect.currency) errors.push(`CURDEF should be ${expect.currency}`);
  const acct = bank ? child(stmtrs, 'BANKACCTFROM') : child(stmtrs, 'CCACCTFROM');
  const acctId = child(acct, 'ACCTID');
  if (acctId && (acctId.value.length > 22 || !acctId.value)) errors.push('ACCTID must be 1-22 characters');
  if (bank) {
    const bid = child(acct, 'BANKID');
    if (bid && !/^\d{1,9}$/.test(bid.value)) errors.push('BANKID must be up to 9 digits');
    const at = child(acct, 'ACCTTYPE');
    if (at && !ACCTTYPES.has(at.value)) errors.push(`ACCTTYPE "${at.value}" not allowed`);
  }
  const list = child(stmtrs, 'BANKTRANLIST');
  const dtStart = child(list, 'DTSTART');
  const dtEnd = child(list, 'DTEND');
  for (const d of [dtStart, dtEnd]) if (d && !validDate(d.value)) errors.push(`${d.tag} "${d.value}" is not an OFX datetime`);
  const fitids = new Set();
  let sum = 0;
  for (const s of children(list, 'STMTTRN')) {
    const get = (t) => { const n = child(s, t); return n ? n.value : undefined; };
    const trntype = get('TRNTYPE');
    const posted = get('DTPOSTED');
    const amt = get('TRNAMT');
    const fid = get('FITID');
    const name = get('NAME');
    const memo = get('MEMO');
    const where = `STMTTRN ${fid || '?'}`;
    if (trntype && !TRNTYPES.has(trntype)) errors.push(`${where}: TRNTYPE "${trntype}" not allowed`);
    if (posted && !validDate(posted)) errors.push(`${where}: DTPOSTED "${posted}" invalid`);
    if (posted && dtStart && dtEnd && (posted.slice(0, 8) < dtStart.value.slice(0, 8) || posted.slice(0, 8) > dtEnd.value.slice(0, 8))) errors.push(`${where}: DTPOSTED outside DTSTART..DTEND`);
    if (amt !== undefined) {
      if (!AMOUNT.test(amt)) errors.push(`${where}: TRNAMT "${amt}" invalid`);
      else {
        const [i, f = ''] = amt.replace(/^[+-]/, '').split('.');
        const cents = (Number(i) * 100 + Number((f + '00').slice(0, 2))) * (amt.startsWith('-') ? -1 : 1);
        sum += cents;
        if (trntype === 'CREDIT' && cents < 0) errors.push(`${where}: CREDIT with negative amount`);
        if (trntype === 'DEBIT' && cents > 0) errors.push(`${where}: DEBIT with positive amount`);
        if (String(Math.abs(cents)).length >= 12) errors.push(`${where}: amount has 12+ digits`);
      }
    }
    if (fid !== undefined) {
      if (!fid || fid.length > 32) errors.push(`${where}: FITID must be 1-32 characters`);
      if (fitids.has(fid)) errors.push(`Duplicate FITID ${fid}`);
      fitids.add(fid);
    }
    if (!child(s, 'NAME') && !child(s, 'PAYEE')) errors.push(`${where}: NAME or PAYEE required`);
    if (name !== undefined && (name.length > 32 || !name.trim())) errors.push(`${where}: NAME must be 1-32 characters ("${name}")`);
    if (memo !== undefined && memo.length > 255) errors.push(`${where}: MEMO longer than 255`);
    result.stmttrns.push({ trntype, posted, amt, fitid: fid, name, memo });
  }
  result.sumCents = sum;
  const ledger = child(stmtrs, 'LEDGERBAL');
  if (ledger) {
    const bal = child(ledger, 'BALAMT');
    if (bal && !AMOUNT.test(bal.value)) errors.push('BALAMT invalid');
    const asof = child(ledger, 'DTASOF');
    if (asof && !validDate(asof.value)) errors.push('DTASOF invalid');
  }
  if (expect.count !== undefined && result.stmttrns.length !== expect.count) errors.push(`Expected ${expect.count} transactions, found ${result.stmttrns.length}`);
  if (expect.sumCents !== undefined && sum !== expect.sumCents) errors.push(`Transactions total ${sum} cents, expected ${expect.sumCents}`);
  return result;
}
