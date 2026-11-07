// Gusto "Payroll Journal Report" CSV, flat layout (Reports > Payroll
// journal, CSV). Sources for every rule below:
// research/2026-11-06-payroll-report-formats.md and FORMATS.md, Appendix F.
//
// Layout (one real export, quoted with its header in a public repo, plus
// its author's notes): a preamble ("Payroll Journal Report", the company
// name and address), then per pay schedule a block:
//   "Employee Earnings"
//   "<Schedule> payroll period"," MM/DD/YYYY - MM/DD/YYYY"
//   "Pay day"," MM/DD/YYYY"
//   header row (Last Name, First Name, ..., Gross Earnings, Employee Taxes,
//     <tax columns (Employee)>, Employer Taxes, <tax columns (Employer)>,
//     Net Pay, Reimbursements, Donations, Check Amount, Employer Cost)
//   one row per employee
//   "Payroll Totals" row (sum of the employee rows in every money column)
// Read only: Gross Earnings, Employee Taxes, Employer Taxes, Net Pay,
// Reimbursements, Donations, Check Amount, Employer Cost, and the
// "(Employee)" / "(Employer)" tax columns for a cross-check. Names,
// addresses and rates are never copied into the output.
//
// Facts from the real file: Net Pay = Gross Earnings - Employee Taxes and
// Employer Cost = Gross Earnings + Employer Taxes when there are no
// deductions or benefits. The CSV names of deduction and benefit columns
// are NOT sourced, so employee deductions are derived as Gross - Employee
// Taxes - Net Pay and employer contributions as Employer Cost - Gross -
// Employer Taxes, with a warning whenever either is not zero.
//
// Each payroll becomes one entry: named lines (the payroll clearing view:
// expenses negative, liabilities positive) plus a payout of the report's own
// Check Amount total. When the lines do not add up to it, the gap goes to
// clearing with a WARNING.
import { fail } from '../errors.js';
import { parseMoney, formatCents } from '../money.js';
import { parseDate } from '../dates.js';
import { columnMap, pick, cell, makeTxn, finishMeta, norm } from '../util.js';

export const MARKER = 'Gusto payroll';

const REQUIRED = ['Last Name', 'First Name', 'Gross Earnings', 'Employee Taxes', 'Employer Taxes', 'Net Pay', 'Check Amount'];
const SECTIONED = ['Last Name', 'First Name', 'Job', 'Pay Type'];

const SECTIONED_MSG = 'This is a Gusto Payroll Journal Report with one line per job and pay type (columns Job, Pay Type, Hours, Rate, Amount and no Gross Earnings column). This converter reads only the layout with one row per employee and a Gross Earnings column. In Gusto, run the Payroll journal report again without the job breakdown, download it as CSV, and upload that file.';

function isHeader(row, names) {
  const set = new Set(row.map(norm));
  return names.every((n) => set.has(norm(n)));
}

export function wrongExport(rows) {
  for (const r of rows) {
    if (isHeader(r, SECTIONED) && !isHeader(r, ['Gross Earnings'])) return SECTIONED_MSG;
  }
  return null;
}

export function detect(rows) {
  for (const r of rows) {
    if (isHeader(r, REQUIRED)) return { score: 0.98, reason: 'Found Gusto Payroll Journal Report columns (Gross Earnings, Employee Taxes, Employer Taxes, Net Pay, Check Amount).' };
  }
  return { score: 0 };
}

const blankRow = (r) => r.every((x) => !String(x == null ? '' : x).trim());
const first = (r) => cell(r, 0);

// " 08/10/2026 - 08/16/2026" -> { start, end }
function period(s) {
  const m = String(s || '').match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
  if (!m) return null;
  return { start: parseDate(m[1], 'mdy'), end: parseDate(m[2], 'mdy') };
}

