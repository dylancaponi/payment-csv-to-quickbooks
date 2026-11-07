// ISO 20022 camt.053 bank-to-customer statement (XML). Versions
// camt.053.001.02 to .001.08 share the elements read here:
//   Document > BkToCstmrStmt > Stmt (one per account and period)
//   Stmt: Id, ElctrncSeqNb, Acct > Id > IBAN | Othr > Id, Acct > Ccy,
//     Bal (Tp > CdOrPrtry > Cd OPBD / PRCD / CLBD, Amt Ccy, CdtDbtInd, Dt),
//     Ntry (Amt Ccy, CdtDbtInd, RvslInd, Sts, BookgDt, ValDt, AcctSvcrRef,
//     NtryRef, AddtlNtryInf, NtryDtls > TxDtls (Refs, Amt or AmtDtls,
//     CdtDbtInd, RltdPties, RmtInf Ustrd / Strd, AddtlTxInf)).
// Sign: CdtDbtInd. ISO 20022 defines RvslInd as a marker on an entry whose
// CdtDbtInd already gives the direction of the reversal booking ("If the
// CreditDebitIndicator is CRDT and ReversalIndicator is Yes, the original
// operation was a debit entry"), so RvslInd never flips the sign here; the
// entry is labelled as a reversal. The balance check confirms the reading.
import { fail } from '../errors.js';
import { isValidYMD } from '../dates.js';
import { parseXmlAll, child, all, text } from '../xml.js';
import { finishStatements } from './statement.js';

export function sniff(input) {
  const head = String(input).replace(/^﻿/, '').slice(0, 4000);
  if (!/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<([A-Za-z0-9_]+:)?Document[\s>]/.test(head) && !/<([A-Za-z0-9_]+:)?BkToCstmr/.test(head)) {
    return null;
  }
  const ns = /camt\.(\d{3})\.001\.(\d{2})/.exec(head);
  if (/BkToCstmrStmt/.test(head) || (ns && ns[1] === '053')) return { kind: 'camt053', version: ns ? `camt.053.001.${ns[2]}` : 'camt.053' };
  if (/BkToCstmrAcctRpt/.test(head) || (ns && ns[1] === '052')) return { kind: 'camt052' };
  if (/BkToCstmrDbtCdtNtfctn/.test(head) || (ns && ns[1] === '054')) return { kind: 'camt054' };
  const pain = /pain\.(\d{3})\.\d{3}\.\d{2}/.exec(head);
  if (pain) return { kind: 'pain', name: `pain.${pain[1]}` };
  return { kind: 'other-xml', name: ns ? `camt.${ns[1]}` : '' };
}

export function detect(input) {
  const s = sniff(input);
  if (s && s.kind === 'camt053') return { score: 0.98, reason: `Found an ISO 20022 bank statement (${s.version}).` };
  return { score: 0 };
}

export function refusal(s) {
  if (!s) return null;
  if (s.kind === 'camt052') return 'This is a camt.052 account report (an intraday or interim report), not a camt.053 statement. It does not carry the booked opening and closing balances we use to check the file. Download the camt.053 end-of-day statement from your bank instead.';
  if (s.kind === 'camt054') return 'This is a camt.054 debit or credit notification, not a camt.053 statement. A notification lists single bookings without balances, so the file cannot be checked. Download the camt.053 statement from your bank instead.';
  if (s.kind === 'pain') return `This is a ${s.name} payment file (instructions sent to a bank), not a bank statement. Only camt.053 statements and MT940 files can be converted here.`;
  if (s.kind === 'other-xml') return `This XML file is ${s.name ? `a ${s.name} message` : 'not a bank statement we know'}. Only camt.053 statements (and MT940 text files) can be converted here.`;
  return null;
}

