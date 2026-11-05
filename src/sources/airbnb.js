// Airbnb earnings / transaction history CSV (Menu > Earnings > Paid or
// Upcoming > Export CSV). Each "Payout" row comes first and is followed by the
// reservation / adjustment rows it pays out; "Paid out" on the payout row is
// the sum of their "Amount". Headers are translated into the account
// language; English and Spanish are recognized here.
import { fail } from '../errors.js';
import { parseMoney } from '../money.js';
import { parseDate } from '../dates.js';
import { resolveDecimal, resolveDateOrder } from '../locale.js';
import { columnMap, pick, cell, cleanText, rawObject, makeTxn, finishMeta, sortByDate } from '../util.js';

const ALIASES = {
  date: ['Date', 'Fecha'],
  arriving: ['Arriving by date', 'Llega en esta fecha'],
  type: ['Type', 'Tipo'],
  code: ['Confirmation code', 'Confirmation Code', 'Código de confirmación'],
  start: ['Start date', 'Start Date', 'Fecha de inicio'],
  end: ['End date', 'End Date', 'Fecha de finalización'],
  nights: ['Nights', 'Noches'],
  guest: ['Guest', 'Huésped'],
  listing: ['Listing', 'Anuncio'],
  details: ['Details', 'Detalles'],
  ref: ['Reference code', 'Reference Code', 'Código de referencia'],
  currency: ['Currency', 'Moneda'],
  amount: ['Amount', 'Monto'],
  paidOut: ['Paid out', 'Paid Out', 'Total pagado'],
  serviceFee: ['Service fee', 'Service Fee', 'Tarifa por servicio'],
  fastPay: ['Fast Pay Fee', 'Fast pay fee', 'Tarifa de Pago rápido'],
  cleaning: ['Cleaning fee', 'Cleaning Fee', 'Tarifa de limpieza'],
  gross: ['Gross earnings', 'Gross Earnings', 'Ingresos brutos'],
  taxes: ['Occupancy taxes', 'Occupancy Taxes', 'Airbnb remitted tax', 'Airbnb remitted taxes', 'Impuestos liquidados por Airbnb'],
};

function headerIndex(rows) {
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const map = columnMap(rows[i]);
    if (pick(map, ...ALIASES.type) >= 0 && pick(map, ...ALIASES.paidOut) >= 0 && pick(map, ...ALIASES.amount) >= 0 && (pick(map, ...ALIASES.arriving) >= 0 || (pick(map, ...ALIASES.code) >= 0 && pick(map, ...ALIASES.gross) >= 0))) return i;
  }
  return -1;
}

export function detect(rows) {
  const h = headerIndex(rows);
  if (h < 0) return { score: 0 };
  return { score: 0.97, reason: 'Found Airbnb earnings columns (Arriving by date, Confirmation code, Paid out).' };
}

function mapType(t) {
  const s = t.toLowerCase();
  if (s === 'payout' || s === 'pago' || s === 'pago recibido') return 'payout';
  if (s.includes('reservation') || s.includes('reservación') || s.includes('reserva')) return 'payment';
  if (s.includes('resolution payout') || s.includes('credit') || s.includes('crédito')) return 'other';
  if (s.includes('adjustment') || s.includes('ajuste') || s.includes('cancellation')) return 'refund';
  if (s.includes('tax')) return 'other';
  return 'other';
}

