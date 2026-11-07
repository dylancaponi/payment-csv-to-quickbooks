// Shared logic for bank statement files (MT940, camt.053): one file can hold
// several statements, for several accounts and currencies. Each parser turns
// its file into plain statement objects:
//   { account, currency, number, opening: { cents, date } | null,
//     closing: { cents, date } | null, entries: [Entry], label }
//   Entry: { date, valueDate, cents, counterparty, counterpartyAccount,
//     description, reference, id, type, raw }
// and this module checks the balances, picks one account, and builds Txns.
import { fail } from '../errors.js';
import { formatCents } from '../money.js';
import { makeTxn, finishMeta } from '../util.js';
import { fnv1a64 } from '../hash.js';

const money = (c) => formatCents(c);

export function accountKey(s) {
  return `${s.account}|${s.currency}`;
}

function compact(v) {
  return String(v || '').replace(/\s+/g, '').toUpperCase();
}

function statementSig(s) {
  return fnv1a64(JSON.stringify([s.account, s.currency, s.number, s.opening, s.closing, s.entries.map((e) => [e.date, e.cents, e.description, e.reference, e.id])]));
}

// options.account picks the account (IBAN or account number, with or without
// spaces, optionally followed by the currency, e.g. "DE89... EUR").
function chooseAccount(groups, options) {
  const keys = [...groups.keys()];
  if (options.account !== undefined && options.account !== null && options.account !== '') {
    if (typeof options.account !== 'string') fail('BAD_OPTION', 'The account option must be text, such as an IBAN.');
    const want = compact(options.account);
    const hit = keys.find((k) => compact(k.replace('|', '')) === want) || keys.find((k) => compact(k.split('|')[0]) === want);
    if (!hit) fail('BAD_OPTION', `This file has no account "${options.account}". It holds: ${keys.map((k) => k.replace('|', ' ')).join(', ')}.`, { accounts: keys.map((k) => ({ account: k.split('|')[0], currency: k.split('|')[1] })) });
    return hit;
  }
  let best = null;
  for (const k of keys) if (!best || groups.get(k).entries > groups.get(best).entries) best = k;
  return best;
}

