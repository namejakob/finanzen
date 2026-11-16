// Reine Rechenlogik ohne Browser-Abhängigkeiten (in Node testbar).
// Geld wird überall als ganze Cent (Integer) geführt, nie als Kommazahl.
// Datumsangaben sind lokale Kalendertage im Format 'JJJJ-MM-TT' (Strings),
// damit es keine Zeitzonenfehler gibt.

export const SCHEMA_VERSION = 1;
export const MAX_AMOUNT_CENTS = 100_000_000; // 1 Mio. € als Plausibilitätsgrenze

export const INTERVALS = {
  monatlich: { months: 1, label: 'monatlich', short: 'mtl.' },
  vierteljaehrlich: { months: 3, label: 'vierteljährlich', short: 'quartalsw.' },
  halbjaehrlich: { months: 6, label: 'halbjährlich', short: 'halbj.' },
  jaehrlich: { months: 12, label: 'jährlich', short: 'jährl.' },
};

export const FALLBACK_CATEGORY = { ausgabe: 'sonstiges', einnahme: 'einnahmen-sonstige' };

export const DEFAULT_CATEGORIES = [
  { id: 'lebensmittel', name: 'Lebensmittel', emoji: '🛒', type: 'ausgabe' },
  { id: 'essen', name: 'Essen & Trinken', emoji: '🍽️', type: 'ausgabe' },
  { id: 'wohnen', name: 'Wohnen', emoji: '🏠', type: 'ausgabe' },
  { id: 'mobilitaet', name: 'Auto & Mobilität', emoji: '🚗', type: 'ausgabe' },
  { id: 'versicherungen', name: 'Versicherungen', emoji: '🛡️', type: 'ausgabe' },
  { id: 'abos', name: 'Abos & Verträge', emoji: '🔁', type: 'ausgabe' },
  { id: 'gesundheit', name: 'Gesundheit & Sport', emoji: '💪', type: 'ausgabe' },
  { id: 'freizeit', name: 'Freizeit', emoji: '🎉', type: 'ausgabe' },
  { id: 'shopping', name: 'Shopping', emoji: '🛍️', type: 'ausgabe' },
  { id: 'reisen', name: 'Reisen', emoji: '✈️', type: 'ausgabe' },
  { id: 'geschenke', name: 'Geschenke', emoji: '🎁', type: 'ausgabe' },
  { id: 'hund', name: 'Hund', emoji: '🐶', type: 'ausgabe' },
  { id: 'sparen', name: 'Sparen & Anlegen', emoji: '🐷', type: 'ausgabe', saving: true },
  { id: 'sonstiges', name: 'Sonstiges', emoji: '📦', type: 'ausgabe' },
  { id: 'gehalt', name: 'Gehalt', emoji: '💼', type: 'einnahme' },
  { id: 'erstattungen', name: 'Erstattungen', emoji: '↩️', type: 'einnahme' },
  { id: 'einnahmen-sonstige', name: 'Sonstige Einnahmen', emoji: '➕', type: 'einnahme' },
];

// ---------------------------------------------------------------- Geld

/**
 * Liest einen eingetippten Betrag ("12,50", "12.5", "1.234,56", "1234") in Cent.
 * Gibt null zurück, wenn die Eingabe kein gültiger positiver Betrag ist.
 */
export function parseAmount(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) return null;
    const c = Math.round(input * 100);
    return c > 0 && c <= MAX_AMOUNT_CENTS ? c : null;
  }
  if (typeof input !== 'string') return null;
  const s = input.replace(/[\s  €]/g, '');
  if (!s) return null;
  let intPart;
  let fracPart = '';
  let m;
  if ((m = s.match(/^(\d{1,3}(?:\.\d{3})+)(?:,(\d{1,2}))?$/))) {
    // deutsch mit Tausenderpunkt: 1.234 oder 1.234,56
    intPart = m[1].replace(/\./g, '');
    fracPart = m[2] || '';
  } else if ((m = s.match(/^(\d{1,3}(?:,\d{3})+)\.(\d{1,2})$/))) {
    // englisch mit Tausenderkomma und Dezimalpunkt: 1,234.56
    intPart = m[1].replace(/,/g, '');
    fracPart = m[2];
  } else if ((m = s.match(/^(\d*)[,.](\d{1,2})$/))) {
    // 12,5 · 12.50 · ,5
    intPart = m[1] || '0';
    fracPart = m[2];
  } else if ((m = s.match(/^(\d+)[,.]?$/))) {
    intPart = m[1];
  } else {
    return null;
  }
  if (intPart.length > 9) return null;
  const cents = parseInt(intPart, 10) * 100 + (fracPart ? parseInt(fracPart.padEnd(2, '0'), 10) : 0);
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_AMOUNT_CENTS) return null;
  return cents;
}

const moneyFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const moneyFmtRound = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** 123456 → "1.234,56 €". Mit {sign:true} bekommen positive Werte ein "+". */
export function formatMoney(cents, { sign = false, round = false } = {}) {
  const value = Math.round(cents) / 100;
  const txt = (round ? moneyFmtRound : moneyFmt).format(Math.abs(value));
  if (Math.round(cents) < 0) return '−' + txt;
  if (sign && Math.round(cents) > 0) return '+' + txt;
  return txt;
}

/** Cent → Text für ein Eingabefeld: 1250 → "12,50" */
export function centsToInput(cents) {
  const euros = Math.floor(cents / 100);
  const rest = String(cents % 100).padStart(2, '0');
  return `${euros},${rest}`;
}

// ---------------------------------------------------------------- Datum

const pad = (n, l = 2) => String(n).padStart(l, '0');

export function toISO(y, m, d) {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/** Heutiger lokaler Kalendertag (nicht UTC!). */
export function todayISO(now = new Date()) {
  return toISO(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function parseISO(iso) {
  const m = typeof iso === 'string' && iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3] };
}

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function isValidISO(iso) {
  const p = parseISO(iso);
  if (!p) return false;
  if (p.y < 1900 || p.y > 2200 || p.m < 1 || p.m > 12) return false;
  return p.d >= 1 && p.d <= daysInMonth(p.y, p.m);
}

/**
 * Addiert Monate und kappt den Tag am Monatsende (31.01. + 1 → 28./29.02.).
 * Wichtig: immer vom ursprünglichen Datum aus rechnen, nicht schrittweise,
 * sonst wandert der 31. dauerhaft auf den 28.
 */
export function addMonthsClamped(iso, n) {
  const p = parseISO(iso);
  const total = p.y * 12 + (p.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return toISO(y, m, Math.min(p.d, daysInMonth(y, m)));
}

export function addDays(iso, n) {
  const p = parseISO(iso);
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return toISO(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function daysBetween(a, b) {
  const pa = parseISO(a);
  const pb = parseISO(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000);
}

export const monthKey = (iso) => iso.slice(0, 7);
export const yearOf = (iso) => +iso.slice(0, 4);

export function addMonthKey(key, n) {
  return addMonthsClamped(key + '-01', n).slice(0, 7);
}

export const MONTH_NAMES = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];
export const MONTH_SHORT = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

export function formatMonthKey(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

export function weekday(iso) {
  const p = parseISO(iso);
  return WEEKDAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()];
}

/** "14.11.2026" */
export function formatDate(iso) {
  const p = parseISO(iso);
  return `${pad(p.d)}.${pad(p.m)}.${p.y}`;
}

/** Tagesüberschrift: "Heute", "Gestern" oder "Sa, 14.11." */
export function formatDayLabel(iso, today) {
  if (iso === today) return 'Heute';
  if (iso === addDays(today, -1)) return 'Gestern';
  const p = parseISO(iso);
  const t = parseISO(today);
  return `${weekday(iso)}, ${pad(p.d)}.${pad(p.m)}.${p.y !== t.y ? p.y : ''}`;
}

// ---------------------------------------------------------------- IDs

export function newId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ---------------------------------------------------------------- Zustand

export function createInitialState(now = new Date()) {
  return {
    schema: SCHEMA_VERSION,
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    entries: [],
    contracts: [],
    settings: { createdAt: now.toISOString(), lastBackupAt: null },
  };
}

export function categoryMap(state) {
  const map = new Map();
  for (const c of state.categories) map.set(c.id, c);
  return map;
}

// ---------------------------------------------------------------- Fixkosten

export function intervalMonths(interval) {
  const def = INTERVALS[interval];
  if (!def) throw new Error('Unbekanntes Intervall: ' + interval);
  return def.months;
}

/**
 * Alle Fälligkeiten eines Vertrags im Zeitraum (afterExclusive, untilInclusive].
 * afterExclusive darf null sein (= ab Beginn).
 */
export function occurrences(contract, afterExclusive, untilInclusive, limit = 5000) {
  const step = intervalMonths(contract.interval);
  const out = [];
  for (let i = 0; i < limit; i++) {
    const d = addMonthsClamped(contract.anchor, i * step);
    if (d > untilInclusive) break;
    if (contract.end && d > contract.end) break;
    if (afterExclusive && d <= afterExclusive) continue;
    out.push(d);
  }
  return out;
}

/** Nächste noch nicht gebuchte Fälligkeit nach 'afterExclusive' (oder null). */
export function nextOccurrence(contract, afterExclusive) {
  const step = intervalMonths(contract.interval);
  const from = contract.bookedThrough && contract.bookedThrough > afterExclusive ? contract.bookedThrough : afterExclusive;
  for (let i = 0; i < 5000; i++) {
    const d = addMonthsClamped(contract.anchor, i * step);
    if (contract.end && d > contract.end) return null;
    if (d > from) return d;
  }
  return null;
}

/** Durchschnittliche Kosten pro Monat in Cent (kann Nachkommastellen haben). */
export function contractPerMonth(contract) {
  return contract.amount / intervalMonths(contract.interval);
}

export function contractPerYear(contract) {
  return (contract.amount * 12) / intervalMonths(contract.interval);
}

/** Gilt der Vertrag heute noch (aktiv und nicht abgelaufen)? */
export function isContractRunning(contract, today) {
  if (!contract.active) return false;
  if (contract.end && contract.end < today) return false;
  return true;
}

/**
 * Bucht alle fälligen, noch nicht gebuchten Fixkosten bis einschließlich 'today'
 * als normale Buchungen. Gibt einen neuen Zustand zurück (das Original bleibt
 * unverändert) und die Zahl der neuen Buchungen.
 */
export function bookDueContracts(state, today, nowIso = new Date().toISOString()) {
  let added = 0;
  const newEntries = [];
  const existing = new Set(state.entries.map((e) => e.id));
  const contracts = state.contracts.map((c) => {
    if (!c.active) return c;
    const dates = occurrences(c, c.bookedThrough || null, today);
    if (!dates.length) return c;
    for (const date of dates) {
      // Feste ID je Vertrag und Fälligkeit: Buchen zwei synchronisierte Geräte
      // dieselbe Zahlung, entsteht dieselbe Buchung statt einer doppelten.
      const id = contractEntryId(c.id, date);
      if (existing.has(id)) continue;
      existing.add(id);
      newEntries.push({
        id,
        type: c.type,
        amount: c.amount,
        date,
        categoryId: c.categoryId,
        note: c.name,
        contractId: c.id,
        createdAt: nowIso,
      });
      added++;
    }
    return { ...c, bookedThrough: dates[dates.length - 1] };
  });
  if (!added) {
    // Evtl. nur den Buchungsstand vorgerückt (Zahlung war schon da)
    const moved = contracts.some((c, i) => c !== state.contracts[i]);
    return { state: moved ? { ...state, contracts } : state, added: 0 };
  }
  return { state: { ...state, contracts, entries: [...state.entries, ...newEntries] }, added };
}

/** Anstehende Zahlungen (nach heute) bis 'days' Tage voraus, sortiert. */
export function upcomingPayments(state, today, days = 30) {
  const until = addDays(today, days);
  const list = [];
  for (const c of state.contracts) {
    if (!c.active) continue;
    const after = c.bookedThrough && c.bookedThrough > today ? c.bookedThrough : today;
    for (const date of occurrences(c, after, until)) list.push({ contract: c, date });
  }
  list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.contract.amount - a.contract.amount));
  return list;
}

/** Summen über alle laufenden Verträge. */
export function contractTotals(state, today) {
  const cats = categoryMap(state);
  const t = { expenseMonth: 0, expenseYear: 0, incomeMonth: 0, incomeYear: 0, reserveMonth: 0, savingMonth: 0 };
  for (const c of state.contracts) {
    if (!isContractRunning(c, today)) continue;
    const pm = contractPerMonth(c);
    const py = contractPerYear(c);
    if (c.type === 'einnahme') {
      t.incomeMonth += pm;
      t.incomeYear += py;
    } else {
      t.expenseMonth += pm;
      t.expenseYear += py;
      if (intervalMonths(c.interval) > 1) t.reserveMonth += pm;
      if (cats.get(c.categoryId)?.saving) t.savingMonth += pm;
    }
  }
  return t;
}

/** Laufende Verträge nach Kategorie gruppiert, größte Gruppe zuerst. */
export function contractGroups(state, today, type = 'ausgabe') {
  const cats = categoryMap(state);
  const groups = new Map();
  for (const c of state.contracts) {
    if (c.type !== type || !isContractRunning(c, today)) continue;
    const cat = cats.get(c.categoryId) || cats.get(FALLBACK_CATEGORY[type]);
    const key = cat ? cat.id : 'unbekannt';
    if (!groups.has(key)) groups.set(key, { category: cat, contracts: [], perMonth: 0, perYear: 0 });
    const g = groups.get(key);
    g.contracts.push(c);
    g.perMonth += contractPerMonth(c);
    g.perYear += contractPerYear(c);
  }
  const arr = [...groups.values()];
  for (const g of arr) g.contracts.sort((a, b) => contractPerMonth(b) - contractPerMonth(a) || a.name.localeCompare(b.name, 'de'));
  arr.sort((a, b) => b.perMonth - a.perMonth);
  return arr;
}

// ---------------------------------------------------------------- Auswertung

/**
 * Fasst Buchungen zusammen. 'match' ist ein Präfix des Datums:
 * 'JJJJ-MM' für einen Monat, 'JJJJ' für ein Jahr.
 * Sparen zählt nicht als Ausgabe, sondern wird getrennt ausgewiesen.
 */
export function summarize(state, match) {
  const cats = categoryMap(state);
  const res = { income: 0, expense: 0, saving: 0, fixed: 0, count: 0, rest: 0, byCategory: [], incomeByCategory: [] };
  const byCat = new Map();
  const incByCat = new Map();
  for (const e of state.entries) {
    if (!e.date.startsWith(match)) continue;
    res.count++;
    if (e.type === 'einnahme') {
      res.income += e.amount;
      incByCat.set(e.categoryId, (incByCat.get(e.categoryId) || 0) + e.amount);
      continue;
    }
    const cat = cats.get(e.categoryId);
    if (cat?.saving) {
      res.saving += e.amount;
      continue;
    }
    res.expense += e.amount;
    if (e.contractId) res.fixed += e.amount;
    byCat.set(e.categoryId, (byCat.get(e.categoryId) || 0) + e.amount);
  }
  res.rest = res.income - res.expense - res.saving;
  const toList = (map, type) =>
    [...map.entries()]
      .map(([id, amount]) => ({ category: cats.get(id) || cats.get(FALLBACK_CATEGORY[type]) || { id, name: 'Unbekannt', emoji: '❔' }, amount }))
      .sort((a, b) => b.amount - a.amount);
  res.byCategory = toList(byCat, 'ausgabe');
  res.incomeByCategory = toList(incByCat, 'einnahme');
  return res;
}

/** Monatswerte eines Jahres für das Balkendiagramm. */
export function yearByMonth(state, year) {
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const s = summarize(state, `${year}-${pad(m)}`);
    months.push({ month: m, key: `${year}-${pad(m)}`, income: s.income, expense: s.expense, saving: s.saving });
  }
  return months;
}

