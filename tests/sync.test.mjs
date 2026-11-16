import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as L from '../js/logic.js';
import * as Y from '../js/sync.js';

let server;
let base;
let dataDir;

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'finanzen-sync-'));
  process.env.DATA_DIR = dataDir;
  process.env.KEEP = '3';
  const { createServer } = await import('../server/server.mjs?' + Date.now());
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await rm(dataDir, { recursive: true, force: true });
});

const fetchFn = (url, opts) => fetch(new URL(url, base), opts);
const entry = (id, amount, extra = {}) => ({
  id,
  type: 'ausgabe',
  amount,
  date: '2026-11-10',
  categoryId: 'lebensmittel',
  note: id,
  createdAt: '2026-11-10T10:00:00.000Z',
  ...extra,
});
const ids = (s) => s.entries.map((e) => e.id).sort();

/** Simuliertes Gerät: lokaler Stand + letzte gemeinsame Basis. */
function device(keys, state = L.createInitialState(new Date('2026-11-01T00:00:00Z'))) {
  const d = {
    state: L.validateState(state).state,
    base: null,
    async sync(mode) {
      const r = await Y.syncOnce({ keys, local: d.state, base: d.base, mode, fetchFn });
      d.state = r.state;
      d.base = r.state;
      return r;
    },
  };
  return d;
}

