import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/logic.js';

const part = (id, name, euros, categoryId, per = 'zahlung') => ({ id, name, amount: Math.round(euros * 100), per, categoryId });

function pot(over = {}) {
  return {
    id: 'auto',
    name: 'Topf Auto',
    type: 'ausgabe',
    amount: 26000,
    interval: 'monatlich',
    anchor: '2026-11-01',
    end: null,
    categoryId: 'mobilitaet',
    active: true,
    bookedThrough: null,
    note: '',
    createdAt: '2026-11-16T00:00:00.000Z',
    parts: [part('p1', 'Steuer', 10, 'mobilitaet'), part('p2', 'Tanken', 120, 'mobilitaet'), part('p3', 'Versicherung', 60, 'versicherungen'), part('p4', 'Wartung', 30, 'mobilitaet'), part('p5', 'Garage', 40, 'wohnen')],
    ...over,
  };
}

test('splitAmount: Summe stimmt immer auf den Cent', () => {
  assert.deepEqual(L.splitAmount(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(L.splitAmount(1000, []), []);
  assert.deepEqual(L.splitAmount(500, [0, 0]), [500, 0]);
  for (let i = 0; i < 200; i++) {
    const w = Array.from({ length: 1 + (i % 9) }, (_, k) => ((i * 7 + k * 13) % 50) + 0.37);
    const total = 1 + ((i * 991) % 100000);
    const out = L.splitAmount(total, w);
    assert.equal(out.reduce((a, b) => a + b, 0), total);
    assert.ok(out.every((x) => Number.isInteger(x) && x >= 0));
  }
});

test('Topf bucht einmal pro Monat, aufgeteilt auf die Kategorien der Posten', () => {
  let s = L.createInitialState();
  s.contracts.push(pot());
  const r = L.bookDueContracts(s, '2026-12-15', 'now');
  assert.equal(r.added, 2); // 01.11. und 01.12.
  const e = r.state.entries[0];
  assert.equal(e.amount, 26000);
  assert.equal(e.id, 'auto@2026-11-01');
  assert.equal(e.split.reduce((a, p) => a + p.amount, 0), 26000);
  assert.deepEqual(e.split.map((p) => p.amount), [1000, 12000, 6000, 3000, 4000]);

  const m = L.summarize(r.state, '2026-11');
  assert.equal(m.expense, 26000);
  assert.equal(m.fixed, 26000);
  const by = Object.fromEntries(m.byCategory.map((b) => [b.category.id, b.amount]));
  assert.deepEqual(by, { mobilitaet: 16000, versicherungen: 6000, wohnen: 4000 });

  // Kategorie-Filter findet die Topf-Buchung über ihre Posten
  assert.equal(L.entriesFor(r.state, { match: '2026-11', categoryId: 'versicherungen' }).length, 1);
  assert.equal(L.entriesFor(r.state, { match: '2026-11', categoryId: 'hund' }).length, 0);
  assert.equal(L.entriesFor(r.state, { query: 'garage' }).length, 2);
});

test('Jährliche Posten in einem Monats-Topf: Überweisung wird anteilig verteilt', () => {
  const c = pot({
    id: 'jahr',
    name: 'Jährliche Ausgaben',
    amount: 3000,
    parts: [part('a', 'Hausrat', 80, 'versicherungen', 'jahr'), part('b', 'Haftpflicht', 50.5, 'versicherungen', 'jahr'), part('c', 'Hundesteuer', 60, 'hund', 'jahr'), part('d', 'Streaming', 120, 'abos', 'jahr')],
  });
  assert.equal(Math.round(L.partsTotal(c.parts, c.interval)), Math.round(31050 / 12));
  const split = L.contractSplit(c);
  assert.equal(split.reduce((a, p) => a + p.amount, 0), 3000);
  assert.equal(L.contractPerMonth(c), 3000); // gezählt wird, was wirklich überwiesen wird
  assert.equal(L.mainPartCategory(c.parts, c.interval), 'abos'); // größter einzelner Posten (Streaming)
});

test('Sparposten im Topf zählen als „Gespart“, nicht als Ausgabe', () => {
  let s = L.createInitialState();
  s.contracts.push(pot({ amount: 30000, parts: [part('a', 'Essen', 200, 'essen'), part('b', 'Notgroschen', 100, 'sparen')] }));
  s = L.bookDueContracts(s, '2026-11-01', 'now').state;
  const m = L.summarize(s, '2026-11');
  assert.equal(m.expense, 20000);
  assert.equal(m.saving, 10000);
  assert.equal(L.contractTotals(s, '2026-11-01').savingMonth, 10000);
});

test('Töpfe stehen nicht doppelt in den Kategorie-Gruppen', () => {
  const s = L.createInitialState();
  s.contracts.push(pot());
  assert.equal(L.runningPots(s, '2026-11-16').length, 1);
  assert.equal(L.contractGroups(s, '2026-11-16').length, 0);
  assert.equal(L.contractTotals(s, '2026-11-16').expenseMonth, 26000);
});

test('rescaleSplit: geänderter Betrag wird anteilig neu verteilt', () => {
  const split = [{ name: 'A', categoryId: 'essen', amount: 30000 }, { name: 'B', categoryId: 'hund', amount: 5000 }];
  const out = L.rescaleSplit(split, 50000);
  assert.equal(out.reduce((a, p) => a + p.amount, 0), 50000);
  assert.equal(out[1].name, 'B');
});

test('validateState: Töpfe überleben Sicherung und Abgleich, Kaputtes wird abgelehnt', () => {
  let s = L.createInitialState();
  s.contracts.push(pot());
  s = L.bookDueContracts(s, '2026-11-01', 'now').state;
  const v = L.validateState(JSON.parse(JSON.stringify(L.buildBackup(s))));
  assert.ok(v.ok, v.error);
  assert.deepEqual(v.state.contracts[0].parts, s.contracts[0].parts);
  assert.deepEqual(v.state.entries[0].split, s.entries[0].split);

  const bad = JSON.parse(JSON.stringify(s));
  bad.entries[0].split[0].amount += 1;
  assert.equal(L.validateState(bad).ok, false);
  const bad2 = JSON.parse(JSON.stringify(s));
  bad2.contracts[0].parts[0].per = 'woche';
  assert.equal(L.validateState(bad2).ok, false);
  const future = { ...s, schema: L.SCHEMA_VERSION + 1 };
  assert.equal(L.validateState(future).ok, false);

  // Drei-Wege-Abgleich behält die Aufteilung
  const merged = L.mergeThreeWay(null, v.state, L.createInitialState());
  assert.deepEqual(merged.entries[0].split, s.entries[0].split);
});

test('Lebensmittel wird beim Laden mit Essen & Trinken zusammengelegt', () => {
  const old = L.createInitialState();
  old.schema = 1;
  old.categories.unshift({ id: 'lebensmittel', name: 'Lebensmittel', emoji: '🛒', type: 'ausgabe' });
  old.entries.push({ id: 'a', type: 'ausgabe', amount: 1000, date: '2026-11-01', categoryId: 'lebensmittel', note: 'REWE', createdAt: '' });
  old.contracts.push(pot({ parts: [part('x', 'Einkauf', 300, 'lebensmittel'), part('y', 'Restaurant', 50, 'essen')], amount: 35000, categoryId: 'lebensmittel' }));
  const v = L.validateState(old);
  assert.ok(v.ok, v.error);
  assert.ok(!v.state.categories.some((c) => c.id === 'lebensmittel'));
  assert.equal(v.state.entries[0].categoryId, 'essen');
  assert.equal(v.state.contracts[0].categoryId, 'essen');
  assert.deepEqual(v.state.contracts[0].parts.map((p) => p.categoryId), ['essen', 'essen']);
  // zweimal laden ändert nichts mehr
  assert.deepEqual(L.validateState(v.state).state, v.state);
});

test('CSV: Topf-Buchung als eine Zeile je Posten', () => {
  let s = L.createInitialState();
  s.contracts.push(pot());
  s = L.bookDueContracts(s, '2026-11-01', 'now').state;
  const lines = L.buildCsv(s).trim().split('\r\n');
  assert.equal(lines.length, 1 + 5);
  assert.equal(lines[2], '01.11.2026;Ausgabe;-120,00;Auto & Mobilität;Topf Auto · Tanken;Topf Auto');
});