/** Sparquote in Prozent: Anteil der Einnahmen, der nicht ausgegeben wurde. */
export function savingsRate(summary) {
  if (summary.income <= 0) return null;
  return Math.round(((summary.income - summary.expense) / summary.income) * 100);
}

export function entriesFor(state, { match = null, categoryId = null, query = '' } = {}) {
  const cats = categoryMap(state);
  const q = query.trim().toLocaleLowerCase('de');
  return state.entries
    .filter((e) => {
      if (match && !e.date.startsWith(match)) return false;
      if (categoryId && e.categoryId !== categoryId) return false;
      if (q) {
        const cat = cats.get(e.categoryId);
        const hay = `${e.note || ''} ${cat ? cat.name : ''} ${formatMoney(e.amount)} ${centsToInput(e.amount)}`.toLocaleLowerCase('de');
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || '').localeCompare(a.createdAt || '')));
}

// ---------------------------------------------------------------- Vorschläge

const normNote = (s) => (s || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('de');

/**
 * Häufige Notizen der Handeingaben als Schnellwahl (Notiz + zuletzt benutzte Kategorie).
 * Automatisch gebuchte Fixkosten zählen nicht mit.
 */
export function noteSuggestions(state, type, limit = 8) {
  const map = new Map();
  for (const e of state.entries) {
    if (e.type !== type || e.contractId || !e.note || !e.note.trim()) continue;
    const k = normNote(e.note);
    const cur = map.get(k);
    const stamp = e.date + (e.createdAt || '');
    if (!cur) map.set(k, { note: e.note.trim(), categoryId: e.categoryId, count: 1, last: stamp });
    else {
      cur.count++;
      if (stamp > cur.last) {
        cur.last = stamp;
        cur.note = e.note.trim();
        cur.categoryId = e.categoryId;
      }
    }
  }
  const cats = categoryMap(state);
  return [...map.values()]
    .filter((s) => cats.has(s.categoryId))
    .sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1))
    .slice(0, limit);
}