export function parse(rows, options = {}, warnings = []) {
  const h = headerIndex(rows);
  if (h < 0) fail('WRONG_SOURCE', "This doesn't look like an Airbnb earnings export: we couldn't find the Type, Amount and Paid out columns. On airbnb.com go to Menu > Earnings, choose Paid, click Export CSV. If your Airbnb is in a language other than English or Spanish, switch it to English first.");
  const header = rows[h];
  const map = columnMap(header);
  const c = {};
  for (const k of Object.keys(ALIASES)) c[k] = pick(map, ...ALIASES[k]);
  const data = rows.slice(h + 1).filter((r) => !r.every((v) => v.trim() === ''));
  const decimal = resolveDecimal(data.flatMap((r) => [cell(r, c.amount), cell(r, c.paidOut), cell(r, c.gross), cell(r, c.serviceFee)]), options, warnings, 'this Airbnb file');
  const sn = { order: resolveDateOrder(data.flatMap((r) => [cell(r, c.date), cell(r, c.start), cell(r, c.end), cell(r, c.arriving)]), options, warnings, 'this Airbnb file') };
  const txns = [];
  let read = 0;
  let skipped = 0;
  let currentPayout = null;
  let currentPayoutDate = null;
  let payoutSeq = 0;
  const payoutTotals = new Map();
  for (const row of data) {
    read++;
    const typeRaw = cell(row, c.type);
    const type = mapType(typeRaw);
    const dateRaw = cell(row, c.date);
    const date = parseDate(dateRaw, sn.order);
    if (!date) { skipped++; warnings.push(`Skipped an Airbnb row with an unreadable date "${dateRaw}".`); continue; }
    const currency = cell(row, c.currency) || options.currency || 'USD';
    if (type === 'payout') {
      const paid = parseMoney(cell(row, c.paidOut), decimal);
      if (paid === null || Number.isNaN(paid)) { skipped++; warnings.push(`Skipped an Airbnb payout row dated ${dateRaw}: unreadable Paid out amount.`); continue; }
      payoutSeq++;
      const ref = cell(row, c.ref);
      currentPayout = ref || `airbnb-${date}-${payoutSeq}`;
      currentPayoutDate = parseDate(cell(row, c.arriving), sn.order) || date;
      payoutTotals.set(currentPayout, { paid: Math.abs(paid), items: 0 });
      const details = cleanText(cell(row, c.details));
      txns.push(makeTxn({
        date, description: `Airbnb payout${details ? ' - ' + details : ''}`, amountCents: -Math.abs(paid), currency,
        id: ref ? `payout-${ref}` : undefined, type: 'payout', payoutId: currentPayout, payoutDate: currentPayoutDate, raw: rawObject(header, row),
      }));
      continue;
    }
    const amount = parseMoney(cell(row, c.amount), decimal);
    if (amount === null || Number.isNaN(amount)) { skipped++; warnings.push(`Skipped an Airbnb ${typeRaw || 'row'} dated ${dateRaw}: unreadable Amount.`); continue; }
    if (amount === 0) { skipped++; continue; }
    const gross = parseMoney(cell(row, c.gross), decimal);
    const code = cell(row, c.code);
    const guest = cleanText(cell(row, c.guest));
    const listing = cleanText(cell(row, c.listing));
    const start = cell(row, c.start);
    const end = cell(row, c.end);
    const parts = [typeRaw, code, guest, listing, start && end ? `${start}-${end}` : ''].filter(Boolean);
    const t = {
      date, description: parts.join(' - '), amountCents: amount, currency, type, counterparty: guest || undefined,
      payoutId: currentPayout || undefined, payoutDate: currentPayout ? currentPayoutDate : undefined, raw: rawObject(header, row),
    };
    if (gross !== null && !Number.isNaN(gross) && gross !== 0) {
      t.grossCents = gross;
      t.feeCents = gross - amount; // host service fee (+ Fast Pay fee)
      t.netCents = amount;
    } else {
      const sf = parseMoney(cell(row, c.serviceFee), decimal);
      if (sf && !Number.isNaN(sf)) {
        // Adjustments carry signed fees: amount = gross - fee with matching signs.
        const fee = amount < 0 ? -Math.abs(sf) : Math.abs(sf);
        t.grossCents = amount + fee; t.feeCents = fee; t.netCents = amount;
      }
    }
    if (currentPayout) payoutTotals.get(currentPayout).items += amount;
    txns.push(makeTxn(t));
  }
  let off = 0;
  for (const [, v] of payoutTotals) if (v.items !== v.paid) off++;
  if (off) warnings.push(`${off} Airbnb payout(s) do not equal the sum of the rows listed under them. This can happen when one payout mixes currencies or the export is filtered; check those payouts before importing.`);
  if (!payoutTotals.size) warnings.push('No payout rows found: this looks like the Upcoming earnings export, which lists money not yet paid. For your books, export the Paid tab instead.');
  warnings.push('Occupancy taxes that Airbnb collects and remits are not included in amounts (they never reach you); they are kept in each row\'s raw data.');
  // Exports list newest first with each payout above its items; reverse so
  // items precede their payout within a day.
  const desc = txns.length > 1 && txns[0].date > txns[txns.length - 1].date;
  const sorted = sortByDate(desc ? txns.reverse() : txns);
  return { transactions: sorted, warnings, meta: finishMeta(sorted, read, skipped, { timeZone: 'as exported (Airbnb does not state a time zone)' }) };
}
