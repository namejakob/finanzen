// Verschlüsselter Abgleich zwischen Geräten (z. B. Handy und Laptop).
//
// Ein zufälliger Sync-Schlüssel (160 Bit) ist das einzige Geheimnis. Daraus werden
// abgeleitet: der Name des Speicherplatzes auf dem Server, ein Zugangscode und
// der AES-256-Schlüssel. Verschlüsselt wird auf dem Gerät; der Server sieht nur
// Zeichensalat und kann den Inhalt nicht lesen. Ohne Schlüssel ist nichts zu
// retten, deshalb bleibt er auf jedem verbundenen Gerät in den Einstellungen sichtbar.
//
// Läuft im Browser und in Node (Tests), nutzt nur die eingebaute Web-Crypto-API.

import * as L from './logic.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // Base32 ohne 0/1/8/9
const KEY_BYTES = 20;
const SALT = new TextEncoder().encode('finanzen-sync-v1');
const subtle = () => globalThis.crypto.subtle;

// ---------------------------------------------------------------- Schlüssel

export function generateKey() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  return formatKey(base32(bytes));
}

/** Schlüssel in Vierergruppen: ABCD-EFGH-… */
export function formatKey(raw) {
  return raw.match(/.{1,4}/g).join('-');
}

/** Liest einen eingetippten Schlüssel. Gibt die 32 Zeichen oder null zurück. */
export function parseKey(input) {
  if (typeof input !== 'string') return null;
  const s = input
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/0/g, 'O')
    .replace(/1/g, 'I')
    .replace(/8/g, 'B');
  if (s.length !== 32 || [...s].some((ch) => !ALPHABET.includes(ch))) return null;
  return s;
}

function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(s) {
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Leitet Speicherplatz-ID, Zugangscode und AES-Schlüssel aus dem Sync-Schlüssel ab. */
export async function deriveKeys(keyText) {
  const raw = parseKey(keyText);
  if (!raw) throw new Error('Ungültiger Sync-Schlüssel');
  const ikm = await subtle().importKey('raw', unbase32(raw), 'HKDF', false, ['deriveBits', 'deriveKey']);
  const bits = async (info) =>
    new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: new TextEncoder().encode(info) }, ikm, 256));
  const vaultId = hex(await bits('vault-id'));
  const token = b64url(await bits('auth-token'));
  const aes = await subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: new TextEncoder().encode('aes-gcm-key') },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { vaultId, token, aes };
}

// ---------------------------------------------------------------- Verschlüsseln

async function gzip(bytes, inverse = false) {
  const Stream = inverse ? globalThis.DecompressionStream : globalThis.CompressionStream;
  const stream = new Blob([bytes]).stream().pipeThrough(new Stream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const canZip = () => typeof globalThis.CompressionStream === 'function' && typeof globalThis.DecompressionStream === 'function';

export async function encryptState(keys, state) {
  let data = new TextEncoder().encode(JSON.stringify(state));
  const z = canZip();
  if (z) data = await gzip(data);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ad = new TextEncoder().encode(keys.vaultId);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: ad }, keys.aes, data));
  return { v: 1, z: z ? 1 : 0, iv: b64(iv), ct: b64(ct) };
}

export async function decryptState(keys, blob) {
  if (!blob || blob.v !== 1 || typeof blob.iv !== 'string' || typeof blob.ct !== 'string') throw new SyncError('format');
  let data;
  try {
    const ad = new TextEncoder().encode(keys.vaultId);
    data = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: unb64(blob.iv), additionalData: ad }, keys.aes, unb64(blob.ct)));
  } catch {
    throw new SyncError('decrypt');
  }
  if (blob.z) {
    if (!canZip()) throw new SyncError('format');
    data = await gzip(data, true);
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new SyncError('format');
  }
  const v = L.validateState(parsed);
  if (!v.ok) throw new SyncError('invalid', v.error);
  return v.state;
}

// ---------------------------------------------------------------- Abgleich

export class SyncError extends Error {
  constructor(code, detail = '') {
    super(code + (detail ? ': ' + detail : ''));
    this.code = code; // offline | auth | notfound | decrypt | format | invalid | server | conflict
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const normalize = (s) => {
  const v = L.validateState(s);
  if (!v.ok) throw new SyncError('invalid', v.error);
  return v.state;
};

async function request(fetchFn, method, keys, body) {
  let res;
  try {
    res = await fetchFn(`api/v/${keys.vaultId}`, {
      method,
      cache: 'no-store',
      headers: { Authorization: `Bearer ${keys.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new SyncError('offline');
  }
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

/**
 * Ein Abgleich mit dem Server.
 * mode 'join': Speicherplatz muss existieren (zweites Gerät). Sonst wird er angelegt.
 * Gibt { state, rev, pushed } zurück: 'state' ist der neue gemeinsame Stand
 * (= neue Basis), der auch auf dem Server liegt.
 */
export async function syncOnce({ keys, local, base, mode = 'sync', fetchFn = globalThis.fetch.bind(globalThis) }) {
  const L0 = normalize(local);
  const B0 = base ? normalize(base) : null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const got = await request(fetchFn, 'GET', keys);
    let remote = null;
    let remoteRev = 0;
    if (got.status === 200 && got.json) {
      remoteRev = got.json.rev;
      remote = await decryptState(keys, got.json.blob);
    } else if (got.status === 404) {
      if (mode === 'join') throw new SyncError('notfound');
    } else if (got.status === 401 || got.status === 403) {
      throw new SyncError('auth');
    } else {
      throw new SyncError('server', String(got.status));
    }
    const merged = remote ? normalize(L.mergeThreeWay(B0, L0, remote)) : L0;
    if (remote && same(merged, remote)) return { state: merged, rev: remoteRev, pushed: false };
    const put = await request(fetchFn, 'PUT', keys, { base: remoteRev, blob: await encryptState(keys, merged) });
    if (put.status === 200 && put.json) return { state: merged, rev: put.json.rev, pushed: true };
    if (put.status === 409) continue; // jemand war schneller: neu holen und nochmal abgleichen
    if (put.status === 401 || put.status === 403) throw new SyncError('auth');
    throw new SyncError('server', String(put.status));
  }
  throw new SyncError('conflict');
}

export function errorText(err) {
  switch (err?.code) {
    case 'offline':
      return 'Keine Verbindung. Wird nachgeholt, sobald Internet da ist.';
    case 'auth':
      return 'Der Server lehnt den Sync-Schlüssel ab.';
    case 'notfound':
      return 'Zu diesem Schlüssel gibt es keine Daten. Bitte den Schlüssel prüfen.';
    case 'decrypt':
      return 'Die Daten auf dem Server passen nicht zu diesem Schlüssel.';
    case 'format':
    case 'invalid':
      return 'Die Daten auf dem Server sind unlesbar oder von einer neueren App-Version.';
    case 'conflict':
      return 'Abgleich gerade nicht möglich, ein anderes Gerät schreibt. Wird wiederholt.';
    default:
      return 'Der Server antwortet nicht richtig. Wird später wiederholt.';
  }
}