/** Zuletzt für diese Notiz benutzte Kategorie (oder null). */
export function learnedCategory(state, type, note) {
  const k = normNote(note);
  if (!k) return null;
  const cats = categoryMap(state);
  let best = null;
  for (const e of state.entries) {
    if (e.type !== type || e.contractId || normNote(e.note) !== k || !cats.has(e.categoryId)) continue;
    const stamp = e.date + (e.createdAt || '');
    if (!best || stamp > best.stamp) best = { stamp, categoryId: e.categoryId };
  }
  return best ? best.categoryId : null;
}

// ---------------------------------------------------------------- Sicherung

/**
 * Prüft einen geladenen Zustand (z. B. aus einer Sicherungsdatei) streng.
 * Gibt {ok:true, state} mit bereinigtem Zustand oder {ok:false, error} zurück.
 */
export function validateState(raw) {
  try {
    if (raw && raw.app === 'finanzen' && raw.data) raw = raw.data;
    if (!raw || typeof raw !== 'object') return fail('Die Datei enthält keine Finanzdaten.');
    if (typeof raw.schema !== 'number') return fail('Unbekanntes Dateiformat.');
    if (raw.schema > SCHEMA_VERSION) return fail('Die Sicherung stammt aus einer neueren App-Version. Bitte erst die App aktualisieren.');
    if (!Array.isArray(raw.categories) || !Array.isArray(raw.entries) || !Array.isArray(raw.contracts)) {
      return fail('Die Datei ist unvollständig.');
    }
    const categories = [];
    const seenCat = new Set();
    for (const c of raw.categories) {
      if (!c || typeof c.id !== 'string' || !c.id || seenCat.has(c.id)) return fail('Fehlerhafte Kategorie in der Datei.');
      if (c.type !== 'ausgabe' && c.type !== 'einnahme') return fail(`Kategorie „${c.name}“ hat keinen gültigen Typ.`);
      seenCat.add(c.id);
      categories.push({
        id: c.id,
        name: str(c.name, 40) || 'Ohne Namen',
        emoji: str(c.emoji, 8) || '•',
        type: c.type,
        ...(c.saving ? { saving: true } : {}),
      });
    }
    // Auffangkategorien müssen existieren
    for (const def of DEFAULT_CATEGORIES) {
      if (Object.values(FALLBACK_CATEGORY).includes(def.id) && !seenCat.has(def.id)) {
        categories.push({ ...def });
        seenCat.add(def.id);
      }
    }
    const typeOf = new Map(categories.map((c) => [c.id, c.type]));
    const fixCat = (id, type) => (typeOf.get(id) === type ? id : FALLBACK_CATEGORY[type]);

    const contracts = [];
    const seenContract = new Set();
    for (const c of raw.contracts) {
      if (!c || typeof c.id !== 'string' || seenContract.has(c.id)) return fail('Fehlerhafter Vertrag in der Datei.');
      if (c.type !== 'ausgabe' && c.type !== 'einnahme') return fail(`Vertrag „${c.name}“ hat keinen gültigen Typ.`);
      if (!INTERVALS[c.interval]) return fail(`Vertrag „${c.name}“ hat kein gültiges Intervall.`);
      if (!validCents(c.amount)) return fail(`Vertrag „${c.name}“ hat keinen gültigen Betrag.`);
      if (!isValidISO(c.anchor)) return fail(`Vertrag „${c.name}“ hat kein gültiges Startdatum.`);
      if (c.end != null && c.end !== '' && !isValidISO(c.end)) return fail(`Vertrag „${c.name}“ hat ein ungültiges Enddatum.`);
      if (c.bookedThrough != null && !isValidISO(c.bookedThrough)) return fail(`Vertrag „${c.name}“ ist beschädigt.`);
      seenContract.add(c.id);
      contracts.push({
        id: c.id,
        name: str(c.name, 60) || 'Vertrag',
        type: c.type,
        amount: c.amount,
        interval: c.interval,
        anchor: c.anchor,
        end: c.end || null,
        categoryId: fixCat(c.categoryId, c.type),
        active: c.active !== false,
        bookedThrough: c.bookedThrough || null,
        note: str(c.note, 200),
        createdAt: typeof c.createdAt === 'string' ? c.createdAt : new Date().toISOString(),
      });
    }

    const entries = [];
    const seenEntry = new Set();
    for (const e of raw.entries) {
      if (!e || typeof e.id !== 'string' || seenEntry.has(e.id)) return fail('Fehlerhafte Buchung in der Datei.');
      if (e.type !== 'ausgabe' && e.type !== 'einnahme') return fail('Eine Buchung hat keinen gültigen Typ.');
      if (!validCents(e.amount)) return fail(`Buchung vom ${e.date} hat keinen gültigen Betrag.`);
      if (!isValidISO(e.date)) return fail('Eine Buchung hat ein ungültiges Datum.');
      seenEntry.add(e.id);
      entries.push({
        id: e.id,
        type: e.type,
        amount: e.amount,
        date: e.date,
        categoryId: fixCat(e.categoryId, e.type),
        note: str(e.note, 120),
        ...(typeof e.contractId === 'string' && e.contractId ? { contractId: e.contractId } : {}),
        createdAt: typeof e.createdAt === 'string' ? e.createdAt : new Date().toISOString(),
      });
    }
    const s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
    return {
      ok: true,
      state: {
        schema: SCHEMA_VERSION,
        categories,
        entries,
        contracts,
        settings: {
          createdAt: typeof s.createdAt === 'string' ? s.createdAt : new Date().toISOString(),
          lastBackupAt: typeof s.lastBackupAt === 'string' ? s.lastBackupAt : null,
        },
      },
    };
  } catch (err) {
    return fail('Die Datei konnte nicht gelesen werden.');
  }
  function fail(error) {
    return { ok: false, error };
  }
}