const LINES = {
  wages: 'Gross wages (Gross Earnings)',
  erTaxExp: 'Employer payroll taxes (expense)',
  contribExp: 'Employer benefit contributions (expense, derived)',
  reimb: 'Reimbursements paid to employees',
  eeTax: 'Employee taxes withheld (owed to tax agencies)',
  erTax: 'Employer payroll taxes owed',
  ded: 'Employee deductions withheld (derived: gross - employee taxes - net pay)',
  dedGap: 'Net pay that does not follow from gross minus taxes (see WARNING)',
  contribLiab: 'Employer benefit contributions owed (derived)',
};

export function parse(rows, options = {}, warnings = []) {
  const wrong = wrongExport(rows);
  if (wrong) fail('WRONG_SOURCE', wrong);
  if (!rows.some((r) => isHeader(r, REQUIRED))) {
    fail('MISSING_COLUMNS', 'This does not look like a Gusto Payroll Journal Report. It needs the columns Last Name, First Name, Gross Earnings, Employee Taxes, Employer Taxes, Net Pay and Check Amount. In Gusto open Reports, run the Payroll journal report and download it as CSV.');
  }
  // 1. Find the blocks.
  const blocks = [];
  let i = 0;
  let firstBlockAt = -1;
  let lastEnd = -1; // index of the previous block's Payroll Totals row
  const unread = [];
  while (i < rows.length) {
    const r = rows[i];
    if (!isHeader(r, REQUIRED)) {
      // Rows after the first block that belong to no block: named once.
      if (firstBlockAt >= 0 && !blankRow(r) && !/^employee earnings$/i.test(first(r)) && !/payroll period$/i.test(first(r)) && !/^pay day$/i.test(first(r))) unread.push(i);
      i++;
      continue;
    }
    if (firstBlockAt < 0) firstBlockAt = i;
    const header = r;
    // Pay day and period: the lines just above the header.
    let payDay = null; let per = null; let schedule = '';
    // Never look past the previous block's Payroll Totals row (review finding 6).
    for (let k = i - 1; k >= Math.max(lastEnd + 1, i - 4); k--) {
      const f = first(rows[k]);
      if (!payDay && /^pay ?day$/i.test(f)) payDay = parseDate(cell(rows[k], 1), 'mdy');
      if (!per && /payroll period$/i.test(f)) { per = period(cell(rows[k], 1)); schedule = f.replace(/\s*payroll period$/i, '').trim(); }
    }
    const headerRow = i + 1;
    if (!payDay) fail('BAD_FILE', `The Gusto payroll block that starts on line ${headerRow} has no readable "Pay day" line above its column header, so its journal entry could not be dated. Upload the report exactly as Gusto downloaded it.`);
    i++;
    const emp = [];
    let totals = null;
    while (i < rows.length) {
      const x = rows[i];
      if (isHeader(x, REQUIRED)) break;
      if (/^payroll totals$/i.test(first(x))) { totals = { row: x, line: i + 1 }; lastEnd = i; i++; break; }
      if (/^employee earnings$/i.test(first(x))) break;
      if (!blankRow(x)) emp.push({ row: x, line: i + 1 });
      i++;
    }
    if (!totals) fail('BAD_FILE', `The Gusto payroll for pay day ${payDay} has no "Payroll Totals" row, so its journal entry could not be checked against the report's own totals. The file may be cut off; download the report again and upload it without editing.`);
    blocks.push({ header, headerRow, payDay, per, schedule, emp, totals });
  }

  // 2. Each block to one entry.
  const txns = [];
  const keys = new Map();
  const derivedDed = []; const derivedContrib = []; const reimbNote = []; const donation = [];
  let read = 0;
  const checks = [];
  for (const b of blocks) {
    const map = columnMap(b.header);
    const col = {
      gross: pick(map, 'Gross Earnings'), eeTax: pick(map, 'Employee Taxes'), erTax: pick(map, 'Employer Taxes'),
      net: pick(map, 'Net Pay'), reimb: pick(map, 'Reimbursements'), don: pick(map, 'Donations'),
      check: pick(map, 'Check Amount'), cost: pick(map, 'Employer Cost'),
    };
    const eeCols = []; const erCols = [];
    b.header.forEach((h, idx) => {
      const n = norm(h);
      if (/\(employee\)$/.test(n)) eeCols.push(idx);
      else if (/\(employer\)$/.test(n)) erCols.push(idx);
    });
    const money = (row, idx, line) => {
      if (idx < 0) return 0;
      const s = cell(row, idx);
      const c = parseMoney(s, '.');
      if (c === null) return 0; // blank is "not applicable": 0 in a sum
      if (Number.isNaN(c)) fail('BAD_FILE', `Line ${line} of the Gusto report has "${s.slice(0, 40)}" in the ${String(b.header[idx]).trim()} column, which is not an amount. Upload the report exactly as Gusto downloaded it, without editing it in a spreadsheet.`);
      return c;
    };
    const names = ['gross', 'eeTax', 'erTax', 'net', 'reimb', 'don', 'check', 'cost'];
    const sum = Object.fromEntries(names.map((n) => [n, 0]));
    for (const e of b.emp) for (const n of names) sum[n] += money(e.row, col[n], e.line);
    read += b.emp.length;
    const tot = Object.fromEntries(names.map((n) => [n, money(b.totals.row, col[n], b.totals.line)]));
    const label = `pay day ${b.payDay}${b.schedule ? ` (${b.schedule})` : ''}`;
    let key = `${b.payDay}${b.schedule ? ` ${b.schedule}` : ''}`;
    // The same payroll pasted in twice is refused; two different payrolls
    // with the same pay day and schedule are kept apart.
    // Duplicate signature: the employee count and every money column read,
    // never names, addresses or payment method (review finding 1).
    const moneyIdx = [...names.map((n) => col[n]).filter((x) => x >= 0), ...eeCols, ...erCols];
    const sig = JSON.stringify([b.emp.length, b.emp.map((e) => JSON.stringify(moneyIdx.map((idx) => money(e.row, idx, e.line)))).sort(), moneyIdx.map((idx) => money(b.totals.row, idx, b.totals.line))]);
    if (keys.has(key)) {
      if (keys.get(key).includes(sig)) fail('BAD_FILE', `The Gusto payroll for ${label} appears twice in this file. Upload each payroll once, so it is not booked twice.`);
      keys.get(key).push(sig);
      key = `${key} #${keys.get(key).length}`;
      warnings.push(`This file has more than one Gusto payroll for ${label}. They are kept as separate journal entries (${key}).`);
    } else keys.set(key, [sig]);

    // Checks against the report's own Payroll Totals row.
    const HEAD = { gross: 'Gross Earnings', eeTax: 'Employee Taxes', erTax: 'Employer Taxes', net: 'Net Pay', reimb: 'Reimbursements', don: 'Donations', check: 'Check Amount', cost: 'Employer Cost' };
    const offs = names.filter((n) => col[n] >= 0 && sum[n] !== tot[n]);
    if (offs.length) warnings.push(`WARNING: in the Gusto payroll for ${label}, the employee rows do not add up to the Payroll Totals row: ${offs.map((n) => `${HEAD[n]} ${formatCents(sum[n])} vs ${formatCents(tot[n])}`).join('; ')}. Rows may be missing or edited. The journal lines use the employee rows; the bank line uses the Payroll Totals Check Amount, and any gap goes to the clearing account.`);
    if (eeCols.length) {
      const s = eeCols.reduce((a, idx) => a + money(b.totals.row, idx, b.totals.line), 0);
      if (s !== tot.eeTax) warnings.push(`WARNING: in the Gusto payroll for ${label}, the employee tax columns add up to ${formatCents(s)} but Employee Taxes says ${formatCents(tot.eeTax)}. The journal uses Employee Taxes. Check the report in Gusto.`);
    }
    if (erCols.length) {
      const s = erCols.reduce((a, idx) => a + money(b.totals.row, idx, b.totals.line), 0);
      if (s !== tot.erTax) warnings.push(`WARNING: in the Gusto payroll for ${label}, the employer tax columns add up to ${formatCents(s)} but Employer Taxes says ${formatCents(tot.erTax)}. The journal uses Employer Taxes. Check the report in Gusto.`);
    }

    let ded = sum.gross - sum.eeTax - sum.net;
    let contrib = col.cost >= 0 ? sum.cost - sum.gross - sum.erTax : 0;
    // Review finding 2: a negative derived deduction, or Net Pay with the
    // opposite sign to Gross Earnings, cannot be a deduction. The amount goes
    // to clearing with a WARNING, never to the deductions liability.
    let dedGap = 0;
    let anomaly = false; // a WARNING below that does not move money to clearing
    // Checked per employee row (review finding 11), so one impossible row
    // cannot hide a real deduction on another row.
    const bad = [];
    let okDed = 0;
    for (const e of b.emp) {
      const g = money(e.row, col.gross, e.line); const net = money(e.row, col.net, e.line);
      const d = g - money(e.row, col.eeTax, e.line) - net;
      const opposite = (net < 0 && g > 0) || (net > 0 && g < 0);
      if (d < 0 || opposite) { dedGap += d; bad.push(`line ${e.line} (${opposite ? 'Net Pay has the opposite sign to Gross Earnings' : `Net Pay is ${formatCents(-d)} more than Gross Earnings minus Employee Taxes`})`); } else okDed += d;
    }
    if (bad.length) {
      ded = okDed;
      const rowWord = bad.length === 1 ? '1 employee row' : `${bad.length} employee rows`;
      const list = bad.slice(0, 5).join('; ') + (bad.length > 5 ? '; ...' : '');
      warnings.push(`WARNING: in the Gusto payroll for ${label}, ${rowWord} cannot be read as deductions: ${list}. That is not a deduction; something in the file was not read (for example a reimbursement inside Net Pay, or a correction payroll). ${formatCents(Math.abs(dedGap))} is booked to the clearing account, not to deductions. Check this payroll in Gusto before importing.`);
    }
    // Review finding 3: Employer Cost that is higher by exactly the
    // reimbursements includes them; they are not a benefit.
    if (sum.reimb && contrib === sum.reimb) {
      contrib = 0;
      reimbNote.push(`${label}: Employer Cost is higher than gross pay plus employer taxes by exactly the reimbursements (${formatCents(sum.reimb)}), so it is read as including them; no benefit contribution is booked`);
    } else if (sum.reimb && contrib) {
      anomaly = true;
      warnings.push(`WARNING: in the Gusto payroll for ${label}, Employer Cost is higher than gross pay plus employer taxes by ${formatCents(contrib)}, and the payroll also has ${formatCents(sum.reimb)} of reimbursements. It is not confirmed whether Employer Cost includes reimbursements, so the employer contributions line (${formatCents(contrib)}) may hold some of them. Check it against the Gusto report.`);
    }
    // A negative derived contribution cannot be a benefit (review finding 2).
    // The expense and liability lines would net to zero, so nothing reaches
    // the bank or clearing; it is left out with a WARNING.
    if (contrib < 0) {
      anomaly = true;
      warnings.push(`WARNING: in the Gusto payroll for ${label}, Employer Cost (${formatCents(sum.cost)}) is less than Gross Earnings plus Employer Taxes (${formatCents(sum.gross + sum.erTax)}) by ${formatCents(-contrib)}. That cannot be a benefit contribution, so no contribution is booked. Check Employer Cost in Gusto.`);
      contrib = 0;
    }
    if (ded) derivedDed.push(`${label}: ${formatCents(ded)}`);
    if (contrib) derivedContrib.push(`${label}: ${formatCents(contrib)}`);
    if (sum.don) donation.push(`${label}: ${formatCents(sum.don)}`);

    const base = { date: b.payDay, currency: 'USD', payoutId: key, payoutDate: b.payDay };
    const raw = { [MARKER]: key, 'Pay day': b.payDay, 'Pay period': b.per && b.per.start && b.per.end ? `${b.per.start} to ${b.per.end}` : '', Employees: String(b.emp.length) };
    let n = 0;
    const line = (lineKey, cents, account) => {
      if (!cents) return;
      n++;
      const t = makeTxn({ ...base, id: `${key}:${n}`, description: `Gusto payroll ${label}: ${LINES[lineKey]}`, amountCents: cents, type: 'other', raw: { ...raw, line: LINES[lineKey] } });
      t.journalLine = LINES[lineKey];
      t.journalAccount = account;
      txns.push(t);
    };
    line('wages', -sum.gross, 'wages');
    line('erTaxExp', -sum.erTax, 'payrollTaxExpense');
    line('contribExp', -contrib, 'benefitsExpense');
    line('reimb', -sum.reimb, 'reimbursements');
    line('eeTax', sum.eeTax, 'payrollTaxesPayable');
    line('erTax', sum.erTax, 'payrollTaxesPayable');
    line('ded', ded, 'payrollDeductions');
    line('dedGap', dedGap, 'clearing');
    line('contribLiab', contrib, 'payrollDeductions');
    // Lines net to -(Net Pay + Reimbursements): what the payroll needs from
    // the bank. The bank line is the report's own Check Amount total.
    const linesNet = -(sum.net + sum.reimb);
    const gap = linesNet + tot.check;
    if (tot.check || gap) {
      txns.push(makeTxn({ ...base, id: `${key}:check-amount`, description: `Gusto payroll ${label}: net pay paid (Check Amount total)`, amountCents: tot.check, type: 'payout', raw: { ...raw, line: 'Check Amount total' } }));
    }
    checks.push({ key, payDay: b.payDay, checkAmount: tot.check / 100, reconciled: !gap && !offs.length && !dedGap && !anomaly });
    if (gap) warnings.push(`WARNING: the Gusto payroll for ${label} does not add up. Net Pay plus Reimbursements is ${formatCents(sum.net + sum.reimb)}, but the Payroll Totals Check Amount (the money paid to employees) is ${formatCents(tot.check)} (difference ${formatCents(-gap)}). The bank line uses the Check Amount and the difference goes to the clearing account. Compare with the payroll in Gusto before importing.`);
  }

  // 3. Notes.
  if (derivedDed.length) warnings.push(`Employee deductions (for example 401(k) or health insurance) are not read from their own columns: their column names in Gusto's CSV are not documented. They are worked out as Gross Earnings minus Employee Taxes minus Net Pay and booked to the payroll deductions liability: ${derivedDed.join('; ')}. Check them against the deductions in the Gusto report.`);
  if (derivedContrib.length) warnings.push(`Employer benefit contributions are worked out as Employer Cost minus Gross Earnings minus Employer Taxes and booked as an expense and a liability: ${derivedContrib.join('; ')}. Check them against the contributions in the Gusto report.`);
  if (reimbNote.length) warnings.push(`${reimbNote.join('. ')}. We have not seen a real Gusto file with reimbursements, so check this against the report.`);
  if (donation.length) warnings.push(`Donations are not booked: we have not seen a Gusto file with donations, so how they affect the check is not confirmed (${donation.join('; ')}). If the Check Amount differs from Net Pay plus Reimbursements, the difference is on the clearing line.`);
  if (unread.length) warnings.push(`${unread.length} row(s) after the first payroll block are not part of an Employee Earnings block and were not read (first one on line ${unread[0] + 1}). If the report had other sections ticked, only Employee Earnings is used.`);
  warnings.push('Gusto pays the taxes and deductions from your bank separately from net pay. This file books them as owed (liabilities); record each tax or benefit payment against those liability accounts when it clears your bank. Tax payments are not in the Payroll Journal Report, so they are not booked here.');

  const meta = finishMeta(txns, read + blocks.length, 0, {
    timeZone: 'not applicable; every line is dated on the pay day',
    payrolls: blocks.length,
    payrollChecks: checks,
    reconciled: checks.every((c) => c.reconciled),
    employeeRows: read,
  });
  return { transactions: txns, warnings, meta };
}
