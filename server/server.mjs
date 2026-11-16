// Kleiner Server für finanzen.jakobg.de, ohne Abhängigkeiten (nur Node).
//
// 1. Liefert die App-Dateien aus (nur eine feste Liste, nichts anderes aus dem Repo).
// 2. Speichert pro Sync-Schlüssel einen verschlüsselten Datenblock. Der Server kann
//    ihn nicht lesen: Er kennt weder den Schlüssel noch den Inhalt, nur eine
//    Prüfsumme des Zugangscodes.
//
// API:  GET /api/v/<id>   → 200 {rev, blob} | 404
//       PUT /api/v/<id>   {base, blob} → 200 {rev} | 409 {rev} (Stand veraltet)
//       Kopfzeile: Authorization: Bearer <Zugangscode>
//
// Umgebung: PORT (8080), APP_DIR (Repo-Ordner), DATA_DIR (Speicher), KEEP (alte Stände, 30)

import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || process.argv[2] || 8080);
const APP_DIR = path.resolve(process.env.APP_DIR || path.join(HERE, '..'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(HERE, 'data'));
const KEEP = +(process.env.KEEP || 30);
const MAX_BODY = 10 * 1024 * 1024;

const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/js/app.js': ['js/app.js', 'text/javascript; charset=utf-8'],
  '/js/logic.js': ['js/logic.js', 'text/javascript; charset=utf-8'],
  '/js/store.js': ['js/store.js', 'text/javascript; charset=utf-8'],
  '/js/sync.js': ['js/sync.js', 'text/javascript; charset=utf-8'],
  '/icons/icon-192.png': ['icons/icon-192.png', 'image/png'],
  '/icons/icon-512.png': ['icons/icon-512.png', 'image/png'],
  '/icons/icon-maskable-512.png': ['icons/icon-maskable-512.png', 'image/png'],
  '/icons/apple-touch-icon.png': ['icons/apple-touch-icon.png', 'image/png'],
  '/icons/favicon-32.png': ['icons/favicon-32.png', 'image/png'],
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const ID_RE = /^[0-9a-f]{64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// Ein Schreibvorgang pro Speicherplatz gleichzeitig
const locks = new Map();
function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  locks.set(id, tail);
  tail.then(() => {
    if (locks.get(id) === tail) locks.delete(id);
  });
  return next;
}

// Bremse für falsche Zugangscodes: höchstens 20 Fehlversuche pro IP und Stunde
const failures = new Map();
function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.since > 3600_000) {
    failures.delete(ip);
    return false;
  }
  return f.count >= 20;
}
function noteFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.since > 3600_000) failures.set(ip, { since: Date.now(), count: 1 });
  else f.count++;
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
function sameHash(a, b) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

function send(res, status, body, headers = {}) {
  const isJson = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body ?? '';
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } : {}),
    ...headers,
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readVault(id) {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, id, 'current.json'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeVault(id, vault) {
  const dir = path.join(DATA_DIR, id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const json = JSON.stringify(vault);
  // Alter Stand als Rückfallebene (verschlüsselt, wie alles hier)
  await fs.writeFile(path.join(dir, `rev-${String(vault.rev).padStart(8, '0')}.json`), json, { mode: 0o600 });
  const tmp = path.join(dir, `current.json.${process.pid}.tmp`);
  await fs.writeFile(tmp, json, { mode: 0o600 });
  await fs.rename(tmp, path.join(dir, 'current.json'));
  const old = (await fs.readdir(dir)).filter((f) => f.startsWith('rev-')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - KEEP))) await fs.unlink(path.join(dir, f)).catch(() => {});
}

function validBlob(b) {
  return (
    b &&
    typeof b === 'object' &&
    b.v === 1 &&
    (b.z === 0 || b.z === 1) &&
    typeof b.iv === 'string' &&
    b.iv.length <= 32 &&
    typeof b.ct === 'string' &&
    /^[A-Za-z0-9+/]+=*$/.test(b.iv) &&
    /^[A-Za-z0-9+/]+=*$/.test(b.ct) &&
    Object.keys(b).length === 4
  );
}

async function handleApi(req, res, id, ip) {
  if (!ID_RE.test(id)) return send(res, 404, { error: 'not found' });
  if (tooManyFailures(ip)) return send(res, 429, { error: 'too many attempts' });
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!TOKEN_RE.test(token)) {
    noteFailure(ip);
    return send(res, 401, { error: 'unauthorized' });
  }
  const tokenHash = sha256(token);

  if (req.method === 'GET') {
    const vault = await readVault(id);
    if (!vault) return send(res, 404, { error: 'not found' });
    if (!sameHash(vault.tokenHash, tokenHash)) {
      noteFailure(ip);
      return send(res, 403, { error: 'forbidden' });
    }
    return send(res, 200, { rev: vault.rev, blob: vault.blob });
  }

  if (req.method === 'PUT') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      return send(res, err.status || 400, { error: 'bad request' });
    }
    if (!body || !Number.isSafeInteger(body.base) || body.base < 0 || !validBlob(body.blob)) {
      return send(res, 400, { error: 'bad request' });
    }
    return withLock(id, async () => {
      const vault = await readVault(id);
      if (vault && !sameHash(vault.tokenHash, tokenHash)) {
        noteFailure(ip);
        return send(res, 403, { error: 'forbidden' });
      }
      const current = vault ? vault.rev : 0;
      if (body.base !== current) return send(res, 409, { rev: current });
      const next = {
        rev: current + 1,
        tokenHash,
        createdAt: vault?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        blob: body.blob,
      };
      await writeVault(id, next);
      return send(res, 200, { rev: next.rev });
    });
  }

  return send(res, 405, { error: 'method not allowed' }, { Allow: 'GET, PUT' });
}

async function handleStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  const entry = FILES[pathname];
  if (!entry) return send(res, 404, 'Nicht gefunden', { 'Content-Type': 'text/plain; charset=utf-8' });
  let data;
  try {
    data = await fs.readFile(path.join(APP_DIR, entry[0]));
  } catch {
    return send(res, 404, 'Nicht gefunden', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  const etag = '"' + createHash('sha1').update(data).digest('base64url') + '"';
  const headers = { 'Content-Type': entry[1], 'Cache-Control': 'no-cache', ETag: etag };
  if (req.headers['if-none-match'] === etag) return send(res, 304, '', headers);
  return send(res, 200, req.method === 'HEAD' ? '' : data, { ...headers, 'Content-Length': data.length });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    // Hinter Caddy: echte Client-IP aus X-Forwarded-For (Caddy setzt sie)
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
    try {
      const { pathname } = new URL(req.url, 'http://x');
      const m = pathname.match(/^\/api\/v\/([^/]+)$/);
      if (m) return await handleApi(req, res, m[1], ip);
      if (pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      if (pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
      return await handleStatic(req, res, pathname);
    } catch (err) {
      console.error(new Date().toISOString(), err);
      if (!res.headersSent) send(res, 500, { error: 'server error' });
      else res.destroy();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const server = createServer();
  server.requestTimeout = 30_000;
  server.listen(PORT, () => console.log(`finanzen läuft auf Port ${PORT}, App aus ${APP_DIR}, Daten in ${DATA_DIR}`));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