function validCents(v) {
  return Number.isSafeInteger(v) && v > 0 && v <= MAX_AMOUNT_CENTS;
}
function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** Ergänzt 'current' um alles aus 'incoming', was es noch nicht gibt (nach ID). */
export function mergeStates(current, incoming) {
  const catIds = new Set(current.categories.map((c) => c.id));
  const entryIds = new Set(current.entries.map((e) => e.id));
  const contractIds = new Set(current.contracts.map((c) => c.id));
  const newCats = incoming.categories.filter((c) => !catIds.has(c.id));
  const newEntries = incoming.entries.filter((e) => !entryIds.has(e.id));
  const newContracts = incoming.contracts.filter((c) => !contractIds.has(c.id));
  return {
    state: {
      ...current,
      categories: [...current.categories, ...newCats],
      entries: [...current.entries, ...newEntries],
      contracts: [...current.contracts, ...newContracts],
    },
    added: { categories: newCats.length, entries: newEntries.length, contracts: newContracts.length },
  };
}

/** ID der automatischen Buchung eines Vertrags an einem Fälligkeitstag. */
export function contractEntryId(contractId, date) {
  return `${contractId}@${date}`;
}

/**
 * Drei-Wege-Abgleich für den Sync zweier Geräte.
 * base   = letzter gemeinsamer Stand (null beim ersten Abgleich)
 * local  = Stand auf diesem Gerät, remote = Stand auf dem Server.
 * Je Datensatz (nach ID): Wer ihn seit 'base' geändert hat, gewinnt.
 * Haben beide geändert, gewinnt dieses Gerät. Gelöscht wird nur, was die
 * andere Seite unverändert gelassen hat; Löschen gegen Ändern behält die Änderung.
 * Alle drei Stände müssen durch validateState gegangen sein.
 */
