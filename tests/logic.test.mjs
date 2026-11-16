// Tests der Rechenlogik. Ausführen mit:  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/logic.js';

test('parseAmount: deutsche und englische Schreibweisen', () => {
  const cases = {
    '12': 1200,
    '12,5': 1250,
    '12,50': 1250,
    '12.50': 1250,
    '12.5': 1250,
    ',5': 50,
    '0,99': 99,
    '1.234': 123400,
    '1.234,56': 123456,
    '1.234.567,89': 123456789 > L.MAX_AMOUNT_CENTS ? null : 123456789,
    '1,234.56': 123456,
    '12 €': 1200,
    ' 7,30 ': 730,
    '12,': 1200,
    '19,99': 1999,
    '0,01': 1,
  };
  for (const [input, want] of Object.entries(cases)) assert.equal(L.parseAmount(input), want, input);
});

test('parseAmount: ungültige Eingaben', () => {
  for (const bad of ['', ' ', '0', '0,00', '-5', 'abc', '12,345', '1,234', '1.2.3', '12,5,5', '€', '1e5', '12..5', '1.234,567']) {
    assert.equal(L.parseAmount(bad), null, JSON.stringify(bad));
  }
  assert.equal(L.parseAmount(null), null);
  assert.equal(L.parseAmount(undefined), null);
  assert.equal(L.parseAmount('10000000,01'), null); // über 1 Mio.
  assert.equal(L.parseAmount('1000000'), 100000000);
});

test('formatMoney und centsToInput', () => {
  const nb = (s) => s.replace(/[  ]/g, ' ');
  assert.equal(nb(L.formatMoney(123456)), '1.234,56 €');
  assert.equal(nb(L.formatMoney(-500)), '−5,00 €');
  assert.equal(nb(L.formatMoney(500, { sign: true })), '+5,00 €');
  assert.equal(nb(L.formatMoney(0, { sign: true })), '0,00 €');
  assert.equal(nb(L.formatMoney(123456, { round: true })), '1.235 €');
  assert.equal(L.centsToInput(1250), '12,50');
  assert.equal(L.centsToInput(5), '0,05');
  assert.equal(L.parseAmount(L.centsToInput(98765)), 98765);
});

