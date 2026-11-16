// Speicher: IndexedDB auf dem Gerät. Nichts verlässt das Gerät.
// Der gesamte Zustand liegt als ein Datensatz unter dem Schlüssel 'state'.
// Vor einem Import wird der alte Stand unter 'before-import' aufgehoben.

const DB_NAME = 'finanzen-app';
const STORE = 'kv';
const LS_PREFIX = 'finanzen-app:'; // Notlösung, falls IndexedDB nicht verfügbar ist

let dbPromise = null;
let useLocalStorage = false;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('IndexedDB fehlt'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      // Falls eine neuere App-Version die Datenbank öffnen will: Verbindung freigeben
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Datenbank blockiert'));
  }).catch((err) => {
    console.warn('IndexedDB nicht nutzbar, nutze localStorage', err);
    useLocalStorage = true;
    return null;
  });
  return dbPromise;
}

async function idbGet(key) {
  const db = await openDb();
  if (!db) {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw == null ? undefined : JSON.parse(raw);
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  if (!db) {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
    return;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    // erst nach dem Abschluss der Transaktion gilt der Wert als gespeichert
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Speichern abgebrochen'));
  });
}

async function idbDelete(key) {
  const db = await openDb();
  if (!db) {
    localStorage.removeItem(LS_PREFIX + key);
    return;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Schreibvorgänge strikt nacheinander, damit nie ein älterer Stand einen neueren überschreibt.
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export const loadState = () => idbGet('state');
// structuredClone: gespeichert wird eine Momentaufnahme, keine Referenz auf den Live-Zustand
export const saveState = (state) => enqueue(() => idbSet('state', structuredClone(state)));
export const loadBeforeImport = () => idbGet('before-import');
export const saveBeforeImport = (state) => enqueue(() => idbSet('before-import', { savedAt: new Date().toISOString(), state: structuredClone(state) }));
export const clearBeforeImport = () => enqueue(() => idbDelete('before-import'));
// Abgleich: Sync-Schlüssel, letzter gemeinsamer Stand und Revision
export const loadSync = () => idbGet('sync');
export const saveSync = (cfg) => enqueue(() => idbSet('sync', structuredClone(cfg)));
export const clearSync = () => enqueue(() => idbDelete('sync'));
export const wipeAll = () => enqueue(async () => {
  await idbDelete('state');
  await idbDelete('before-import');
});

export function storageKind() {
  return useLocalStorage ? 'localStorage' : 'IndexedDB';
}

/** Bittet den Browser, die Daten nicht bei Speicherknappheit zu löschen. */
export async function requestPersistence() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

export async function isPersisted() {
  try {
    if (!navigator.storage || !navigator.storage.persisted) return null;
    return await navigator.storage.persisted();
  } catch {
    return null;
  }
}