export function mergeThreeWay(base, local, remote) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const mergeList = (b = [], l, r, onConflict = (x) => x) => {
    const B = new Map(b.map((x) => [x.id, x]));
    const R = new Map(r.map((x) => [x.id, x]));
    const Lids = new Set(l.map((x) => x.id));
    const out = [];
    const pick = (id, lv, rv) => {
      const bv = B.get(id);
      if (lv && rv) {
        if (same(lv, rv)) return lv;
        if (bv && same(lv, bv)) return rv;
        if (bv && same(rv, bv)) return lv;
        return onConflict(lv, rv);
      }
      if (lv) return bv && same(lv, bv) ? null : lv; // anderswo gelöscht?
      return bv && same(rv, bv) ? null : rv; // hier gelöscht?
    };
    for (const lv of l) {
      const v = pick(lv.id, lv, R.get(lv.id));
      if (v) out.push(v);
    }
    for (const rv of r) {
      if (Lids.has(rv.id)) continue;
      const v = pick(rv.id, null, rv);
      if (v) out.push(v);
    }
    return out;
  };
  const laterIso = (a, b) => (!a ? b : !b ? a : a > b ? a : b);
  const contractConflict = (l, r) => ({ ...l, bookedThrough: laterIso(l.bookedThrough, r.bookedThrough) });
  const ls = local.settings || {};
  const rs = remote.settings || {};
  const createdAt = [ls.createdAt, rs.createdAt].filter(Boolean).sort()[0] || new Date().toISOString();
  return {
    schema: SCHEMA_VERSION,
    categories: mergeList(base?.categories, local.categories, remote.categories),
    entries: mergeList(base?.entries, local.entries, remote.entries),
    contracts: mergeList(base?.contracts, local.contracts, remote.contracts, contractConflict),
    settings: { createdAt, lastBackupAt: laterIso(ls.lastBackupAt || null, rs.lastBackupAt || null) },
  };
}