test('Datum: Monatsende wird gekappt, nicht verschleppt', () => {
  assert.equal(L.addMonthsClamped('2026-01-31', 1), '2026-02-28');
  assert.equal(L.addMonthsClamped('2028-01-31', 1), '2028-02-29');
  assert.equal(L.addMonthsClamped('2026-01-31', 2), '2026-03-31');
  assert.equal(L.addMonthsClamped('2026-11-15', 2), '2027-01-15');
  assert.equal(L.addMonthsClamped('2026-03-15', -3), '2025-12-15');
  assert.equal(L.addMonthKey('2026-12', 1), '2027-01');
  assert.equal(L.addMonthKey('2026-01', -1), '2025-12');
  assert.equal(L.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(L.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(L.daysBetween('2026-10-24', '2026-10-26'), 2); // über Zeitumstellung
  assert.equal(L.isValidISO('2026-02-29'), false);
  assert.equal(L.isValidISO('2028-02-29'), true);
  assert.equal(L.isValidISO('2026-13-01'), false);
  assert.equal(L.isValidISO('26-1-1'), false);
  assert.equal(L.weekday('2026-11-15'), 'So');
  assert.equal(L.formatDayLabel('2026-11-15', '2026-11-15'), 'Heute');
  assert.equal(L.formatDayLabel('2026-11-14', '2026-11-15'), 'Gestern');
  assert.equal(L.formatDayLabel('2026-11-12', '2026-11-15'), 'Do, 12.11.');
  assert.equal(L.formatDayLabel('2025-11-12', '2026-11-15'), 'Mi, 12.11.2025');
});

test('todayISO nutzt Ortszeit, nicht UTC', () => {
  const d = new Date(2026, 10, 15, 0, 30); // 00:30 Ortszeit
  assert.equal(L.todayISO(d), '2026-11-15');
});

const contract = (over = {}) => ({
  id: 'c1',
  name: 'Kfz-Versicherung',
  type: 'ausgabe',
  amount: 60000,
  interval: 'jaehrlich',
  anchor: '2027-01-01',
  end: null,
  categoryId: 'versicherungen',
  active: true,
  bookedThrough: null,
  note: '',
  createdAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

test('Fixkosten: Fälligkeiten', () => {
  const m = contract({ interval: 'monatlich', anchor: '2026-01-31', amount: 999 });
  assert.deepEqual(L.occurrences(m, null, '2026-04-30'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.deepEqual(L.occurrences(m, '2026-02-28', '2026-04-29'), ['2026-03-31']);
  assert.deepEqual(L.occurrences({ ...m, end: '2026-03-01' }, null, '2026-12-31'), ['2026-01-31', '2026-02-28']);
  const q = contract({ interval: 'vierteljaehrlich', anchor: '2026-11-15' });
  assert.deepEqual(L.occurrences(q, null, '2027-08-15'), ['2026-11-15', '2027-02-15', '2027-05-15', '2027-08-15']);
  assert.equal(L.nextOccurrence(q, '2026-11-15'), '2027-02-15');
  assert.equal(L.nextOccurrence(q, '2026-11-14'), '2026-11-15');
  assert.equal(L.nextOccurrence({ ...q, end: '2027-01-01' }, '2026-11-15'), null);
});

test('Fixkosten: Umrechnung pro Monat und Jahr', () => {
  assert.equal(L.contractPerMonth(contract()), 5000);
  assert.equal(L.contractPerYear(contract()), 60000);
  assert.equal(L.contractPerYear(contract({ interval: 'monatlich', amount: 1299 })), 15588);
  assert.equal(L.contractPerMonth(contract({ interval: 'vierteljaehrlich', amount: 3000 })), 1000);
  assert.equal(L.contractPerYear(contract({ interval: 'halbjaehrlich', amount: 3000 })), 6000);
});

function baseState() {
  const s = L.createInitialState(new Date(2026, 10, 1));
  return s;
}

test('Fixkosten werden genau einmal gebucht', () => {
  let s = baseState();
  s.contracts.push(contract({ id: 'netflix', name: 'Netflix', interval: 'monatlich', amount: 1399, anchor: '2026-10-20', categoryId: 'abos' }));
  s.contracts.push(contract()); // Kfz erst 2027
  let r = L.bookDueContracts(s, '2026-11-15');
  assert.equal(r.added, 1 + 0 + 0 + 1 - 1); // Okt. 20 → 1 Buchung (Nov. 20 noch nicht fällig)
  assert.equal(r.state.entries.length, 1);
  assert.equal(r.state.entries[0].date, '2026-10-20');
  assert.equal(r.state.entries[0].contractId, 'netflix');
  assert.equal(r.state.entries[0].note, 'Netflix');
  // erneuter Lauf am selben Tag bucht nichts doppelt
  const r2 = L.bookDueContracts(r.state, '2026-11-15');
  assert.equal(r2.added, 0);
  assert.equal(r2.state, r.state);
  // einen Monat später kommt genau eine dazu
  const r3 = L.bookDueContracts(r.state, '2026-12-25');
  assert.equal(r3.added, 2);
  assert.deepEqual(r3.state.entries.map((e) => e.date).sort(), ['2026-10-20', '2026-11-20', '2026-12-20']);
  // Original bleibt unverändert
  assert.equal(s.entries.length, 0);
  assert.equal(s.contracts[0].bookedThrough, null);
});

test('Fixkosten: gelöschte Buchung kommt nicht zurück, pausierte bucht nicht', () => {
  let s = baseState();
  s.contracts.push(contract({ id: 'm', interval: 'monatlich', amount: 500, anchor: '2026-11-01' }));
  let r = L.bookDueContracts(s, '2026-11-15');
  assert.equal(r.added, 1);
  const deleted = { ...r.state, entries: [] };
  assert.equal(L.bookDueContracts(deleted, '2026-11-20').added, 0);
  const paused = { ...r.state, contracts: r.state.contracts.map((c) => ({ ...c, active: false })) };
  assert.equal(L.bookDueContracts(paused, '2027-05-01').added, 0);
});

test('Fixkosten: Summen, Rücklage, Gruppen, Anstehendes', () => {
  const s = baseState();
  s.contracts.push(contract()); // 600 €/Jahr
  s.contracts.push(contract({ id: 'h', name: 'Haftpflicht', amount: 6000, anchor: '2026-12-01' })); // 60 €/Jahr
  s.contracts.push(contract({ id: 'n', name: 'Netflix', interval: 'monatlich', amount: 1399, anchor: '2026-11-20', categoryId: 'abos' }));
  s.contracts.push(contract({ id: 'g', name: 'Gehalt', type: 'einnahme', interval: 'monatlich', amount: 300000, anchor: '2026-11-28', categoryId: 'gehalt' }));
  s.contracts.push(contract({ id: 'alt', name: 'Alt', interval: 'monatlich', amount: 99999, anchor: '2020-01-01', end: '2026-01-01' }));
  s.contracts.push(contract({ id: 'pause', name: 'Pause', interval: 'monatlich', amount: 99999, anchor: '2026-01-01', active: false }));
  const t = L.contractTotals(s, '2026-11-15');
  assert.equal(t.expenseMonth, 5000 + 500 + 1399);
  assert.equal(t.expenseYear, 60000 + 6000 + 1399 * 12);
  assert.equal(t.reserveMonth, 5500);
  assert.equal(t.incomeMonth, 300000);
  const groups = L.contractGroups(s, '2026-11-15');
  assert.equal(groups.length, 2);
  assert.equal(groups[0].category.id, 'versicherungen');
  assert.equal(groups[0].contracts[0].name, 'Kfz-Versicherung');
  assert.equal(groups[0].perYear, 66000);
  const up = L.upcomingPayments(s, '2026-11-15', 30);
  assert.deepEqual(up.map((u) => u.contract.id), ['n', 'g', 'h']);
});

test('summarize: Monat, Sparen getrennt, Fixanteil', () => {
  const s = baseState();
  const e = (over) => ({ id: L.newId(), type: 'ausgabe', amount: 1000, date: '2026-11-10', categoryId: 'lebensmittel', note: '', createdAt: '', ...over });
  s.entries.push(
    e({ amount: 4250 }),
    e({ amount: 1750, categoryId: 'essen' }),
    e({ amount: 50000, categoryId: 'sparen' }),
    e({ amount: 1399, categoryId: 'abos', contractId: 'n' }),
    e({ type: 'einnahme', amount: 300000, categoryId: 'gehalt' }),
    e({ amount: 99900, date: '2026-10-31' }),
    e({ amount: 100, categoryId: 'gibtsnicht' }),
  );
  const m = L.summarize(s, '2026-11');
  assert.equal(m.income, 300000);
  assert.equal(m.expense, 4250 + 1750 + 1399 + 100);
  assert.equal(m.saving, 50000);
  assert.equal(m.fixed, 1399);
  assert.equal(m.rest, 300000 - 7499 - 50000);
  assert.equal(m.byCategory[0].category.id, 'lebensmittel');
  assert.ok(m.byCategory.some((b) => b.category.id === 'sonstiges'));
  assert.equal(L.savingsRate(m), Math.round(((300000 - 7499) / 300000) * 100));
  const y = L.summarize(s, '2026');
  assert.equal(y.expense, 7499 + 99900);
  const months = L.yearByMonth(s, 2026);
  assert.equal(months.length, 12);
  assert.equal(months[9].expense, 99900);
  assert.equal(months[10].income, 300000);
  assert.equal(L.savingsRate({ income: 0, expense: 5 }), null);
});

test('Vorschläge lernen aus Handeingaben', () => {
  const s = baseState();
  const e = (note, categoryId, date, createdAt = '') => ({ id: L.newId(), type: 'ausgabe', amount: 100, date, categoryId, note, createdAt });
  s.entries.push(
    e('REWE', 'lebensmittel', '2026-11-01'),
    e('rewe ', 'lebensmittel', '2026-11-03'),
    e('Rewe', 'essen', '2026-11-05'),
    e('Tanken', 'mobilitaet', '2026-11-02'),
    { ...e('Netflix', 'abos', '2026-11-02'), contractId: 'n' },
  );
  const sug = L.noteSuggestions(s, 'ausgabe');
  assert.equal(sug.length, 2);
  assert.equal(sug[0].note, 'Rewe');
  assert.equal(sug[0].count, 3);
  assert.equal(sug[0].categoryId, 'essen');
  assert.equal(L.learnedCategory(s, 'ausgabe', '  REWE'), 'essen');
  assert.equal(L.learnedCategory(s, 'ausgabe', 'Netflix'), null);
  assert.equal(L.learnedCategory(s, 'einnahme', 'Rewe'), null);
  assert.equal(L.learnedCategory(s, 'ausgabe', ''), null);
});

test('entriesFor: Suche und Sortierung', () => {
  const s = baseState();
  s.entries.push(
    { id: 'a', type: 'ausgabe', amount: 1250, date: '2026-11-01', categoryId: 'lebensmittel', note: 'Edeka', createdAt: '1' },
    { id: 'b', type: 'ausgabe', amount: 500, date: '2026-11-03', categoryId: 'essen', note: 'Döner', createdAt: '2' },
    { id: 'c', type: 'ausgabe', amount: 700, date: '2026-11-03', categoryId: 'essen', note: '', createdAt: '3' },
  );
  assert.deepEqual(L.entriesFor(s, { match: '2026-11' }).map((e) => e.id), ['c', 'b', 'a']);
  assert.deepEqual(L.entriesFor(s, { query: 'döner' }).map((e) => e.id), ['b']);
  assert.deepEqual(L.entriesFor(s, { query: 'essen' }).map((e) => e.id), ['c', 'b']);
  assert.deepEqual(L.entriesFor(s, { query: '12,50' }).map((e) => e.id), ['a']);
  assert.deepEqual(L.entriesFor(s, { categoryId: 'lebensmittel' }).map((e) => e.id), ['a']);
});

test('Sicherung: Rundlauf, Prüfung, Zusammenführen', () => {
  const s = baseState();
  s.contracts.push(contract());
  s.entries.push({ id: 'x', type: 'ausgabe', amount: 1250, date: '2026-11-01', categoryId: 'lebensmittel', note: 'Edeka', createdAt: '1' });
  const json = JSON.stringify(L.buildBackup(s));
  const v = L.validateState(JSON.parse(json));
  assert.equal(v.ok, true);
  assert.deepEqual(v.state.entries, s.entries);
  assert.deepEqual(v.state.contracts, s.contracts);
  assert.deepEqual(v.state.categories, s.categories);

  assert.equal(L.validateState(null).ok, false);
  assert.equal(L.validateState({ foo: 1 }).ok, false);
  assert.equal(L.validateState({ ...s, schema: 99 }).ok, false);
  assert.equal(L.validateState({ ...s, entries: [{ ...s.entries[0], amount: -5 }] }).ok, false);
  assert.equal(L.validateState({ ...s, entries: [{ ...s.entries[0], amount: 12.5 }] }).ok, false);
  assert.equal(L.validateState({ ...s, entries: [{ ...s.entries[0], date: '2026-02-30' }] }).ok, false);
  assert.equal(L.validateState({ ...s, entries: [s.entries[0], s.entries[0]] }).ok, false);
  assert.equal(L.validateState({ ...s, contracts: [{ ...s.contracts[0], interval: 'woechentlich' }] }).ok, false);

  // fehlende Kategorie → Auffangkategorie, fehlende Auffangkategorie wird ergänzt
  const odd = L.validateState({ ...s, categories: s.categories.filter((c) => c.id !== 'sonstiges'), entries: [{ ...s.entries[0], categoryId: 'weg' }] });
  assert.equal(odd.ok, true);
  assert.equal(odd.state.entries[0].categoryId, 'sonstiges');
  assert.ok(odd.state.categories.some((c) => c.id === 'sonstiges'));
  // Ausgabe-Kategorie an einer Einnahme wird korrigiert
  const wrongType = L.validateState({ ...s, entries: [{ ...s.entries[0], type: 'einnahme' }] });
  assert.equal(wrongType.state.entries[0].categoryId, 'einnahmen-sonstige');

  const other = L.createInitialState();
  other.entries.push({ id: 'y', type: 'ausgabe', amount: 100, date: '2026-11-02', categoryId: 'essen', note: '', createdAt: '' });
  other.entries.push(s.entries[0]);
  other.categories.push({ id: 'neu', name: 'Neu', emoji: '⭐', type: 'ausgabe' });
  const m = L.mergeStates(s, other);
  assert.deepEqual(m.added, { categories: 1, entries: 1, contracts: 0 });
  assert.equal(m.state.entries.length, 2);
});

test('CSV: Excel-tauglich und sicher', () => {
  const s = baseState();
  s.entries.push({ id: 'x', type: 'ausgabe', amount: 123456, date: '2026-11-01', categoryId: 'lebensmittel', note: '=HYPERLINK("x");1', createdAt: '' });
  s.entries.push({ id: 'y', type: 'einnahme', amount: 5, date: '2026-10-01', categoryId: 'gehalt', note: 'Gehalt', createdAt: '' });
  const csv = L.buildCsv(s);
  assert.ok(csv.startsWith('﻿Datum;Typ;Betrag;Kategorie;Notiz;Fixkosten\r\n'));
  const lines = csv.slice(1).trim().split('\r\n');
  assert.equal(lines[1], '01.10.2026;Einnahme;0,05;Gehalt;Gehalt;');
  assert.equal(lines[2], `01.11.2026;Ausgabe;-1234,56;Lebensmittel;"'=HYPERLINK(""x"");1";`);
});