test('Schlüssel: erzeugen, Tippfehler-tolerant lesen, Ableitung stabil', async () => {
  const k = Y.generateKey();
  assert.match(k, /^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
  assert.equal(Y.parseKey(k.toLowerCase().replace(/-/g, ' ')), k.replace(/-/g, ''));
  assert.equal(Y.parseKey('ABC'), null);
  assert.equal(Y.parseKey(k.slice(0, -1) + '!'), null);
  const a = await Y.deriveKeys(k);
  const b = await Y.deriveKeys(k.toLowerCase());
  assert.equal(a.vaultId, b.vaultId);
  assert.equal(a.token, b.token);
  assert.match(a.vaultId, /^[0-9a-f]{64}$/);
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  const other = await Y.deriveKeys(Y.generateKey());
  assert.notEqual(other.vaultId, a.vaultId);
});

test('Verschlüsselung: hin und zurück, falscher Schlüssel scheitert, Inhalt nicht lesbar', async () => {
  const keys = await Y.deriveKeys(Y.generateKey());
  const s = L.createInitialState();
  s.entries.push(entry('geheim-rewe', 1234));
  const blob = await Y.encryptState(keys, s);
  assert.ok(!JSON.stringify(blob).includes('geheim-rewe'));
  const back = await Y.decryptState(keys, blob);
  assert.deepEqual(back.entries.map((e) => e.id), ['geheim-rewe']);
  const wrong = await Y.deriveKeys(Y.generateKey());
  await assert.rejects(Y.decryptState(wrong, blob), (e) => e.code === 'decrypt');
  const tampered = { ...blob, ct: blob.ct.slice(0, -4) + (blob.ct.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA') };
  await assert.rejects(Y.decryptState(keys, tampered), (e) => e.code === 'decrypt');
});

test('Drei-Wege-Abgleich: Hinzufügen, Löschen, Ändern, Konflikte', () => {
  const v = (s) => L.validateState(s).state;
  const s0 = v({ ...L.createInitialState(), entries: [entry('a', 100), entry('b', 200), entry('c', 300), entry('d', 400)] });
  const local = v({ ...s0, entries: [entry('a', 111), entry('c', 300), entry('d', 444), entry('neu-l', 5)] }); // a geändert, b gelöscht, d geändert
  const remote = v({ ...s0, entries: [entry('a', 100), entry('b', 200), entry('d', 499), entry('neu-r', 6)] }); // c gelöscht, d geändert
  const m = L.mergeThreeWay(s0, local, remote);
  const by = Object.fromEntries(m.entries.map((e) => [e.id, e.amount]));
  assert.deepEqual(Object.keys(by).sort(), ['a', 'd', 'neu-l', 'neu-r']);
  assert.equal(by.a, 111); // nur hier geändert
  assert.equal(by.d, 444); // beide geändert: dieses Gerät gewinnt
  // Löschen gegen Ändern: Änderung bleibt
  const l2 = v({ ...s0, entries: s0.entries.filter((e) => e.id !== 'b') });
  const r2 = v({ ...s0, entries: s0.entries.map((e) => (e.id === 'b' ? entry('b', 999) : e)) });
  assert.equal(L.mergeThreeWay(s0, l2, r2).entries.find((e) => e.id === 'b').amount, 999);
  assert.equal(L.mergeThreeWay(s0, r2, l2).entries.find((e) => e.id === 'b').amount, 999);
  // Ohne Basis (erstes Verbinden): nichts geht verloren
  const u = L.mergeThreeWay(null, local, remote);
  assert.deepEqual(ids(u), ['a', 'b', 'c', 'd', 'neu-l', 'neu-r']);
});

test('Fixkosten: feste Buchungs-IDs, keine Doppelbuchung über zwei Geräte', () => {
  const c = { id: 'netflix', name: 'Netflix', type: 'ausgabe', amount: 1399, interval: 'monatlich', anchor: '2026-09-05', end: null, categoryId: 'abos', active: true, bookedThrough: null, note: '', createdAt: '2026-09-01T00:00:00.000Z' };
  const s0 = L.validateState({ ...L.createInitialState(), contracts: [c] }).state;
  const a = L.bookDueContracts(s0, '2026-11-16').state;
  const b = L.bookDueContracts(s0, '2026-11-16', '2026-11-16T22:00:00.000Z').state;
  assert.deepEqual(ids(a), ['netflix@2026-09-05', 'netflix@2026-10-05', 'netflix@2026-11-05']);
  const m = L.validateState(L.mergeThreeWay(s0, a, b)).state;
  assert.equal(m.entries.length, 3);
  // schon vorhandene Buchung wird nicht nochmal angelegt, Stand rückt trotzdem vor
  const again = L.bookDueContracts({ ...m, contracts: [{ ...m.contracts[0], bookedThrough: '2026-10-05' }] }, '2026-11-16');
  assert.equal(again.added, 0);
  assert.equal(again.state.contracts[0].bookedThrough, '2026-11-05');
  assert.equal(again.state.entries.length, 3);
});

test('Sync über den Server: zwei Geräte, Löschen kommt an, Server sieht nur Zeichensalat', async () => {
  const key = Y.generateKey();
  const keys = await Y.deriveKeys(key);
  const phone = device(keys);
  phone.state.entries.push(entry('rewe', 2350), entry('kino', 1200));
  phone.state = L.validateState(phone.state).state;
  const r1 = await phone.sync('create');
  assert.equal(r1.rev, 1);
  assert.equal(r1.pushed, true);

  const laptop = device(keys);
  await assert.rejects(device(await Y.deriveKeys(Y.generateKey())).sync('join'), (e) => e.code === 'notfound');
  await laptop.sync('join');
  assert.deepEqual(ids(laptop.state), ['kino', 'rewe']);

  // Laptop löscht kino und ändert rewe; Handy trägt parallel etwas ein
  laptop.state = L.validateState({ ...laptop.state, entries: [entry('rewe', 2400)] }).state;
  await laptop.sync();
  phone.state = L.validateState({ ...phone.state, entries: [...phone.state.entries, entry('tanken', 6000)] }).state;
  await phone.sync();
  assert.deepEqual(ids(phone.state), ['rewe', 'tanken']);
  assert.equal(phone.state.entries.find((e) => e.id === 'rewe').amount, 2400);
  await laptop.sync();
  assert.deepEqual(ids(laptop.state), ['rewe', 'tanken']);

  // Nichts geändert: kein neuer Upload
  const idle = await laptop.sync();
  assert.equal(idle.pushed, false);

  // Auf dem Server liegt nichts Lesbares, alte Stände begrenzt (KEEP=3)
  const dir = path.join(dataDir, keys.vaultId);
  const files = await readdir(dir);
  assert.ok(files.includes('current.json'));
  assert.ok(files.filter((f) => f.startsWith('rev-')).length <= 3);
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(path.join(dir, 'current.json'), 'utf8');
  assert.ok(!raw.includes('rewe') && !raw.includes('tanken'));
  assert.ok(!raw.includes(keys.token));
});

test('Server: falscher Zugangscode, veralteter Stand, kaputte Anfragen, Dateiliste', async () => {
  const keys = await Y.deriveKeys(Y.generateKey());
  const d = device(keys);
  await d.sync('create');
  const evil = { ...keys, token: (await Y.deriveKeys(Y.generateKey())).token };
  await assert.rejects(Y.syncOnce({ keys: evil, local: d.state, base: null, fetchFn }), (e) => e.code === 'auth');

  const url = new URL(`api/v/${keys.vaultId}`, base);
  const h = { Authorization: `Bearer ${keys.token}`, 'Content-Type': 'application/json' };
  const blob = await Y.encryptState(keys, d.state);
  let r = await fetch(url, { method: 'PUT', headers: h, body: JSON.stringify({ base: 0, blob }) });
  assert.equal(r.status, 409);
  r = await fetch(url, { method: 'PUT', headers: h, body: JSON.stringify({ base: 1, blob: { ...blob, extra: 1 } }) });
  assert.equal(r.status, 400);
  r = await fetch(url, { method: 'PUT', headers: h, body: '{kaputt' });
  assert.equal(r.status, 400);
  r = await fetch(url, { method: 'DELETE', headers: h });
  assert.equal(r.status, 405);
  r = await fetch(new URL('api/v/../../etc/passwd', base));
  assert.equal(r.status, 404);

  // App-Dateien ja, alles andere aus dem Repo nein
  r = await fetch(new URL('index.html', base));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  for (const p of ['server/server.mjs', 'package.json', 'privat/import-haushaltsplaene-2023-2026.json', '.git/config', 'README.md', 'js/../server/server.mjs']) {
    r = await fetch(new URL(p, base));
    assert.equal(r.status, 404, p);
  }
});

test('Server: gleichzeitige Uploads überschreiben sich nicht, beide Änderungen bleiben', async () => {
  const keys = await Y.deriveKeys(Y.generateKey());
  const a = device(keys);
  await a.sync('create');
  const b = device(keys);
  await b.sync('join');
  a.state = L.validateState({ ...a.state, entries: [entry('von-a', 100)] }).state;
  b.state = L.validateState({ ...b.state, entries: [entry('von-b', 200)] }).state;
  await Promise.all([a.sync(), b.sync()]);
  await a.sync();
  await b.sync();
  assert.deepEqual(ids(a.state), ['von-a', 'von-b']);
  assert.deepEqual(ids(b.state), ['von-a', 'von-b']);
});