export function buildBackup(state, now = new Date()) {
  return { app: 'finanzen', exportedAt: now.toISOString(), data: state };
}

/** CSV für Excel (Semikolon, deutsches Komma, mit BOM). */
export function buildCsv(state) {
  const cats = categoryMap(state);
  const contracts = new Map(state.contracts.map((c) => [c.id, c]));
  const q = (v) => {
    let s = String(v ?? '');
    // Schutz vor Formel-Ausführung in Excel
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [['Datum', 'Typ', 'Betrag', 'Kategorie', 'Notiz', 'Fixkosten']];
  const sorted = [...state.entries].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const e of sorted) {
    const signed = e.type === 'ausgabe' ? -e.amount : e.amount;
    const abs = Math.abs(signed);
    const amountTxt = `${signed < 0 ? '-' : ''}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
    rows.push([
      formatDate(e.date),
      e.type === 'ausgabe' ? 'Ausgabe' : 'Einnahme',
      amountTxt,
      cats.get(e.categoryId)?.name || '',
      e.note || '',
      e.contractId ? contracts.get(e.contractId)?.name || 'ja' : '',
    ]);
  }
  // Betrag bewusst nicht durch q(): "-12,50" soll als Zahl in Excel ankommen.
  return '﻿' + rows.map((r) => r.map((v, i) => (i === 2 && r !== rows[0] ? v : q(v))).join(';')).join('\r\n') + '\r\n';
}