function day(el) {
  if (!el) return null;
  const v = text(el, 'Dt') || text(el, 'DtTm');
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return m && isValidYMD(+m[1], +m[2], +m[3]) ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// "1234.5" -> 123450. More than two non-zero decimals: null.
function decimalCents(v) {
  const m = /^(\d{1,15})(?:\.(\d+))?$/.exec(String(v).trim());
  if (!m) return null;
  const frac = (m[2] || '').replace(/0+$/, '');
  if (frac.length > 2) return null;
  return +m[1] * 100 + +(frac.padEnd(2, '0') || '0');
}

function amountOf(el) {
  if (!el) return null;
  const cents = decimalCents(el.text);
  return { cents, currency: (el.attrs.Ccy || '').toUpperCase(), raw: el.text.trim() };
}

function sign(ind) {
  if (ind === 'CRDT') return 1;
  if (ind === 'DBIT') return -1;
  return 0;
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const provided = (s) => { const v = clean(s); return !v || /^(NOTPROVIDED|NONREF|NONE)$/i.test(v) ? '' : v; };

function partyName(p) {
  return clean(text(p, 'Nm') || text(p, 'Pty', 'Nm'));
}

function partyAccount(a) {
  return clean(text(a, 'Id', 'IBAN') || text(a, 'Id', 'Othr', 'Id'));
}

function txInfo(tx, entrySign) {
  const ind = text(tx, 'CdtDbtInd');
  const s = ind ? sign(ind) : entrySign;
  const rp = child(tx, 'RltdPties');
  const theirs = s > 0 ? 'Dbtr' : 'Cdtr';
  const name = partyName(child(rp, theirs)) || partyName(child(rp, s > 0 ? 'UltmtDbtr' : 'UltmtCdtr'));
  const acct = partyAccount(child(rp, `${theirs}Acct`));
  const rmt = child(tx, 'RmtInf');
  const ustrd = all(rmt, 'Ustrd').map((u) => clean(u.text)).filter(Boolean).join(' ');
  const strdRef = all(rmt, 'Strd').map((st) => clean(text(st, 'CdtrRefInf', 'Ref'))).filter(Boolean).join(' ');
  const e2e = provided(text(tx, 'Refs', 'EndToEndId'));
  let amt = amountOf(child(tx, 'Amt'));
  if (!amt) amt = amountOf(child(tx, 'AmtDtls', 'TxAmt', 'Amt'));
  return {
    sign: s,
    amt,
    counterparty: name,
    counterpartyAccount: acct,
    description: ustrd || strdRef || clean(text(tx, 'AddtlTxInf')),
    reference: e2e || strdRef,
    id: clean(text(tx, 'Refs', 'AcctSvcrRef') || text(tx, 'Refs', 'TxId')) || e2e,
  };
}

// Paged statements: a page that ends (or starts) at a page break carries an
// interim booked balance (ITBD) there instead of CLBD (or OPBD).
function pageBalances(stmt, warnings) {
  let opening = balanceOf(stmt, ['OPBD', 'PRCD'], warnings, 'opening');
  let closing = balanceOf(stmt, ['CLBD'], warnings, 'closing');
  const itbd = all(stmt, 'Bal').filter((b) => (text(b, 'Tp', 'CdOrPrtry', 'Cd') || text(b, 'Tp', 'CdOrPrtry', 'Prtry')) === 'ITBD');
  if (itbd.length && (!opening || !closing)) {
    const read = (b) => { const a = amountOf(child(b, 'Amt')); const sg = sign(text(b, 'CdtDbtInd')); if (!a || a.cents === null || !sg) fail('BAD_FILE', 'An interim balance (ITBD) of a statement in this camt.053 file could not be read.'); return { cents: sg * a.cents, currency: a.currency, date: day(child(b, 'Dt')) || '', interim: true }; };
    if (!opening) opening = read(itbd[0]);
    if (!closing && (itbd.length > 1 || opening.interim !== true)) closing = read(itbd[itbd.length - 1]);
  }
  return { opening, closing };
}

function balanceOf(stmt, codes, warnings, label) {
  for (const code of codes) {
    for (const b of all(stmt, 'Bal')) {
      const c = text(b, 'Tp', 'CdOrPrtry', 'Cd') || text(b, 'Tp', 'CdOrPrtry', 'Prtry');
      if (c !== code) continue;
      const a = amountOf(child(b, 'Amt'));
      const sg = sign(text(b, 'CdtDbtInd'));
      if (!a || a.cents === null || !sg) fail('BAD_FILE', `The ${label} balance of a statement in this camt.053 file could not be read.`);
      return { cents: sg * a.cents, currency: a.currency, date: day(child(b, 'Dt')) || '' };
    }
  }
  void warnings;
  return null;
}

export function parse(input, options = {}, warnings = []) {
  const s = sniff(input);
  const no = refusal(s);
  if (no) fail('WRONG_SOURCE', no);
  if (!s) fail('WRONG_SOURCE', "This doesn't look like a camt.053 bank statement (an ISO 20022 XML file starting with <Document>). In your online banking choose the camt.053 (sometimes called ISO 20022 or XML) statement download.");
  const ver = /camt\.053\.001\.(\d{2})/.exec(s.version || '');
  if (ver && (+ver[1] < 2 || +ver[1] > 8)) warnings.push(`This file uses ${s.version}. We read versions .001.02 to .001.08; this one has the same layout in the parts we use, but check the preview.`);
  // Every <Document> in the file is read: daily camt.053 files are often
  // joined into one. Anything that is not a camt.053 Document is refused.
  const docs = parseXmlAll(input);
  const bodies = docs.map((doc, i) => {
    const b = doc.name === 'Document' ? child(doc, 'BkToCstmrStmt') : null;
    if (!b) fail('WRONG_SOURCE', docs.length > 1 ? `This file joins ${docs.length} XML documents, and document ${i + 1} is not a camt.053 statement (no BkToCstmrStmt section). Upload the camt.053 files on their own.` : 'This XML file has no BkToCstmrStmt section, so it is not a camt.053 statement.');
    return b;
  });
  if (docs.length > 1) warnings.push(`This file joins ${docs.length} camt.053 documents. All of them were read.`);
  const statements = [];
  let read = 0, skipped = 0, pending = 0, splitEntries = 0, keptBatches = 0;
  for (const stmt of bodies.flatMap((b) => all(b, 'Stmt'))) {
    const acct = child(stmt, 'Acct');
    const account = partyAccount(acct) || '(no account number)';
    const { opening, closing } = pageBalances(stmt, warnings);
    const currency = (text(acct, 'Ccy') || (opening && opening.currency) || (closing && closing.currency) || '').toUpperCase();
    const number = clean(text(stmt, 'ElctrncSeqNb') || text(stmt, 'LglSeqNb') || text(stmt, 'Id'));
    const st = { account, currency, number, opening, closing, entries: [] };
    statements.push(st);
    for (const b of [opening, closing]) if (b && currency && b.currency && b.currency !== currency) warnings.push(`Statement ${number} for ${account} is in ${currency} but a balance is in ${b.currency}. Check this file with your bank.`);
    all(stmt, 'Ntry').forEach((n, idx) => {
      read++;
      const sts = (text(n, 'Sts') || text(n, 'Sts', 'Cd')).toUpperCase();
      if (sts && sts !== 'BOOK') { pending++; skipped++; return; }
      const amt = amountOf(child(n, 'Amt'));
      const sg = sign(text(n, 'CdtDbtInd'));
      const date = day(child(n, 'BookgDt')) || day(child(n, 'ValDt'));
      const valueDate = day(child(n, 'ValDt')) || undefined;
      const where = `entry ${idx + 1} of statement ${number || account}`;
      if (!amt || amt.cents === null || !sg || !date) { skipped++; warnings.push(`Skipped ${where}: its ${!amt || amt.cents === null ? 'amount' : !sg ? 'credit/debit mark' : 'date'} could not be read. The statement balance check will show the difference.`); return; }
      const cur = amt.currency || currency;
      if (!cur) fail('BAD_FILE', `A camt.053 entry has no currency and its statement names none. We do not guess currencies. Download the statement again from your bank.`);
      if (!st.currency) st.currency = cur;
      if (cur !== st.currency) { skipped++; warnings.push(`Skipped ${where}: it is in ${cur} but the account is in ${st.currency}.`); return; }
      const cents = sg * amt.cents;
      const reversal = /^(true|1)$/i.test(text(n, 'RvslInd'));
      const entryId = clean(text(n, 'AcctSvcrRef') || text(n, 'NtryRef'));
      const bk = clean(text(n, 'BkTxCd', 'Prtry', 'Cd')) || [text(n, 'BkTxCd', 'Domn', 'Cd'), text(n, 'BkTxCd', 'Domn', 'Fmly', 'Cd'), text(n, 'BkTxCd', 'Domn', 'Fmly', 'SubFmlyCd')].filter(Boolean).join('-');
      const addtl = clean(text(n, 'AddtlNtryInf'));
      const batchN = +text(n, 'NtryDtls', 'Btch', 'NbOfTxs') || 0;
      const txs = all(n, 'NtryDtls').flatMap((d) => all(d, 'TxDtls')).map((tx) => txInfo(tx, sg));
      const raw = { 'camt.053 statement': number, 'camt.053 entry': String(idx + 1), 'Entry reference': entryId, 'Entry amount': amt.raw, 'CdtDbtInd': text(n, 'CdtDbtInd'), 'RvslInd': text(n, 'RvslInd'), 'Additional info': addtl };
      const label = (d) => (reversal ? `Reversal: ${d}` : d);
      const fee = /CHRG|FEES|COMM/.test(bk) ? 'fee' : 'other';
      const canSplit = txs.length > 1 && txs.every((t) => t.amt && t.amt.cents !== null && t.amt.currency === cur && t.sign)
        && txs.reduce((a, t) => a + t.sign * t.amt.cents, 0) === cents;
      if (canSplit) {
        splitEntries++;
        txs.forEach((t, k) => st.entries.push({
          date, valueDate, cents: t.sign * t.amt.cents,
          counterparty: t.counterparty || undefined, counterpartyAccount: t.counterpartyAccount || undefined,
          description: label(t.description || addtl || t.counterparty || 'Bank transaction'),
          reference: t.reference || undefined,
          id: `${entryId || `E${idx + 1}`}/${t.id || k + 1}`, type: fee, raw: { ...raw, 'Batch line': String(k + 1) },
        }));
        return;
      }
      const one = txs.length === 1 ? txs[0] : null;
      if (txs.length > 1) keptBatches++;
      st.entries.push({
        date, valueDate, cents,
        counterparty: (one && one.counterparty) || undefined, counterpartyAccount: (one && one.counterpartyAccount) || undefined,
        description: label((one && one.description) || addtl || (txs.length > 1 || batchN > 1 ? `Batch of ${Math.max(txs.length, batchN)} transactions` : '') || (one && one.counterparty) || (bk ? `Bank transaction (${bk})` : 'Bank transaction')),
        reference: (one && one.reference) || undefined,
        id: entryId || (one && one.id) || undefined, type: fee, raw,
      });
    });
  }
  if (!statements.length) fail('NO_TRANSACTIONS', 'This camt.053 file has no statements (no Stmt sections).');
  for (const st of statements) if (!st.currency) fail('BAD_FILE', `Statement ${st.number || st.account} names no currency and has no entries to take one from. We do not guess currencies.`);
  const one = (n) => n === 1;
  if (pending) warnings.push(one(pending) ? 'Left out 1 entry that is not booked yet (status pending or information only). It does not change the booked balance; a later statement will show it once it is booked.' : `Left out ${pending} entries that are not booked yet (status pending or information only). They do not change the booked balance; a later statement will show them once they are booked.`);
  if (splitEntries) warnings.push(one(splitEntries) ? '1 batch entry was split into its individual payments, because the payments add up exactly to the booked amount.' : `${splitEntries} batch entries were split into their individual payments, because the payments add up exactly to the booked amount.`);
  if (keptBatches) warnings.push(one(keptBatches) ? '1 batch entry was kept as one line: its individual payments do not add up to the booked amount in the account currency.' : `${keptBatches} batch entries were kept as one line each: their individual payments do not add up to the booked amount in the account currency.`);
  const res = finishStatements(statements, options, warnings, 'camt.053');
  res.meta.rowsRead = read;
  res.meta.rowsSkipped = skipped;
  res.meta.format = s.version;
  return res;
}