export function finishStatements(statements, options, warnings, fmt) {
  if (!statements.length) fail('NO_TRANSACTIONS', `No statements were found in this ${fmt} file.`);
  // One account written two ways ("NL91ABNA0417164300" and
  // "NL91 ABNA 0417 1643 00", or in another case) is one account: every
  // statement takes the first spelling seen. Only spaces and case are
  // ignored; punctuation is kept, because "12-3456" and "123-456" can be two
  // different accounts.
  const spelling = new Map();
  for (const s of statements) {
    const k = compact(s.account) || s.account;
    if (!spelling.has(k)) spelling.set(k, s.account);
    s.account = spelling.get(k);
  }
  // 1. Exact repeats of a statement (two downloads pasted together).
  const seen = new Set();
  const unique = [];
  let repeats = 0;
  for (const s of statements) {
    const sig = statementSig(s);
    if (seen.has(sig)) { repeats++; continue; }
    seen.add(sig);
    unique.push(s);
  }
  if (repeats) warnings.push(repeats === 1 ? 'This file contains 1 exact repeat of a statement it already holds. The repeated statement was read once.' : `This file contains ${repeats} exact repeats of statements it already holds. Each repeated statement was read once.`);

  // 2. Balance check per statement: opening + entries = closing.
  const checks = [];
  for (const s of unique) {
    const total = s.entries.reduce((a, e) => a + e.cents, 0);
    const c = { account: s.account, currency: s.currency, number: s.number || '', entries: s.entries.length, entriesTotal: total / 100 };
    if (s.opening && s.closing) {
      c.opening = s.opening.cents / 100;
      c.closing = s.closing.cents / 100;
      c.reconciled = s.opening.cents + total === s.closing.cents;
      if (!c.reconciled) {
        const diff = s.closing.cents - s.opening.cents - total;
        warnings.push(`WARNING: statement ${s.number || '(no number)'} for account ${s.account} (${s.currency}) does not add up. Opening balance ${money(s.opening.cents)} plus the entries ${money(total)} is ${money(s.opening.cents + total)}, but the closing balance is ${money(s.closing.cents)} (difference ${money(diff)}). Entries may be missing from this file or could not be read. Compare this statement with your bank before importing it.`);
      }
    } else {
      c.reconciled = null;
      warnings.push(`Statement ${s.number || '(no number)'} for account ${s.account} has no ${s.opening ? 'closing' : 'opening'} balance, so we could not check that its entries add up.`);
    }
    s._check = c;
    checks.push(c);
  }

  // 3. One account and currency per output.
  const groups = new Map();
  for (const s of unique) {
    const k = accountKey(s);
    if (!groups.has(k)) groups.set(k, { statements: [], entries: 0 });
    const g = groups.get(k);
    g.statements.push(s);
    g.entries += s.entries.length;
  }
  const chosen = chooseAccount(groups, options);
  const accounts = [...groups.entries()].map(([k, g]) => ({ account: k.split('|')[0], currency: k.split('|')[1], statements: g.statements.length, transactions: g.entries }));
  if (groups.size > 1) {
    const others = accounts.filter((a) => `${a.account}|${a.currency}` !== chosen).map((a) => `${a.account} ${a.currency} (${a.transactions} ${a.transactions === 1 ? 'entry' : 'entries'})`).join(', ');
    warnings.push(`This file holds ${groups.size} accounts or currencies. Only ${chosen.replace('|', ' ')} is converted, because an import file holds one account in one currency. Left out: ${others}. Choose the account to convert the others one at a time.`);
  }
  const list = groups.get(chosen).statements;

  // 4. Statements in date order; check that each one starts where the
  // previous one ended.
  const startOf = (s) => (s.opening && s.opening.date) || (s.entries[0] && s.entries[0].date) || (s.closing && s.closing.date) || '';
  const byDate = list.map((s, i) => [s, i]).sort((a, b) => (startOf(a[0]) < startOf(b[0]) ? -1 : startOf(a[0]) > startOf(b[0]) ? 1 : a[1] - b[1])).map((x) => x[0]);
  // Statements that start on the same day (pages of one day) are put in the
  // order their balances chain: each one opens with the previous closing
  // balance. Where the balances do not chain, file order is kept and the gap
  // warning below fires.
  const ordered = [];
  for (let i = 0; i < byDate.length;) {
    let j = i;
    while (j < byDate.length && startOf(byDate[j]) === startOf(byDate[i])) j++;
    const rest = byDate.slice(i, j);
    let cur = ordered.length && ordered[ordered.length - 1].closing ? ordered[ordered.length - 1].closing.cents : null;
    while (rest.length) {
      let k = cur !== null ? rest.findIndex((s) => s.opening && s.opening.cents === cur) : -1;
      if (k < 0) k = rest.findIndex((s) => !(s.opening && rest.some((o) => o !== s && o.closing && o.closing.cents === s.opening.cents)));
      if (k < 0) k = 0;
      const [s] = rest.splice(k, 1);
      ordered.push(s);
      cur = s.closing ? s.closing.cents : null;
    }
    i = j;
  }
  let gaps = 0;
  for (let i = 1; i < ordered.length; i++) {
    const p = ordered[i - 1], s = ordered[i];
    if (p.closing && s.opening && p.closing.cents !== s.opening.cents) gaps++;
  }
  if (gaps) warnings.push(`In ${gaps === 1 ? '1 place' : `${gaps} places`} a statement does not start with the closing balance of the one before it, so statements are missing from this file between them (or the file mixes periods). The entries that are here are converted.`);

  // 5. Txns with a running balance where the opening balance is known.
  const txns = [];
  const currency = chosen.split('|')[1];
  for (const s of ordered) {
    let run = s.opening ? s.opening.cents : null;
    for (const e of s.entries) {
      if (run !== null) run += e.cents;
      const t = makeTxn({ date: e.date, description: e.description || e.counterparty || 'Bank transaction', amountCents: e.cents, currency, id: e.id, type: e.type || 'other', counterparty: e.counterparty, raw: e.raw });
      if (e.valueDate) t.valueDate = e.valueDate;
      if (e.counterpartyAccount) t.counterpartyAccount = e.counterpartyAccount;
      if (e.reference) t.reference = e.reference;
      if (run !== null) t.balance = run / 100;
      t.account = s.account;
      txns.push(t);
    }
  }
  const mine = ordered.map((s) => s._check);
  const meta = { account: chosen.split('|')[0], accounts, statements: checks, statementCount: unique.length };
  const first = ordered[0], last = ordered[ordered.length - 1];
  if (first.opening) meta.openingBalance = first.opening.cents / 100;
  if (last.closing) meta.closingBalance = last.closing.cents / 100;
  meta.reconciled = mine.every((c) => c.reconciled === true) && !gaps;
  for (const s of unique) delete s._check;
  return { transactions: txns, meta: finishMeta(txns, txns.length, 0, meta) };
}

// Two-digit SWIFT years: 00-79 are 2000-2079, 80-99 are 1980-1999.
export function swiftYear(yy) {
  const n = +yy;
  return n < 80 ? 2000 + n : 1900 + n;
}
