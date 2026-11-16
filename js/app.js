// Oberfläche der Finanz-App. Rechenlogik: logic.js, Speicher: store.js.
import * as L from './logic.js';
import * as S from './store.js';
import * as Y from './sync.js';

export const APP_VERSION = '1.2.0';
const SYNC_HOST = 'finanzen.jakobg.de';
// Abgleich nur unter der eigenen Adresse (dort läuft der Server) und lokal zum Testen
const SYNC_AVAILABLE = [SYNC_HOST, 'localhost', '127.0.0.1'].includes(location.hostname);

// ---------------------------------------------------------------- Zustand

let state = null;
const ui = {
  tab: 'uebersicht',
  mode: 'monat', // 'monat' | 'jahr'
  month: null,
  year: null,
  query: '',
  catFilter: null,
  lastToday: null,
  persisted: null,
  beforeImport: null,
};
const today = () => L.todayISO();
const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const sheet = $('#sheet');
const modal = $('#modal');
const channel = 'BroadcastChannel' in self ? new BroadcastChannel('finanzen-app') : null;

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const money = (c, o) => esc(L.formatMoney(c, o));
const nB = (n) => `${n} ${n === 1 ? 'Buchung' : 'Buchungen'}`;
const cat = (id) => state.categories.find((c) => c.id === id);
const catOrFallback = (id, type) => cat(id) || cat(L.FALLBACK_CATEGORY[type]) || { id, name: 'Unbekannt', emoji: '❔', type };
const POT_EMOJI = '🫙';
const contractEmoji = (c) => (L.isPot(c) ? POT_EMOJI : catOrFallback(c.categoryId, c.type).emoji);
const usesCat = (id) => (x) => x.categoryId === id || (x.split || x.parts || []).some((p) => p.categoryId === id);
const recat = (from, to) => (x) => {
  const fix = (o) => (o.categoryId === from ? { ...o, categoryId: to } : o);
  const y = fix(x);
  if (y.split) return { ...y, split: y.split.map(fix) };
  if (y.parts) return { ...y, parts: y.parts.map(fix) };
  return y;
};

const ICON = {
  left: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
};

// ---------------------------------------------------------------- Speichern

let saveFailed = false;
async function commit(next, { fromSync = false } = {}) {
  // Jede Änderung macht ältere Rückgängig-Knöpfe ungültig (sie würden sonst
  // auch alles verwerfen, was danach passiert ist).
  document.querySelectorAll('.toast.undoable').forEach((t) => t.remove());
  state = next;
  render();
  try {
    await S.saveState(state);
    if (saveFailed) {
      saveFailed = false;
      toast('Wieder gespeichert.');
    }
    channel?.postMessage('changed');
    if (!fromSync) scheduleSync();
    if (ui.persisted !== true) ui.persisted = await S.requestPersistence();
  } catch (err) {
    console.error(err);
    saveFailed = true;
    toast('Speichern fehlgeschlagen. Bitte jetzt eine Sicherung speichern (Mehr → Sicherung).', { error: true, duration: 12000 });
  }
}

/** Bucht fällige Fixkosten. Gibt zurück, ob sich etwas geändert hat. */
function runBooking() {
  const r = L.bookDueContracts(state, today());
  const changed = r.state !== state;
  state = r.state;
  return { added: r.added, changed };
}

// ---------------------------------------------------------------- Abgleich (Sync)

const sync = { cfg: null, keys: null, running: null, again: false, timer: null, error: null, showKey: false };
const sameState = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const normalized = (s) => L.validateState(s).state;

async function loadSyncConfig() {
  if (!SYNC_AVAILABLE) return;
  try {
    const cfg = await S.loadSync();
    if (cfg && Y.parseKey(cfg.key)) {
      if (!sync.keys || sync.cfg?.key !== cfg.key) sync.keys = await Y.deriveKeys(cfg.key);
      sync.cfg = cfg;
    } else {
      sync.cfg = null;
      sync.keys = null;
    }
  } catch (err) {
    console.warn('Sync-Einstellungen nicht lesbar', err);
  }
}

function scheduleSync(delay = 1500) {
  if (!sync.cfg) return;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(() => runSync(), delay);
}

/**
 * Gleicht mit dem Server ab. mode 'create' legt den Speicherplatz an,
 * 'join' verlangt, dass es ihn schon gibt. Wirft nur bei create/join.
 */
async function runSync(mode = 'sync') {
  if (mode === 'sync') await loadSyncConfig(); // ein anderer Tab kann weiter sein
  if (!sync.cfg || !state) return;
  if (sync.running) {
    sync.again = true;
    return sync.running;
  }
  clearTimeout(sync.timer);
  sync.running = (async () => {
    const snapshot = state;
    refreshSyncStatus('läuft');
    try {
      const r = await Y.syncOnce({ keys: sync.keys, local: snapshot, base: sync.cfg.base || null, mode });
      // Was während des Abgleichs hier eingetragen wurde, bleibt erhalten
      let next = r.state;
      if (state !== snapshot) next = normalized(L.mergeThreeWay(normalized(snapshot), normalized(state), r.state));
      sync.cfg = { ...sync.cfg, base: r.state, rev: r.rev, lastSyncAt: new Date().toISOString() };
      await S.saveSync(sync.cfg);
      const booked = L.bookDueContracts(next, today());
      next = booked.state;
      sync.error = null;
      sync.warned = null;
      if (!sameState(next, normalized(state))) {
        const pulled = !sameState(r.state, normalized(snapshot));
        await commit(next, { fromSync: true });
        if (pulled && mode === 'sync') toast('Vom anderen Gerät übernommen.', { duration: 2500 });
      }
      // Hier ist noch etwas Neues, das der Server nicht hat
      if (!sameState(next, r.state)) sync.again = true;
    } catch (err) {
      sync.error = err;
      if (mode !== 'sync') throw err;
      if (err.code !== 'offline') console.warn('Abgleich fehlgeschlagen', err);
      // Ernste Fehler einmal melden, nicht bei jedem Versuch
      if (['auth', 'decrypt', 'notfound', 'invalid', 'format'].includes(err.code) && sync.warned !== err.code) {
        sync.warned = err.code;
        toast('Abgleich gestört: ' + Y.errorText(err) + ' Details unter „Mehr“.', { error: true, duration: 10000 });
      }
    } finally {
      sync.running = null;
      refreshSyncStatus();
      if (sync.again) {
        sync.again = false;
        scheduleSync(300);
      }
    }
  })();
  return sync.running;
}

function syncStatusText(override) {
  if (override) return 'Abgleich läuft …';
  if (sync.error) return Y.errorText(sync.error);
  const last = sync.cfg?.lastSyncAt;
  if (!last) return 'Noch nicht abgeglichen.';
  const d = new Date(last);
  const sameDay = d.toDateString() === new Date().toDateString();
  return `Zuletzt abgeglichen: ${sameDay ? 'heute' : d.toLocaleDateString('de-DE')}, ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr`;
}
function refreshSyncStatus(override) {
  const el = document.getElementById('sync-status');
  if (el) {
    el.textContent = syncStatusText(override);
    el.classList.toggle('err', !override && !!sync.error && sync.error.code !== 'offline');
  }
}

// ---------------------------------------------------------------- Start

async function init() {
  const t = today();
  ui.lastToday = t;
  ui.month = L.monthKey(t);
  ui.year = L.yearOf(t);
  const hashTab = location.hash.slice(1);
  if (['uebersicht', 'buchungen', 'fixkosten', 'mehr'].includes(hashTab)) ui.tab = hashTab;

  let raw;
  try {
    raw = await S.loadState();
  } catch (err) {
    return fatal('Die gespeicherten Daten konnten nicht gelesen werden.', null, err);
  }
  if (raw) {
    const v = L.validateState(raw);
    if (!v.ok) return fatal(`Die gespeicherten Daten sind beschädigt: ${v.error}`, raw);
    state = v.state;
  } else {
    state = L.createInitialState();
  }
  await loadSyncConfig();
  const { added, changed } = runBooking();
  if (changed || !raw) await commit(state);
  else render();
  if (added) toast(`${added} fällige Fixkosten gebucht.`);

  try {
    ui.beforeImport = await S.loadBeforeImport();
  } catch {}
  ui.persisted = await S.isPersisted();
  runSync();

  const params = new URLSearchParams(location.search);
  if (params.has('neu')) {
    history.replaceState(null, '', location.pathname + location.hash);
    openEntrySheet();
  }
  registerServiceWorker();
}

function fatal(message, raw, err) {
  if (err) console.error(err);
  document.querySelector('.tabbar').hidden = true;
  view.innerHTML = `<div class="fatal card">
    <h1>Etwas stimmt nicht</h1>
    <p class="info">${esc(message)}</p>
    <p class="info">Es wurde nichts überschrieben. ${raw ? 'Speichere zuerst die Rohdaten und schick sie an jemanden, der helfen kann.' : 'Lade die Seite neu. Hilft das nicht, öffne „Mehr → Sicherung laden“ mit deiner letzten Sicherung.'}</p>
    ${raw ? '<p><button class="btn primary block" id="raw-dl">Rohdaten speichern</button></p>' : ''}
    <p><button class="btn block" id="fatal-reload">Neu laden</button></p>
  </div>`;
  $('#fatal-reload').addEventListener('click', () => location.reload());
  if (raw) $('#raw-dl').addEventListener('click', () => download(`finanzen-rohdaten-${today()}.json`, JSON.stringify(raw), 'application/json'));
}

// Neuer Tag, während die App offen war (z. B. über Nacht im Hintergrund)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state) return;
  runSync(); // Änderungen vom anderen Gerät holen
  const t = today();
  if (t === ui.lastToday) return;
  const oldMonth = L.monthKey(ui.lastToday);
  ui.lastToday = t;
  if (ui.month === oldMonth) ui.month = L.monthKey(t);
  if (ui.year === L.yearOf(oldMonth + '-01')) ui.year = L.yearOf(t);
  const { added, changed } = runBooking();
  if (changed) commit(state);
  else render();
  if (added) toast(`${added} fällige Fixkosten gebucht.`);
});

// Abgleich: wieder online, und jede Minute, solange die App sichtbar ist
window.addEventListener('online', () => runSync());
setInterval(() => {
  if (document.visibilityState === 'visible') runSync();
}, 60_000);

// Änderungen aus einem anderen Tab übernehmen
channel?.addEventListener('message', async (ev) => {
  if (ev.data !== 'changed') return;
  const raw = await S.loadState();
  const v = raw && L.validateState(raw);
  if (v && v.ok) {
    state = v.state;
    render();
  }
});

// ---------------------------------------------------------------- Rendern

function render() {
  if (!state) return;
  document.querySelectorAll('.tab').forEach((b) => {
    if (b.dataset.tab === ui.tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  const scrollY = window.scrollY;
  if (ui.tab === 'uebersicht') view.innerHTML = renderOverview();
  else if (ui.tab === 'buchungen') view.innerHTML = renderEntries();
  else if (ui.tab === 'fixkosten') view.innerHTML = renderContracts();
  else view.innerHTML = renderMore();
  window.scrollTo(0, scrollY);
}

function setTab(tab) {
  if (ui.tab === tab) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  ui.tab = tab;
  history.replaceState(null, '', '#' + tab);
  render();
  window.scrollTo(0, 0);
}

function periodSwitcher() {
  const t = today();
  const label = ui.mode === 'monat' ? L.formatMonthKey(ui.month) : String(ui.year);
  const isNow = ui.mode === 'monat' ? ui.month === L.monthKey(t) : ui.year === L.yearOf(t);
  return `<div class="period">
    <button class="icon-btn" data-action="period" data-dir="-1" aria-label="Zurück">${ICON.left}</button>
    <button class="period-label" data-action="period-now" ${isNow ? 'disabled' : ''} title="${isNow ? '' : 'Zum aktuellen Zeitraum'}">${esc(label)}${isNow ? '' : ' <span class="muted">· heute</span>'}</button>
    <button class="icon-btn" data-action="period" data-dir="1" aria-label="Weiter">${ICON.right}</button>
  </div>`;
}

function modeSwitch() {
  return `<div class="seg" role="group" aria-label="Zeitraum">
    <button data-action="mode" data-mode="monat" aria-pressed="${ui.mode === 'monat'}">Monat</button>
    <button data-action="mode" data-mode="jahr" aria-pressed="${ui.mode === 'jahr'}">Jahr</button>
  </div>`;
}

// ---------------------------------------------------------------- Übersicht

function renderOverview() {
  const t = today();
  const isMonth = ui.mode === 'monat';
  const match = isMonth ? ui.month : String(ui.year);
  const s = L.summarize(state, match);
  const periodName = isMonth ? L.MONTH_NAMES[+ui.month.slice(5) - 1] : String(ui.year);
  const rate = L.savingsRate(s);

  let html = `<div class="head"><h1>Übersicht</h1>${modeSwitch()}</div>${periodSwitcher()}<div class="grid">`;

  const banner = backupBanner();
  if (banner) html += `<div class="span2">${banner}</div>`;

  if (!state.entries.length && !state.contracts.length) {
    html += `<section class="card span2"><div class="empty">
      <div class="big">👋</div>
      <b>Los geht’s</b>
      Tipp unten auf <b style="display:inline">+</b>, um deine erste Ausgabe einzutragen.<br>
      Feste Kosten wie Versicherungen und Abos legst du einmal unter <a href="#fixkosten" data-action="tab" data-tab="fixkosten">Fixkosten</a> an, sie werden dann automatisch gebucht.
    </div></section>`;
    return html + '</div>';
  }

  // Hero
  html += `<section class="card hero span2">
    <div class="hero-label">Übrig ${isMonth ? 'im' : ''} ${esc(periodName)}</div>
    <div class="hero-value num ${s.rest < 0 ? 'neg' : s.rest > 0 ? 'pos' : ''}">${money(s.rest, { sign: true })}</div>
    <div class="hero-sub">${s.count === 0 ? 'Noch keine Buchungen in diesem Zeitraum.' : rate === null ? 'Noch keine Einnahmen eingetragen.' : `Sparquote ${rate} % <span class="muted">· Anteil der Einnahmen, der nicht ausgegeben wurde</span>`}</div>
    <div class="stats">
      <div class="stat"><div class="stat-label">Einnahmen</div><div class="stat-value num">${money(s.income, { round: true })}</div></div>
      <div class="stat"><div class="stat-label">Ausgaben</div><div class="stat-value num">${money(s.expense, { round: true })}</div>${s.fixed ? `<div class="stat-note num">fix ${money(s.fixed, { round: true })}</div>` : ''}</div>
      ${s.saving ? `<div class="stat"><div class="stat-label">Gespart</div><div class="stat-value num">${money(s.saving, { round: true })}</div></div>` : ''}
    </div>
  </section>`;

  if (!isMonth) html += renderYearChart();

  // Kategorien
  if (s.byCategory.length) {
    const max = s.byCategory[0].amount;
    const monthsCount = isMonth ? 0 : monthsInYearSoFar(ui.year);
    html += `<section class="card"><h2 class="card-title">Ausgaben nach Kategorie ${!isMonth && monthsCount > 1 ? `<small>Ø ${money(s.expense / monthsCount, { round: true })} pro Monat</small>` : ''}</h2><div class="bars">`;
    for (const b of s.byCategory) {
      const pct = s.expense ? Math.round((b.amount / s.expense) * 100) : 0;
      html += `<button class="bar-row" data-action="filter-cat" data-id="${esc(b.category.id)}" aria-label="${esc(b.category.name)}: ${money(b.amount)}, ${pct} Prozent. Buchungen anzeigen">
        <span class="emo" aria-hidden="true">${esc(b.category.emoji)}</span>
        <span class="name">${esc(b.category.name)}</span>
        <span class="amt num">${money(b.amount)}<small>${pct} %</small></span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max(1, (b.amount / max) * 100).toFixed(1)}%"></span></span>
      </button>`;
    }
    html += '</div></section>';
  }

  // Einnahmen nach Kategorie (nur wenn mehr als eine Quelle)
  if (s.incomeByCategory.length > 1) {
    html += `<section class="card"><h2 class="card-title">Einnahmen</h2><div class="list">`;
    for (const b of s.incomeByCategory) {
      html += `<button class="row" data-action="filter-cat" data-id="${esc(b.category.id)}"><span class="emo">${esc(b.category.emoji)}</span><span class="main"><span class="title">${esc(b.category.name)}</span></span><span class="right"><span class="amount num pos">${money(b.amount, { sign: true })}</span></span></button>`;
    }
    html += '</div></section>';
  }

  // Demnächst fällig
  const showUpcoming = isMonth ? ui.month === L.monthKey(t) : ui.year === L.yearOf(t);
  if (showUpcoming) {
    const up = L.upcomingPayments(state, t, 30);
    if (up.length) {
      const sumOut = up.filter((u) => u.contract.type === 'ausgabe').reduce((a, u) => a + u.contract.amount, 0);
      html += `<section class="card"><h2 class="card-title">Demnächst fällig <small>30 Tage${sumOut ? ` · ${money(sumOut)} Ausgaben` : ''}</small></h2><div class="list">`;
      for (const u of up.slice(0, 6)) html += upcomingRow(u, t);
      if (up.length > 6) html += `<button class="link-btn" data-action="tab" data-tab="fixkosten">${up.length - 6} weitere ansehen</button>`;
      html += '</div></section>';
    }
  }

  // Letzte Buchungen
  if (isMonth) {
    const list = L.entriesFor(state, { match: ui.month }).slice(0, 5);
    if (list.length) {
      html += `<section class="card"><h2 class="card-title">Letzte Buchungen <small><button class="link-btn" data-action="show-month-entries">Alle</button></small></h2><div class="list">`;
      for (const e of list) html += entryRow(e, true);
      html += '</div></section>';
    }
  }
  return html + '</div>';
}

function monthsInYearSoFar(year) {
  const t = today();
  const lastMonth = year < L.yearOf(t) ? 12 : year > L.yearOf(t) ? 0 : +t.slice(5, 7);
  // Erst ab dem ersten Monat mit Daten zählen (sonst verwässert der Start mitten im Jahr den Schnitt)
  let first = 13;
  for (const e of state.entries) if (e.date.startsWith(String(year))) first = Math.min(first, +e.date.slice(5, 7));
  if (first > lastMonth) return 0;
  return lastMonth - first + 1;
}

function renderYearChart() {
  const months = L.yearByMonth(state, ui.year);
  const t = today();
  const max = Math.max(1, ...months.map((m) => Math.max(m.expense, m.income)));
  const cols = months
    .map((m) => {
      const future = m.key > L.monthKey(t);
      const h = (m.expense / max) * 100;
      const inc = (m.income / max) * 100;
      const label = `${L.MONTH_NAMES[m.month - 1]}: Ausgaben ${L.formatMoney(m.expense)}, Einnahmen ${L.formatMoney(m.income)}`;
      return `<button class="chart-col ${future ? 'future' : ''}" data-action="goto-month" data-key="${m.key}" data-tip="${esc(label)}" aria-label="${esc(label)}. Monat öffnen">
        ${m.expense ? `<span class="chart-bar" style="height:${Math.max(1.5, h).toFixed(1)}%"></span>` : ''}
        ${m.income ? `<span class="chart-inc" style="bottom:${inc.toFixed(1)}%"></span>` : ''}
      </button>`;
    })
    .join('');
  const labels = months.map((m) => `<span class="${m.key === L.monthKey(t) ? 'now' : ''}">${L.MONTH_SHORT[m.month - 1]}</span>`).join('');
  return `<section class="card span2"><h2 class="card-title">Monate ${ui.year} <small>Tippen öffnet den Monat</small></h2>
    <div class="chart"><div class="chart-cols">${cols}</div><div class="chart-labels" aria-hidden="true">${labels}</div></div>
    <div class="legend"><span><i class="sw-bar"></i>Ausgaben</span><span><i class="sw-line"></i>Einnahmen</span></div>
  </section>`;
}

function upcomingRow(u, t) {
  const c = u.contract;
  const days = L.daysBetween(t, u.date);
  const when = days === 1 ? 'morgen' : `in ${days} Tagen`;
  return `<button class="row" data-action="edit-contract" data-id="${esc(c.id)}">
    <span class="emo">${esc(contractEmoji(c))}</span>
    <span class="main"><span class="title">${esc(c.name)}</span><span class="sub">${esc(L.formatDate(u.date))} · ${when}</span></span>
    <span class="right"><span class="amount num ${c.type === 'einnahme' ? 'pos' : ''}">${c.type === 'einnahme' ? money(c.amount, { sign: true }) : money(c.amount)}</span><span class="amount-sub">${esc(L.INTERVALS[c.interval].label)}</span></span>
  </button>`;
}

/** Betrag einer Buchung, beim Kategorie-Filter nur der Teil dieser Kategorie (Topf-Buchungen). */
function amountIn(e, catId) {
  if (!catId) return e.amount;
  return L.entryPieces(e).reduce((a, p) => a + (p.categoryId === catId ? p.amount : 0), 0);
}

function entryRow(e, showDate = false, focusCat = null) {
  const k = catOrFallback(e.categoryId, e.type);
  const isSplit = !!(e.split && e.split.length);
  let title = e.note || k.name;
  let emoji = k.emoji;
  const amount = amountIn(e, focusCat);
  const subParts = [];
  if (showDate) subParts.push(L.formatDayLabel(e.date, today()));
  if (isSplit && focusCat) {
    // Gefiltert nach Kategorie: nur die passenden Posten des Topfs zeigen
    emoji = catOrFallback(focusCat, e.type).emoji;
    title = e.split.filter((p) => p.categoryId === focusCat).map((p) => p.name).join(', ');
    subParts.push(`aus ${e.note || 'Topf'}`);
  } else if (isSplit) {
    emoji = POT_EMOJI;
    subParts.push(e.split.map((p) => p.name).join(', '));
  } else if (e.note) subParts.push(k.name);
  const isIncome = e.type === 'einnahme';
  return `<button class="row" data-action="edit-entry" data-id="${esc(e.id)}">
    <span class="emo">${esc(emoji)}</span>
    <span class="main"><span class="title">${esc(title)}${e.contractId ? '<span class="auto-mark" title="Automatisch gebuchte Fixkosten">↻ fix</span>' : ''}</span>${subParts.length ? `<span class="sub">${esc(subParts.join(' · '))}</span>` : ''}</span>
    <span class="right"><span class="amount num ${isIncome ? 'pos' : ''}">${isIncome ? money(amount, { sign: true }) : money(-amount)}</span></span>
  </button>`;
}

function backupBanner() {
  const hasData = state.entries.length > 0 || state.contracts.length > 0;
  if (!hasData) return '';
  const last = state.settings.lastBackupAt;
  const ref = last || state.settings.createdAt;
  const days = Math.floor((Date.now() - new Date(ref).getTime()) / 86400000);
  if (last ? days < 30 : days < 7) return '';
  return `<div class="banner" role="status">
    <span style="font-size:22px" aria-hidden="true">💾</span>
    <span class="grow"><b>Zeit für eine Sicherung</b>${last ? `Letzte Sicherung vor ${days} Tagen.` : 'Du hast noch keine Sicherung gespeichert.'} Deine Daten liegen nur auf diesem Handy.</span>
    <button class="btn primary small" data-action="backup">Sichern</button>
  </div>`;
}

// ---------------------------------------------------------------- Buchungen

function renderEntries() {
  return `<div class="head"><h1>Buchungen</h1>${modeSwitch()}</div>
    <label class="search">${ICON.search}<span class="sr">Suchen</span><input id="search" type="search" placeholder="Suchen in allen Monaten" value="${esc(ui.query)}" autocomplete="off" enterkeyhint="search"></label>
    <div id="entries-results">${renderEntryResults()}</div>`;
}

// Nur dieser Teil wird beim Tippen in der Suche neu gezeichnet (das Suchfeld bleibt stehen).
function renderEntryResults() {
  if (ui.catFilter && !cat(ui.catFilter)) ui.catFilter = null;
  const searching = ui.query.trim().length > 0;
  const filterCat = ui.catFilter ? cat(ui.catFilter) : null;
  const match = searching ? null : ui.mode === 'monat' ? ui.month : String(ui.year);
  const list = L.entriesFor(state, { match, categoryId: ui.catFilter, query: ui.query });

  let html = '';
  if (filterCat) {
    html += `<button class="chip filter" data-action="clear-filter" aria-label="Filter ${esc(filterCat.name)} entfernen"><span>${esc(filterCat.emoji)} ${esc(filterCat.name)}</span> ✕</button>`;
  }
  if (!searching) html += periodSwitcher();

  const out = list.filter((e) => e.type === 'ausgabe').reduce((a, e) => a + amountIn(e, ui.catFilter), 0);
  const inc = list.filter((e) => e.type === 'einnahme').reduce((a, e) => a + amountIn(e, ui.catFilter), 0);
  if (list.length) {
    html += `<div class="summary-line"><span>${list.length} ${list.length === 1 ? 'Buchung' : 'Buchungen'}</span><span class="num">${inc ? `<span class="pos">${money(inc, { sign: true })}</span> · ` : ''}${money(-out)}</span></div>`;
  }

  html += '<section class="card">';
  if (!list.length) {
    html += `<div class="empty"><div class="big">${searching ? '🔍' : '🧾'}</div><b>${searching ? 'Nichts gefunden' : 'Keine Buchungen'}</b>${searching ? 'Probier ein anderes Stichwort.' : 'In diesem Zeitraum ist noch nichts eingetragen.'}</div>`;
  } else {
    const LIMIT = 300;
    let day = null;
    let dayHtml = '';
    let daySum = 0;
    const flush = () => {
      if (day) html += `<div class="day"><div class="day-head"><span>${esc(L.formatDayLabel(day, today()))}</span><span class="num">${daySum ? money(-daySum) : ''}</span></div><div class="list">${dayHtml}</div></div>`;
    };
    for (const e of list.slice(0, LIMIT)) {
      if (e.date !== day) {
        flush();
        day = e.date;
        dayHtml = '';
        daySum = 0;
      }
      dayHtml += entryRow(e, false, ui.catFilter);
      if (e.type === 'ausgabe') daySum += amountIn(e, ui.catFilter);
    }
    flush();
    if (list.length > LIMIT) html += `<p class="hint">Die ersten ${LIMIT} von ${list.length} Treffern. Grenz die Suche weiter ein.</p>`;
  }
  return html + '</section>';
}

// ---------------------------------------------------------------- Fixkosten

function renderContracts() {
  const t = today();
  const totals = L.contractTotals(state, t);
  let html = `<div class="head"><h1>Fixkosten</h1><button class="btn primary small" data-action="new-contract">${ICON.plus.replace('<svg', '<svg width="18" height="18" style="fill:none;stroke:currentColor;stroke-width:2.6;stroke-linecap:round"')} Neu</button></div><div class="grid">`;

  if (!state.contracts.length) {
    html += `<section class="card span2"><div class="empty"><div class="big">🔁</div><b>Noch keine Fixkosten</b>
      Leg hier Versicherungen, Abos, Miete und dein Gehalt an. Sie werden zum Fälligkeitstag automatisch gebucht, und du siehst, was dich jeder Vertrag im Monat und im Jahr kostet.
      <p><button class="btn primary" data-action="new-contract">Ersten Vertrag anlegen</button></p></div></section>`;
    return html + '</div>';
  }

  html += `<section class="card hero span2">
    <div class="hero-label">Fixkosten pro Monat</div>
    <div class="hero-value num">${money(totals.expenseMonth)}</div>
    <div class="hero-sub num">${money(totals.expenseYear)} pro Jahr</div>
    <div class="stats">
      ${totals.incomeMonth ? `<div class="stat"><div class="stat-label">Feste Einnahmen</div><div class="stat-value num">${money(totals.incomeMonth, { round: true })}</div><div class="stat-note">pro Monat</div></div>` : ''}
      ${totals.incomeMonth ? `<div class="stat"><div class="stat-label">Bleibt nach Fixkosten</div><div class="stat-value num ${totals.incomeMonth - totals.expenseMonth < 0 ? 'neg' : ''}">${money(totals.incomeMonth - totals.expenseMonth, { round: true })}</div><div class="stat-note">pro Monat</div></div>` : ''}
      ${totals.reserveMonth ? `<div class="stat"><div class="stat-label">Zurücklegen</div><div class="stat-value num">${money(totals.reserveMonth, { round: true })}</div><div class="stat-note">pro Monat für Jahres- und Quartalszahlungen</div></div>` : ''}
    </div>
  </section>`;

  const pots = L.runningPots(state, t);
  if (pots.length) {
    const potSum = pots.reduce((a, c) => a + L.contractPerMonth(c), 0);
    html += `<section class="card span2"><h2 class="card-title"><span>${POT_EMOJI} Töpfe</span><small class="num">${money(potSum)}/Monat · ${money(potSum * 12, { round: true })}/Jahr</small></h2><div class="list">`;
    for (const c of pots) html += contractRow(c, t) + potPartsHtml(c);
    html += '</div></section>';
  }

  const groups = L.contractGroups(state, t, 'ausgabe');
  for (const g of groups) {
    html += `<section class="card"><h2 class="card-title"><span>${esc(g.category?.emoji || '')} ${esc(g.category?.name || 'Ohne Kategorie')}</span><small class="num">${money(g.perMonth)}/Monat · ${money(g.perYear, { round: true })}/Jahr</small></h2><div class="list">`;
    for (const c of g.contracts) html += contractRow(c, t);
    html += '</div></section>';
  }
  const incomeGroups = L.contractGroups(state, t, 'einnahme');
  if (incomeGroups.length) {
    html += `<section class="card"><h2 class="card-title"><span>💶 Feste Einnahmen</span><small class="num">${money(totals.incomeMonth)}/Monat</small></h2><div class="list">`;
    for (const g of incomeGroups) for (const c of g.contracts) html += contractRow(c, t);
    html += '</div></section>';
  }
  const stopped = state.contracts.filter((c) => !L.isContractRunning(c, t));
  if (stopped.length) {
    html += `<section class="card span2"><details class="more"><summary>Pausiert oder beendet (${stopped.length})</summary><div class="list">`;
    for (const c of stopped.sort((a, b) => a.name.localeCompare(b.name, 'de'))) html += contractRow(c, t, true);
    html += '</div></details></section>';
  }
  return html + '</div>';
}

/** Posten eines Topfs als kleine Liste unter der Topf-Zeile. */
function potPartsHtml(c) {
  const perLabel = c.interval === 'monatlich' ? '' : ' je Zahlung';
  const rows = [...c.parts]
    .sort((a, b) => L.partShare(b, c.interval) - L.partShare(a, c.interval))
    .map((p) => {
      const k = catOrFallback(p.categoryId, c.type);
      return `<div class="pot-part"><span><span aria-hidden="true">${esc(k.emoji)}</span> ${esc(p.name)}</span><span class="num">${p.per === 'jahr' ? `${money(p.amount)}/Jahr` : `${money(p.amount)}${perLabel}`}</span></div>`;
    })
    .join('');
  const total = Math.round(L.partsTotal(c.parts, c.interval));
  const diff = total !== c.amount ? `<div class="pot-part pot-note"><span>Posten ergeben ${money(total)}, überwiesen werden ${money(c.amount)}. Verteilt wird anteilig.</span></div>` : '';
  return `<div class="pot-parts">${rows}${diff}</div>`;
}

function contractRow(c, t, dim = false) {
  const next = L.nextOccurrence(c, t);
  const iv = L.INTERVALS[c.interval];
  let sub = `${L.formatMoney(c.amount)} ${iv.label}${L.isPot(c) ? ` · Topf mit ${c.parts.length} Posten` : ''}`;
  let sub2 = '';
  if (dim) sub = !c.active ? `pausiert · ${sub}` : `beendet ${L.formatDate(c.end)}`;
  else if (next) sub2 = `nächste ${L.formatDate(next)}${c.end ? ` · endet ${L.formatDate(c.end)}` : ''}`;
  else if (c.end) sub2 = `endet ${L.formatDate(c.end)}`;
  const perMonth = L.contractPerMonth(c);
  return `<button class="row ${dim ? 'dim' : ''}" data-action="edit-contract" data-id="${esc(c.id)}">
    <span class="emo">${esc(contractEmoji(c))}</span>
    <span class="main"><span class="title">${esc(c.name)}</span><span class="sub">${esc(sub)}</span>${sub2 ? `<span class="sub">${esc(sub2)}</span>` : ''}</span>
    <span class="right"><span class="amount num ${c.type === 'einnahme' ? 'pos' : ''}">${money(perMonth)}</span><span class="amount-sub">pro Monat</span></span>
  </button>`;
}

// ---------------------------------------------------------------- Mehr

function renderMore() {
  const last = state.settings.lastBackupAt;
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [new File(['{}'], 'test.json', { type: 'application/json' })] }));
  const cats = (type) =>
    state.categories
      .filter((c) => c.type === type)
      .map(
        (c) => `<button class="row" data-action="edit-category" data-id="${esc(c.id)}"><span class="emo">${esc(c.emoji)}</span><span class="main"><span class="title">${esc(c.name)}</span><span class="sub">${usageText(c.id)}</span></span><span class="chev muted">›</span></button>`,
      )
      .join('');
  const before = ui.beforeImport;
  const synced = !!sync.cfg;
  return `<div class="head"><h1>Mehr</h1></div><div class="grid">
    ${renderSyncCard()}
    <section class="card">
      <h2 class="card-title">Sicherung</h2>
      <p class="info">${
        synced
          ? 'Deine Daten liegen auf deinen verbundenen Geräten und verschlüsselt auf deinem Server. Eine Sicherungsdatei auf dem NAS schützt zusätzlich, etwa wenn du den Sync-Schlüssel verlierst.'
          : 'Deine Daten liegen <b>nur auf diesem Gerät</b>. Speichere regelmäßig eine Sicherungsdatei und leg sie aufs NAS. Geht das Handy verloren, ist das die einzige Kopie.'
      }</p>
      <p class="info">${last ? `Letzte Sicherung: ${esc(new Date(last).toLocaleDateString('de-DE'))}` : 'Noch keine Sicherung gespeichert.'}</p>
      <div class="btn-col" style="display:grid;gap:8px;margin-top:14px">
        <button class="btn primary" data-action="backup">Sicherung speichern</button>
        ${canShare ? '<button class="btn" data-action="backup-share">Sicherung teilen …</button>' : ''}
        <button class="btn" data-action="import">Sicherung laden</button>
        <button class="btn" data-action="csv">Als Tabelle exportieren (Excel)</button>
        ${before ? `<button class="btn" data-action="undo-import">Letzten Import rückgängig machen</button><p class="hint">Stand vor dem Import vom ${esc(new Date(before.savedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }))}</p>` : ''}
      </div>
    </section>
    <section class="card">
      <h2 class="card-title">Kategorien <small><button class="link-btn" data-action="new-category">+ Neue</button></small></h2>
      <div class="field-label">Ausgaben</div><div class="list">${cats('ausgabe')}</div>
      <div class="field-label" style="margin-top:14px">Einnahmen</div><div class="list">${cats('einnahme')}</div>
    </section>
    <section class="card">
      <h2 class="card-title">Datenschutz</h2>
      <p class="info">${
        synced
          ? 'Ins Internet geht nur der Abgleich, und zwar verschlüsselt an deinen eigenen Server. Der Schlüssel bleibt auf deinen Geräten, der Server kann nichts lesen. Kein Konto, keine Statistik, keine fremden Dienste.'
          : 'Die App sendet nichts ins Internet. Es gibt kein Konto und keine Statistik. Technisch ist ihr nur erlaubt, mit ihrer eigenen Adresse zu sprechen.'
      }</p>
      <p class="info">Gespeichert in: ${esc(S.storageKind())} · ${ui.persisted === true ? 'vor automatischem Löschen geschützt ✓' : ui.persisted === false ? 'nicht dauerhaft geschützt, deshalb Sicherungen besonders wichtig' : 'Schutzstatus unbekannt'}</p>
      <p class="info">${nB(state.entries.length)} · ${state.contracts.length} Fixkosten</p>
    </section>
    <section class="card">
      <h2 class="card-title">Gefahrenzone</h2>
      <p class="info">Löscht alle Buchungen, Fixkosten und Kategorien auf diesem Gerät${synced ? ' <b>und auf allen verbundenen Geräten</b>' : ''}. Ein Rückgängig-Punkt bleibt bis zum nächsten Import erhalten.</p>
      <p style="margin:14px 0 0"><button class="btn danger block" data-action="wipe">Alle Daten löschen</button></p>
    </section>
  </div>
  <p class="version">Finanzen ${APP_VERSION}</p>`;
}

function renderSyncCard() {
  if (!SYNC_AVAILABLE) {
    return `<section class="card">
      <h2 class="card-title">Handy und Laptop abgleichen</h2>
      <p class="info">Der Abgleich zwischen Geräten läuft unter der eigenen Adresse <a href="https://${SYNC_HOST}/">${SYNC_HOST}</a>. Umziehen: hier „Sicherung speichern“, dort „Sicherung laden“.</p>
    </section>`;
  }
  if (!sync.cfg) {
    return `<section class="card">
      <h2 class="card-title">Handy und Laptop abgleichen</h2>
      <p class="info">Gleicht deine Daten verschlüsselt über deinen Server ab. Auf dem ersten Gerät einrichten, auf jedem weiteren mit dem Sync-Schlüssel verbinden.</p>
      <div style="display:grid;gap:8px;margin-top:14px">
        <button class="btn primary" data-action="sync-create">Einrichten (erstes Gerät)</button>
        <button class="btn" data-action="sync-join">Mit Sync-Schlüssel verbinden</button>
      </div>
    </section>`;
  }
  const err = sync.error && sync.error.code !== 'offline';
  return `<section class="card">
    <h2 class="card-title">Handy und Laptop abgleichen</h2>
    <p class="info${err ? ' err' : ''}" id="sync-status">${esc(syncStatusText(sync.running ? 'läuft' : null))}</p>
    ${
      sync.showKey
        ? `<div class="note-box" style="margin-top:10px"><div class="field-label">Dein Sync-Schlüssel</div>
            <div style="font:600 17px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.02em;word-break:break-all;user-select:all;margin:4px 0 8px">${esc(sync.cfg.key)}</div>
            <div class="hint">Damit verbindest du weitere Geräte. Leg ihn in deinen Passwortmanager. Wer ihn hat, kann deine Finanzdaten lesen.</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button class="btn" data-action="sync-copy">Kopieren</button><button class="btn" data-action="sync-hide">Ausblenden</button></div></div>`
        : ''
    }
    <div style="display:grid;gap:8px;margin-top:14px">
      <button class="btn primary" data-action="sync-now">Jetzt abgleichen</button>
      ${sync.showKey ? '' : '<button class="btn" data-action="sync-show">Sync-Schlüssel anzeigen</button>'}
      <button class="btn" data-action="sync-off">Abgleich auf diesem Gerät beenden</button>
    </div>
  </section>`;
}

function openSyncJoinSheet() {
  draft = { kind: 'sync' };
  sheet.innerHTML = `
    <div class="sheet-head"><h2 id="sheet-title">Mit Sync-Schlüssel verbinden</h2><button class="icon-btn flat" data-action="close-sheet" aria-label="Schließen">${ICON.close}</button></div>
    <form class="sheet-body" novalidate>
      <div class="field"><label for="sync-key">Sync-Schlüssel</label>
        <input id="sync-key" class="input" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH-…" style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">
        <div class="hint">Steht auf dem ersten Gerät unter „Mehr → Sync-Schlüssel anzeigen“. Groß- und Kleinschreibung und Bindestriche sind egal.</div>
        <div class="hint err" id="sync-key-err" hidden></div>
      </div>
      ${state.entries.length || state.contracts.length ? `<div class="note-box">Auf diesem Gerät sind schon ${nB(state.entries.length)}. Sie bleiben erhalten und kommen zu den Daten des anderen Geräts dazu.</div>` : ''}
    </form>
    <div class="sheet-foot"><button class="btn primary" data-action="save-sync-join">Verbinden</button></div>`;
  showSheet('#sync-key');
}

async function syncJoin() {
  const input = $('#sync-key', sheet);
  const errEl = $('#sync-key-err', sheet);
  const btn = $('[data-action="save-sync-join"]', sheet);
  const key = Y.parseKey(input.value);
  const fail = (msg) => {
    input.classList.add('invalid');
    errEl.textContent = msg;
    errEl.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Verbinden';
  };
  if (!key) return fail('Das ist kein gültiger Schlüssel. Er hat 32 Zeichen (A–Z und 2–7).');
  btn.disabled = true;
  btn.textContent = 'Verbinde …';
  const formatted = Y.formatKey(key);
  sync.keys = await Y.deriveKeys(formatted);
  sync.cfg = { key: formatted, base: null, rev: 0, lastSyncAt: null };
  try {
    await runSync('join');
  } catch (err) {
    sync.cfg = null;
    sync.keys = null;
    sync.error = null;
    return fail(Y.errorText(err));
  }
  closeSheet();
  toast(`Verbunden. ${nB(state.entries.length)} auf diesem Gerät.`, { duration: 6000 });
  render();
}

async function syncCreate() {
  const go = await confirmDialog({
    title: 'Abgleich einrichten?',
    text: 'Deine Daten werden auf diesem Gerät verschlüsselt und auf deinem Server abgelegt. Du bekommst einen Sync-Schlüssel, mit dem du den Laptop verbindest. Ohne diesen Schlüssel kann niemand die Daten lesen, auch der Server nicht.',
    ok: 'Einrichten',
  });
  if (!go) return;
  const key = Y.generateKey();
  sync.keys = await Y.deriveKeys(key);
  sync.cfg = { key, base: null, rev: 0, lastSyncAt: null };
  try {
    await runSync('create');
  } catch (err) {
    sync.cfg = null;
    sync.keys = null;
    sync.error = null;
    render();
    return toast('Einrichten fehlgeschlagen: ' + Y.errorText(err), { error: true, duration: 8000 });
  }
  sync.showKey = true;
  render();
  toast('Abgleich eingerichtet. Jetzt den Schlüssel am Laptop eingeben.', { duration: 7000 });
}

async function syncOff() {
  const go = await confirmDialog({
    title: 'Abgleich hier beenden?',
    text: 'Dieses Gerät gleicht dann nicht mehr ab. Die Daten auf diesem Gerät, den anderen Geräten und dem Server bleiben, wie sie sind. Mit dem Sync-Schlüssel kannst du dich jederzeit wieder verbinden.',
    ok: 'Beenden',
  });
  if (!go) return;
  clearTimeout(sync.timer);
  if (sync.running) await sync.running.catch(() => {});
  await S.clearSync();
  sync.cfg = null;
  sync.keys = null;
  sync.error = null;
  sync.showKey = false;
  render();
  toast('Abgleich auf diesem Gerät beendet.');
}

async function syncCopy() {
  try {
    await navigator.clipboard.writeText(sync.cfg.key);
    toast('Schlüssel kopiert.');
  } catch {
    toast('Kopieren ging nicht. Markier den Schlüssel und kopier ihn von Hand.', { error: true });
  }
}

function usageText(id) {
  const n = state.entries.filter(usesCat(id)).length;
  const c = state.contracts.filter(usesCat(id)).length;
  const parts = [];
  if (n) parts.push(`${n} ${n === 1 ? 'Buchung' : 'Buchungen'}`);
  if (c) parts.push(`${c} Fixkosten`);
  return esc(parts.join(' · ') || 'nicht benutzt');
}

// ---------------------------------------------------------------- Eintragen (Sheet)

let draft = null;

function openEntrySheet(entry = null, preset = {}) {
  const t = today();
  draft = entry
    ? { kind: 'entry', id: entry.id, type: entry.type, amountText: L.centsToInput(entry.amount), categoryId: entry.categoryId, note: entry.note || '', date: entry.date, categoryTouched: true, contractId: entry.contractId || null, split: entry.split || null }
    : { kind: 'entry', id: null, type: preset.type || 'ausgabe', amountText: '', categoryId: null, note: '', date: t, categoryTouched: false, contractId: null, split: null };

  const contract = draft.contractId ? state.contracts.find((c) => c.id === draft.contractId) : null;
  sheet.innerHTML = `
    <div class="sheet-head"><h2 id="sheet-title">${entry ? 'Buchung bearbeiten' : 'Neu eintragen'}</h2><button class="icon-btn flat" data-action="close-sheet" aria-label="Schließen">${ICON.close}</button></div>
    <form class="sheet-body" id="entry-form" novalidate>
      ${draft.split ? '' : `<div class="field"><div class="seg wide" role="group" aria-label="Art">
        <button type="button" data-action="entry-type" data-type="ausgabe" aria-pressed="${draft.type === 'ausgabe'}">Ausgabe</button>
        <button type="button" data-action="entry-type" data-type="einnahme" aria-pressed="${draft.type === 'einnahme'}">Einnahme</button>
      </div></div>`}
      <div class="field"><label for="amount">${draft.split ? 'Überweisung in den Topf' : 'Betrag'}</label>
        <div class="amount-wrap"><input id="amount" class="input amount-input" inputmode="decimal" autocomplete="off" enterkeyhint="done" placeholder="0,00" value="${esc(draft.amountText)}"><span class="cur">€</span></div>
        <div class="hint err" id="amount-err" hidden>Bitte einen gültigen Betrag eingeben, z. B. 12,50</div>
      </div>
      <div class="field" id="sug-field"></div>
      ${draft.split
        ? '<div class="field"><div class="field-label">Aufteilung</div><div class="pot-parts in-sheet" id="split-box"></div><div class="hint">Ändert sich der Betrag, wird anteilig neu verteilt.</div></div>'
        : '<div class="field"><div class="field-label">Kategorie</div><div class="cat-grid" id="cat-grid"></div><div class="hint err" id="cat-err" hidden>Bitte eine Kategorie antippen.</div></div>'}
      <div class="field"><label for="note">Notiz <span class="muted">(optional)</span></label><input id="note" class="input" maxlength="120" autocomplete="off" enterkeyhint="done" placeholder="z. B. REWE, Tanken, Kino" value="${esc(draft.note)}"></div>
      <div class="field"><div class="field-label">Datum</div><div class="date-row">
        <div class="seg" role="group" aria-label="Schnellwahl Datum">
          <button type="button" data-action="entry-date" data-days="0" aria-pressed="false">Heute</button>
          <button type="button" data-action="entry-date" data-days="-1" aria-pressed="false">Gestern</button>
        </div>
        <input id="date" class="input" type="date" value="${esc(draft.date)}" aria-label="Datum wählen">
      </div></div>
      ${contract ? `<div class="note-box">↻ Automatisch gebucht aus den Fixkosten „${esc(contract.name)}“. Änderungen hier betreffen nur diese eine Buchung.</div>` : draft.contractId ? '<div class="note-box">↻ Automatisch gebucht aus Fixkosten, die inzwischen gelöscht sind.</div>' : ''}
      ${!entry ? '<div class="field"><button type="button" class="link-btn" data-action="entry-to-contract">↻ Kommt regelmäßig? Als Fixkosten anlegen</button></div>' : ''}
    </form>
    <div class="sheet-foot">
      ${entry ? '<button class="btn danger" data-action="delete-entry">Löschen</button>' : ''}
      <button class="btn primary" data-action="save-entry">Speichern</button>
    </div>`;
  renderEntryParts();
  syncDateChips();
  showSheet(!entry ? '#amount' : null);
}

function renderSplitBox() {
  const box = $('#split-box', sheet);
  if (!box) return;
  const amount = L.parseAmount($('#amount', sheet)?.value ?? draft.amountText);
  const split = amount ? L.rescaleSplit(draft.split, amount) : draft.split;
  box.innerHTML = split
    .map((p) => {
      const k = catOrFallback(p.categoryId, draft.type);
      return `<div class="pot-part"><span><span aria-hidden="true">${esc(k.emoji)}</span> ${esc(p.name)} <span class="muted">· ${esc(k.name)}</span></span><span class="num">${money(p.amount)}</span></div>`;
    })
    .join('');
}

function renderEntryParts() {
  if (draft.split) {
    renderSplitBox();
    $('#sug-field', sheet).hidden = true;
    draft.suggestions = [];
    return;
  }
  const cats = state.categories.filter((c) => c.type === draft.type);
  $('#cat-grid', sheet).innerHTML = cats
    .map((c) => `<button type="button" class="cat" data-action="entry-cat" data-id="${esc(c.id)}" aria-pressed="${draft.categoryId === c.id}"><span class="e" aria-hidden="true">${esc(c.emoji)}</span><span>${esc(c.name)}</span></button>`)
    .join('');
  const sug = draft.id ? [] : L.noteSuggestions(state, draft.type, 8);
  $('#sug-field', sheet).innerHTML = sug.length
    ? `<div class="field-label">Schnellwahl</div><div class="chips">${sug
        .map((s, i) => {
          const k = cat(s.categoryId);
          return `<button type="button" class="chip" data-action="entry-sug" data-i="${i}"><span>${esc(k?.emoji || '')} ${esc(s.note)}</span></button>`;
        })
        .join('')}</div>`
    : '';
  $('#sug-field', sheet).hidden = !sug.length;
  draft.suggestions = sug;
}

function syncDateChips() {
  const t = today();
  sheet.querySelectorAll('[data-action="entry-date"]').forEach((b) => {
    b.setAttribute('aria-pressed', String(L.addDays(t, +b.dataset.days) === draft.date));
  });
}

function selectEntryCat(id) {
  draft.categoryId = id;
  sheet.querySelectorAll('.cat').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === id)));
  $('#cat-err', sheet).hidden = true;
}

function readEntryForm() {
  draft.amountText = $('#amount', sheet).value;
  draft.note = $('#note', sheet).value.trim();
  const d = $('#date', sheet).value;
  if (d) draft.date = d;
}

function saveEntry() {
  readEntryForm();
  const amount = L.parseAmount(draft.amountText);
  const amountInput = $('#amount', sheet);
  let ok = true;
  if (amount === null) {
    amountInput.classList.add('invalid');
    $('#amount-err', sheet).hidden = false;
    ok = false;
  }
  if (!draft.split && (!draft.categoryId || !cat(draft.categoryId) || cat(draft.categoryId).type !== draft.type)) {
    $('#cat-err', sheet).hidden = false;
    ok = false;
  }
  if (!L.isValidISO(draft.date)) {
    $('#date', sheet).classList.add('invalid');
    ok = false;
  }
  if (!ok) {
    revealFirstError();
    return;
  }
  const prev = state;
  const nowIso = new Date().toISOString();
  let entries;
  let msg;
  if (draft.id) {
    entries = state.entries.map((e) => {
      if (e.id !== draft.id) return e;
      // Topf-Buchung: Art und Aufteilung bleiben, der Betrag wird anteilig neu verteilt
      if (e.split && e.split.length) return { ...e, amount, note: draft.note, date: draft.date, split: L.rescaleSplit(e.split, amount) };
      return { ...e, type: draft.type, amount, categoryId: draft.categoryId, note: draft.note, date: draft.date };
    });
    msg = 'Änderung gespeichert';
  } else {
    entries = [...state.entries, { id: L.newId(), type: draft.type, amount, date: draft.date, categoryId: draft.categoryId, note: draft.note, createdAt: nowIso }];
    const k = cat(draft.categoryId);
    msg = `${L.formatMoney(amount)} · ${k.emoji} ${k.name}`;
  }
  // Ansicht auf den Monat der Buchung stellen, damit man sie sieht
  if (!draft.id && ui.tab === 'uebersicht' && ui.mode === 'monat') ui.month = L.monthKey(draft.date);
  closeSheet();
  commit({ ...state, entries });
  toast(msg, { undo: () => commit(prev) });
}

function deleteEntry() {
  const prev = state;
  const id = draft.id;
  closeSheet();
  commit({ ...state, entries: state.entries.filter((e) => e.id !== id) });
  toast('Buchung gelöscht', { undo: () => commit(prev) });
}

// ---------------------------------------------------------------- Fixkosten (Sheet)

const INTERVAL_BUTTON = { monatlich: 'Monatlich', vierteljaehrlich: 'Quartal', halbjaehrlich: 'Halbjahr', jaehrlich: 'Jährlich' };

function openContractSheet(contract = null, preset = {}) {
  const t = today();
  draft = contract
    ? { kind: 'contract', id: contract.id, type: contract.type, amountText: L.centsToInput(contract.amount), name: contract.name, interval: contract.interval, anchor: contract.anchor, end: contract.end || '', categoryId: contract.categoryId, active: contract.active, note: contract.note || '' }
    : { kind: 'contract', id: null, type: preset.type || 'ausgabe', amountText: preset.amountText || '', name: preset.name || '', interval: 'monatlich', anchor: preset.anchor || t, end: '', categoryId: preset.categoryId || null, active: true, note: '' };
  draft.pot = !!contract && L.isPot(contract);
  draft.parts = draft.pot ? contract.parts.map((p) => ({ id: p.id, name: p.name, amountText: L.centsToInput(p.amount), per: p.per, categoryId: p.categoryId })) : [];
  // Betrag folgt der Summe der Posten, bis man ihn selbst ändert
  draft.amountTouched = draft.pot && Math.round(L.partsTotal(contract.parts, contract.interval)) !== contract.amount;
  const iv = Object.entries(L.INTERVALS);
  sheet.innerHTML = `
    <div class="sheet-head"><h2 id="sheet-title">${contract ? 'Fixkosten bearbeiten' : 'Neue Fixkosten'}</h2><button class="icon-btn flat" data-action="close-sheet" aria-label="Schließen">${ICON.close}</button></div>
    <form class="sheet-body" id="contract-form" novalidate>
      <div class="field"><div class="seg wide" role="group" aria-label="Art">
        <button type="button" data-action="contract-type" data-type="ausgabe" aria-pressed="${draft.type === 'ausgabe'}">Ausgabe</button>
        <button type="button" data-action="contract-type" data-type="einnahme" aria-pressed="${draft.type === 'einnahme'}">Einnahme</button>
      </div></div>
      <div class="field"><label for="c-name">Name</label><input id="c-name" class="input" maxlength="60" autocomplete="off" placeholder="z. B. Haftpflicht, Netflix, Gehalt" value="${esc(draft.name)}"><div class="hint err" id="name-err" hidden>Bitte einen Namen eingeben.</div></div>
      <div class="field toggle-row" id="pot-toggle"><span><b>Topf mit Posten</b><br><span class="hint" style="margin:0">Überwiesen wird ein Betrag, die Übersicht verteilt ihn auf die Kategorien der Posten</span></span><label class="switch"><input type="checkbox" id="c-pot" ${draft.pot ? 'checked' : ''} aria-label="Topf mit Posten"><span></span></label></div>
      <div class="field"><label for="amount" id="amount-label">Betrag pro Zahlung</label>
        <div class="amount-wrap"><input id="amount" class="input amount-input" inputmode="decimal" autocomplete="off" enterkeyhint="done" placeholder="0,00" value="${esc(draft.amountText)}"><span class="cur">€</span></div>
        <div class="hint err" id="amount-err" hidden>Bitte einen gültigen Betrag eingeben, z. B. 89,90</div>
      </div>
      <div class="field"><div class="field-label">Wie oft?</div><div class="seg wide" role="group" aria-label="Intervall">
        ${iv.map(([k, v]) => `<button type="button" data-action="contract-interval" data-iv="${k}" aria-pressed="${draft.interval === k}" aria-label="${v.label}">${INTERVAL_BUTTON[k]}</button>`).join('')}
      </div><div class="calc num" id="calc"></div></div>

      <div class="field"><label for="c-anchor">${contract ? 'Erste Abbuchung' : 'Nächste Abbuchung'}</label><input id="c-anchor" class="input" type="date" value="${esc(draft.anchor)}">
        <div class="hint" id="anchor-hint"></div></div>
      <div class="field" id="cat-field"><div class="field-label">Kategorie</div><div class="cat-grid" id="cat-grid"></div><div class="hint err" id="cat-err" hidden>Bitte eine Kategorie antippen.</div></div>
      <div class="field" id="parts-field" hidden><div class="field-label">Posten</div><div id="parts-list"></div>
        <button type="button" class="btn small" data-action="part-add">+ Posten</button>
        <div class="hint err" id="parts-err" hidden>Jeder Posten braucht Name, Betrag und Kategorie.</div>
        <div class="calc num" id="parts-sum"></div></div>
      <div class="field"><label for="c-end">Endet am <span class="muted">(optional, z. B. gekündigt zum)</span></label><input id="c-end" class="input" type="date" value="${esc(draft.end)}"><div class="hint err" id="end-err" hidden>Das Ende liegt vor der ersten Abbuchung.</div></div>
      ${contract ? `<div class="field toggle-row"><span><b>Aktiv</b><br><span class="hint" style="margin:0">Pausiert = wird nicht mehr gebucht</span></span><label class="switch"><input type="checkbox" id="c-active" ${draft.active ? 'checked' : ''} aria-label="Aktiv"><span></span></label></div>` : ''}
      <div class="field"><label for="c-note">Notiz <span class="muted">(optional, z. B. Vertragsnummer, Kündigungsfrist)</span></label><input id="c-note" class="input" maxlength="200" autocomplete="off" value="${esc(draft.note)}"></div>
      ${contract ? `<div class="note-box">Bereits gebuchte Zahlungen bleiben unverändert. Neuer Betrag oder neue Kategorie gelten ab der nächsten Abbuchung${contract.bookedThrough ? ` (zuletzt gebucht: ${esc(L.formatDate(contract.bookedThrough))})` : ''}.</div>` : ''}
    </form>
    <div class="sheet-foot">
      ${contract ? '<button class="btn danger" data-action="delete-contract">Löschen</button>' : ''}
      <button class="btn primary" data-action="save-contract">Speichern</button>
    </div>`;
  renderContractCats();
  renderParts();
  applyPotMode();
  updateContractCalc();
  showSheet(contract ? null : '#c-name');
}

// ---- Topf-Posten im Fixkosten-Formular

function renderParts() {
  const list = $('#parts-list', sheet);
  if (!list) return;
  const perLabel = draft.interval === 'monatlich' ? 'pro Monat' : 'pro Zahlung';
  const cats = state.categories.filter((c) => c.type === 'ausgabe');
  list.innerHTML = draft.parts
    .map(
      (p, i) => `<div class="part-row" data-pi="${i}">
        <div class="p-line"><input class="input p-name" maxlength="60" autocomplete="off" placeholder="z. B. Tanken" aria-label="Name des Postens" value="${esc(p.name)}">
          <button type="button" class="icon-btn flat part-del" data-action="part-del" data-pi="${i}" aria-label="Posten ${esc(p.name)} entfernen">${ICON.close}</button></div>
        <div class="p-line"><input class="input p-amount num" inputmode="decimal" autocomplete="off" placeholder="0,00 €" aria-label="Betrag" value="${esc(p.amountText)}">
          <select class="input p-per" aria-label="Zeitraum"><option value="zahlung" ${p.per === 'zahlung' ? 'selected' : ''}>${perLabel}</option><option value="jahr" ${p.per === 'jahr' ? 'selected' : ''}>pro Jahr</option></select></div>
        <select class="input p-cat" aria-label="Kategorie"><option value="" ${!p.categoryId ? 'selected' : ''}>Kategorie wählen …</option>${cats.map((c) => `<option value="${esc(c.id)}" ${p.categoryId === c.id ? 'selected' : ''}>${esc(c.emoji)} ${esc(c.name)}</option>`).join('')}</select>
      </div>`,
    )
    .join('');
}

function readParts() {
  sheet.querySelectorAll('.part-row').forEach((row) => {
    const p = draft.parts[+row.dataset.pi];
    if (!p) return;
    p.name = $('.p-name', row).value.trim();
    p.amountText = $('.p-amount', row).value;
    p.per = $('.p-per', row).value;
    p.categoryId = $('.p-cat', row).value || null;
  });
}

function applyPotMode() {
  const potAllowed = draft.type === 'ausgabe';
  if (!potAllowed) draft.pot = false;
  $('#pot-toggle', sheet).hidden = !potAllowed;
  $('#c-pot', sheet).checked = draft.pot;
  $('#cat-field', sheet).hidden = draft.pot;
  $('#parts-field', sheet).hidden = !draft.pot;
  $('#amount-label', sheet).textContent = draft.pot ? 'Überweisung in den Topf' : 'Betrag pro Zahlung';
}

/** Gültige Posten (Betrag lesbar) mit Cent-Beträgen, für Summen. */
function parsedParts() {
  return draft.parts.map((p) => ({ ...p, amount: L.parseAmount(p.amountText) })).filter((p) => p.amount);
}

function renderContractCats() {
  const cats = state.categories.filter((c) => c.type === draft.type);
  $('#cat-grid', sheet).innerHTML = cats
    .map((c) => `<button type="button" class="cat" data-action="contract-cat" data-id="${esc(c.id)}" aria-pressed="${draft.categoryId === c.id}"><span class="e" aria-hidden="true">${esc(c.emoji)}</span><span>${esc(c.name)}</span></button>`)
    .join('');
}

function readContractForm() {
  draft.name = $('#c-name', sheet).value.trim();
  draft.amountText = $('#amount', sheet).value;
  draft.anchor = $('#c-anchor', sheet).value;
  draft.end = $('#c-end', sheet).value;
  draft.note = $('#c-note', sheet).value.trim();
  const act = $('#c-active', sheet);
  if (act) draft.active = act.checked;
  if (draft.pot) readParts();
}

function updateContractCalc() {
  readContractForm();
  if (draft.pot) {
    const total = Math.round(L.partsTotal(parsedParts(), draft.interval));
    if (!draft.amountTouched && total > 0) {
      draft.amountText = L.centsToInput(total);
      $('#amount', sheet).value = draft.amountText;
    }
    const amt = L.parseAmount(draft.amountText);
    const per = draft.interval === 'monatlich' ? 'pro Monat' : 'pro Zahlung';
    $('#parts-sum', sheet).textContent = total > 0 ? `Posten ergeben ${L.formatMoney(total)} ${per}${amt && amt !== total ? `, überwiesen werden ${L.formatMoney(amt)}. Verteilt wird anteilig.` : '.'}` : '';
  }
  const amount = L.parseAmount(draft.amountText);
  const calc = $('#calc', sheet);
  if (amount && draft.interval !== 'monatlich') {
    const c = { amount, interval: draft.interval };
    calc.textContent = `= ${L.formatMoney(L.contractPerMonth(c))} pro Monat · ${L.formatMoney(L.contractPerYear(c))} pro Jahr`;
  } else if (amount) {
    calc.textContent = `= ${L.formatMoney(amount * 12)} pro Jahr`;
  } else calc.textContent = '';
  const hint = $('#anchor-hint', sheet);
  const t = today();
  if (!L.isValidISO(draft.anchor)) {
    hint.textContent = '';
    return;
  }
  const existing = draft.id ? state.contracts.find((c) => c.id === draft.id) : null;
  const probe = { anchor: draft.anchor, interval: draft.interval, end: L.isValidISO(draft.end) ? draft.end : null };
  const due = L.occurrences(probe, existing?.bookedThrough || null, t);
  if (due.length === 1 && due[0] === t) {
    hint.textContent = 'Heute fällig, wird beim Speichern gleich gebucht.';
  } else if (due.length) {
    hint.textContent = `Liegt in der Vergangenheit: ${due.length === 1 ? 'eine Zahlung wird' : `${due.length} Zahlungen werden`} beim Speichern nachgebucht (ab ${L.formatDate(due[0])}).`;
  } else {
    const next = L.nextOccurrence({ ...probe, bookedThrough: existing?.bookedThrough || null }, L.addDays(t, -1));
    hint.textContent = next ? `Wird am ${L.formatDate(next)} automatisch gebucht.` : 'Keine weitere Abbuchung geplant.';
  }
}

async function saveContract() {
  readContractForm();
  const amount = L.parseAmount(draft.amountText);
  let ok = true;
  const flag = (sel, errSel, bad) => {
    $(sel, sheet).classList.toggle('invalid', bad);
    if (errSel) $(errSel, sheet).hidden = !bad;
    if (bad) ok = false;
  };
  flag('#c-name', '#name-err', !draft.name);
  flag('#amount', '#amount-err', amount === null);
  flag('#c-anchor', null, !L.isValidISO(draft.anchor));
  const endBad = !!draft.end && (!L.isValidISO(draft.end) || (L.isValidISO(draft.anchor) && draft.end < draft.anchor));
  flag('#c-end', '#end-err', endBad);
  let parts = null;
  if (draft.pot) {
    let partsOk = draft.parts.length > 0;
    parts = [];
    sheet.querySelectorAll('.part-row').forEach((row) => {
      const p = draft.parts[+row.dataset.pi];
      const amt = L.parseAmount(p.amountText);
      const catGood = !!p.categoryId && cat(p.categoryId)?.type === 'ausgabe';
      $('.p-name', row).classList.toggle('invalid', !p.name);
      $('.p-amount', row).classList.toggle('invalid', amt === null);
      $('.p-cat', row).classList.toggle('invalid', !catGood);
      if (!p.name || amt === null || !catGood) partsOk = false;
      else parts.push({ id: p.id || L.newId(), name: p.name, amount: amt, per: p.per === 'jahr' ? 'jahr' : 'zahlung', categoryId: p.categoryId });
    });
    $('#parts-err', sheet).hidden = partsOk;
    if (!partsOk) ok = false;
    else draft.categoryId = L.mainPartCategory(parts, draft.interval);
  } else {
    const catOk = draft.categoryId && cat(draft.categoryId)?.type === draft.type;
    $('#cat-err', sheet).hidden = !!catOk;
    if (!catOk) ok = false;
  }
  if (!ok) return revealFirstError();

  const t = today();
  const existing = draft.id ? state.contracts.find((c) => c.id === draft.id) : null;
  const contract = {
    id: existing ? existing.id : L.newId(),
    name: draft.name,
    type: draft.type,
    amount,
    interval: draft.interval,
    anchor: draft.anchor,
    end: draft.end || null,
    categoryId: draft.categoryId,
    active: draft.active,
    bookedThrough: existing ? existing.bookedThrough : null,
    note: draft.note,
    ...(parts ? { parts } : {}),
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
  };
  const due = contract.active ? L.occurrences(contract, contract.bookedThrough, t) : [];
  if (due.length > 1) {
    const go = await confirmDialog({
      title: `${due.length} Zahlungen nachbuchen?`,
      text: `Die erste Abbuchung liegt in der Vergangenheit. Damit werden ${due.length} Zahlungen vom ${L.formatDate(due[0])} bis ${L.formatDate(due[due.length - 1])} als Buchungen angelegt.\n\nWenn du nur künftige Zahlungen willst, wähle als Datum die nächste anstehende Abbuchung.`,
      ok: 'Nachbuchen',
      cancel: 'Datum ändern',
    });
    if (!go) return;
  }
  const prev = state;
  const contracts = existing ? state.contracts.map((c) => (c.id === existing.id ? contract : c)) : [...state.contracts, contract];
  const booked = L.bookDueContracts({ ...state, contracts }, t);
  closeSheet();
  commit(booked.state);
  toast(existing ? 'Fixkosten gespeichert' : `„${contract.name}“ angelegt${booked.added ? ` · ${booked.added} Zahlung${booked.added > 1 ? 'en' : ''} gebucht` : ''}`, { undo: () => commit(prev) });
}

async function deleteContract() {
  const c = state.contracts.find((x) => x.id === draft.id);
  if (!c) return closeSheet();
  const n = state.entries.filter((e) => e.contractId === c.id).length;
  const choice = await choiceDialog({
    title: `„${c.name}“ löschen?`,
    text: n ? `Es gibt ${n} bereits gebuchte Zahlung${n > 1 ? 'en' : ''} dazu.\n\nTipp: Ein gekündigter Vertrag bekommt besser ein Enddatum. Dann bleibt er in der Historie.` : 'Es wurden noch keine Zahlungen dazu gebucht.',
    buttons: [
      ...(n ? [{ label: 'Vertrag löschen, Buchungen behalten', value: 'keep', variant: 'danger' }, { label: 'Vertrag und alle Buchungen löschen', value: 'all', variant: 'danger' }] : [{ label: 'Löschen', value: 'keep', variant: 'danger' }]),
      { label: 'Abbrechen', value: null },
    ],
  });
  if (!choice) return;
  const prev = state;
  closeSheet();
  commit({
    ...state,
    contracts: state.contracts.filter((x) => x.id !== c.id),
    entries: choice === 'all' ? state.entries.filter((e) => e.contractId !== c.id) : state.entries,
  });
  toast('Fixkosten gelöscht', { undo: () => commit(prev) });
}

// ---------------------------------------------------------------- Kategorien

const EMOJI_CHOICES = ['🛒', '🍽️', '☕', '🏠', '⚡', '📱', '🚗', '⛽', '🚆', '🛡️', '🔁', '💪', '💊', '🎉', '🎮', '📚', '🛍️', '👕', '✈️', '🎁', '🐶', '👶', '🎓', '💇', '🔧', '🌱', '🐷', '📦', '💼', '↩️', '➕', '💶', '🏦', '🎵', '🍺', '🚲'];

function openCategorySheet(category = null) {
  draft = category
    ? { kind: 'category', id: category.id, name: category.name, emoji: category.emoji, type: category.type }
    : { kind: 'category', id: null, name: '', emoji: '📦', type: 'ausgabe' };
  const isFallback = category && Object.values(L.FALLBACK_CATEGORY).includes(category.id);
  sheet.innerHTML = `
    <div class="sheet-head"><h2 id="sheet-title">${category ? 'Kategorie bearbeiten' : 'Neue Kategorie'}</h2><button class="icon-btn flat" data-action="close-sheet" aria-label="Schließen">${ICON.close}</button></div>
    <form class="sheet-body" id="category-form" novalidate>
      ${!category ? `<div class="field"><div class="seg wide" role="group" aria-label="Art">
        <button type="button" data-action="category-type" data-type="ausgabe" aria-pressed="true">Ausgabe</button>
        <button type="button" data-action="category-type" data-type="einnahme" aria-pressed="false">Einnahme</button></div></div>` : ''}
      <div class="field"><label for="k-name">Name</label><input id="k-name" class="input" maxlength="40" autocomplete="off" value="${esc(draft.name)}"><div class="hint err" id="k-err" hidden>Bitte einen Namen eingeben.</div></div>
      <div class="field"><label for="k-emoji">Symbol</label><input id="k-emoji" class="input" maxlength="8" autocomplete="off" value="${esc(draft.emoji)}" style="font-size:24px;width:90px;text-align:center">
        <div class="chips" style="margin-top:10px">${EMOJI_CHOICES.map((e) => `<button type="button" class="chip" data-action="pick-emoji" data-e="${esc(e)}" aria-label="Symbol ${esc(e)}" style="font-size:20px;padding:6px 9px">${esc(e)}</button>`).join('')}</div>
      </div>
      ${isFallback ? '<div class="note-box">Diese Kategorie ist die Auffangkategorie und kann umbenannt, aber nicht gelöscht werden.</div>' : ''}
    </form>
    <div class="sheet-foot">
      ${category && !isFallback ? '<button class="btn danger" data-action="delete-category">Löschen</button>' : ''}
      <button class="btn primary" data-action="save-category">Speichern</button>
    </div>`;
  showSheet(category ? null : '#k-name');
}

function saveCategory() {
  const name = $('#k-name', sheet).value.trim();
  const emoji = $('#k-emoji', sheet).value.trim() || '•';
  if (!name) {
    $('#k-name', sheet).classList.add('invalid');
    $('#k-err', sheet).hidden = false;
    return revealFirstError();
  }
  const prev = state;
  let categories;
  if (draft.id) categories = state.categories.map((c) => (c.id === draft.id ? { ...c, name, emoji } : c));
  else {
    // Neue Kategorien vor der Auffangkategorie einsortieren
    const fallbackIdx = state.categories.findIndex((c) => c.id === L.FALLBACK_CATEGORY[draft.type]);
    const nc = { id: L.newId(), name, emoji, type: draft.type };
    categories = [...state.categories];
    categories.splice(fallbackIdx >= 0 ? fallbackIdx : categories.length, 0, nc);
  }
  closeSheet();
  commit({ ...state, categories });
  toast('Kategorie gespeichert', { undo: () => commit(prev) });
}

async function deleteCategory() {
  const c = cat(draft.id);
  if (!c) return closeSheet();
  const fallback = cat(L.FALLBACK_CATEGORY[c.type]);
  const n = state.entries.filter(usesCat(c.id)).length;
  const m = state.contracts.filter(usesCat(c.id)).length;
  if (n || m) {
    const go = await confirmDialog({
      title: `„${c.name}“ löschen?`,
      text: `${[n ? `${n} Buchung${n > 1 ? 'en' : ''}` : '', m ? `${m} Fixkosten` : ''].filter(Boolean).join(' und ')} ${n + m > 1 ? 'wandern' : 'wandert'} nach „${fallback.name}“.`,
      ok: 'Löschen',
      danger: true,
    });
    if (!go) return;
  }
  const prev = state;
  closeSheet();
  commit({
    ...state,
    categories: state.categories.filter((x) => x.id !== c.id),
    entries: state.entries.map(recat(c.id, fallback.id)),
    contracts: state.contracts.map(recat(c.id, fallback.id)),
  });
  if (ui.catFilter === c.id) ui.catFilter = null;
  toast('Kategorie gelöscht', { undo: () => commit(prev) });
}

// ---------------------------------------------------------------- Sheet & Dialoge

function showSheet(focusSel) {
  if (!sheet.open) sheet.showModal();
  sheet.querySelector('.sheet-body').scrollTop = 0;
  if (focusSel) {
    const el = $(focusSel, sheet);
    // kurz warten, bis das Sheet steht, dann geht auf dem Handy die Tastatur auf
    requestAnimationFrame(() => el && el.focus());
  } else {
    // Fokus auf den Schließen-Knopf statt auf ein Feld, damit keine Tastatur aufspringt
    $('[data-action="close-sheet"]', sheet)?.focus();
  }
}

/** Springt im Formular zum ersten Feld mit Fehler, damit man ihn sieht. */
function revealFirstError() {
  const el = sheet.querySelector('.invalid, .hint.err:not([hidden])');
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (el.classList.contains('invalid') && el.tagName === 'INPUT' && el.type !== 'date') el.focus({ preventScroll: true });
}

function closeSheet() {
  if (sheet.open) sheet.close();
}
sheet.addEventListener('close', () => {
  draft = null;
  sheet.innerHTML = '';
});
// Klick auf den abgedunkelten Hintergrund schließt das Sheet
sheet.addEventListener('mousedown', (e) => {
  if (e.target === sheet) {
    const r = sheet.getBoundingClientRect();
    if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right) closeSheet();
  }
});

let modalResolve = null;
function choiceDialog({ title, text, buttons }) {
  if (modalResolve) modalResolve(null);
  return new Promise((resolve) => {
    modalResolve = resolve;
    modal.innerHTML = `<h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}<div class="btn-col">${buttons
      .map((b, i) => `<button class="btn ${b.variant === 'primary' ? 'primary' : b.variant === 'danger' ? 'danger' : ''}" data-modal-i="${i}">${esc(b.label)}</button>`)
      .join('')}</div>`;
    modal.querySelectorAll('[data-modal-i]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const v = buttons[+btn.dataset.modalI].value;
        modalResolve = null;
        modal.close();
        resolve(v);
      }),
    );
    modal.showModal();
    // sichere Option (letzte = Abbrechen) fokussieren
    modal.querySelector(`[data-modal-i="${buttons.length - 1}"]`)?.focus();
  });
}
modal.addEventListener('close', () => {
  if (modalResolve) {
    const r = modalResolve;
    modalResolve = null;
    r(null);
  }
});

async function confirmDialog({ title, text, ok = 'OK', cancel = 'Abbrechen', danger = false }) {
  const v = await choiceDialog({ title, text, buttons: [{ label: ok, value: true, variant: danger ? 'danger' : 'primary' }, { label: cancel, value: false }] });
  return v === true;
}

function toast(message, { undo = null, duration = 5000, error = false, action = null } = {}) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '') + (undo ? ' undoable' : '');
  el.setAttribute('role', error ? 'alert' : 'status');
  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.textContent = message;
  el.append(msg);
  const remove = () => el.remove();
  const btnSpec = undo ? { label: 'Rückgängig', run: undo } : action;
  if (btnSpec) {
    const b = document.createElement('button');
    b.textContent = btnSpec.label;
    b.addEventListener('click', () => {
      remove();
      btnSpec.run();
    });
    el.append(b);
  }
  // höchstens drei Meldungen gleichzeitig
  while (box.children.length >= 3) box.firstChild.remove();
  box.append(el);
  if (duration) setTimeout(remove, duration);
  return el;
}

// ---------------------------------------------------------------- Sicherung

function download(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function backupJson() {
  const exported = { ...state, settings: { ...state.settings, lastBackupAt: new Date().toISOString() } };
  return { json: JSON.stringify(L.buildBackup(exported), null, 1), exported };
}

function backupFilename() {
  const d = new Date();
  return `finanzen-sicherung-${today()}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.json`;
}

function doBackup() {
  const { json, exported } = backupJson();
  download(backupFilename(), json, 'application/json');
  commit(exported);
  toast('Sicherung gespeichert (Ordner „Downloads“). Leg sie aufs NAS.', { duration: 7000 });
}

async function doBackupShare() {
  const { json, exported } = backupJson();
  const file = new File([json], backupFilename(), { type: 'application/json' });
  try {
    await navigator.share({ files: [file], title: 'Finanzen-Sicherung' });
    commit(exported);
    toast('Sicherung geteilt.');
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    toast('Teilen ging nicht. Nimm „Sicherung speichern“.', { error: true });
  }
}

function doCsv() {
  download(`finanzen-buchungen-${today()}.csv`, L.buildCsv(state), 'text/csv;charset=utf-8');
  toast('Tabelle gespeichert (Ordner „Downloads“).');
}

const importInput = $('#import-file');
importInput.addEventListener('change', async () => {
  const file = importInput.files && importInput.files[0];
  importInput.value = '';
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) return toast('Die Datei ist zu groß für eine Sicherung.', { error: true });
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return toast('Das ist keine gültige Sicherungsdatei.', { error: true });
  }
  const v = L.validateState(parsed);
  if (!v.ok) return toast(v.error, { error: true, duration: 8000 });
  const inc = v.state;
  const when = parsed.exportedAt ? ` vom ${new Date(parsed.exportedAt).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}` : '';
  const hasData = state.entries.length || state.contracts.length;
  const choice = await choiceDialog({
    title: 'Sicherung laden',
    text: `Datei${when}: ${nB(inc.entries.length)}, ${inc.contracts.length} Fixkosten.\n\n${hasData ? `Auf diesem Gerät sind gerade ${nB(state.entries.length)} und ${state.contracts.length} Fixkosten.\n\n„Ersetzen“ stellt genau den Stand der Datei her. „Ergänzen“ fügt nur hinzu, was hier noch fehlt.` : 'Auf diesem Gerät ist noch nichts gespeichert.'}${sync.cfg ? '\n\nDer Abgleich überträgt das Ergebnis auch auf deine anderen Geräte.' : ''}`,
    buttons: hasData
      ? [{ label: 'Ersetzen', value: 'replace', variant: 'primary' }, { label: 'Ergänzen', value: 'merge' }, { label: 'Abbrechen', value: null }]
      : [{ label: 'Laden', value: 'replace', variant: 'primary' }, { label: 'Abbrechen', value: null }],
  });
  if (!choice) return;
  try {
    await S.saveBeforeImport(state);
    ui.beforeImport = await S.loadBeforeImport();
  } catch (err) {
    return toast('Konnte den aktuellen Stand nicht absichern. Import abgebrochen.', { error: true });
  }
  let next;
  let msg;
  if (choice === 'replace') {
    next = inc;
    msg = 'Sicherung geladen.';
  } else {
    const m = L.mergeStates(state, inc);
    next = m.state;
    msg = `Ergänzt: ${nB(m.added.entries)}, ${m.added.contracts} Fixkosten, ${m.added.categories} ${m.added.categories === 1 ? 'Kategorie' : 'Kategorien'}.`;
  }
  const booked = L.bookDueContracts(next, today());
  await commit(booked.state);
  toast(msg + (booked.added ? ` ${booked.added} fällige Fixkosten gebucht.` : ''), { duration: 7000 });
});

async function undoImport() {
  const before = ui.beforeImport;
  if (!before) return;
  const go = await confirmDialog({
    title: 'Import rückgängig machen?',
    text: `Stellt den Stand vom ${new Date(before.savedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })} wieder her. Alles, was seitdem eingetragen wurde, geht dabei verloren.`,
    ok: 'Wiederherstellen',
  });
  if (!go) return;
  const v = L.validateState(before.state);
  if (!v.ok) return toast('Der gesicherte Stand ist beschädigt.', { error: true });
  await commit(v.state);
  await S.clearBeforeImport();
  ui.beforeImport = null;
  render();
  toast('Früheren Stand wiederhergestellt.');
}

async function wipe() {
  const go = await confirmDialog({
    title: 'Wirklich alles löschen?',
    text: `Alle Buchungen, Fixkosten und eigenen Kategorien auf diesem Gerät${sync.cfg ? ' und über den Abgleich auch auf deinen anderen Geräten' : ''} werden gelöscht. Speichere vorher eine Sicherung, wenn du die Daten noch brauchst.`,
    ok: 'Alles löschen',
    danger: true,
  });
  if (!go) return;
  try {
    await S.saveBeforeImport(state);
    ui.beforeImport = await S.loadBeforeImport();
  } catch {
    return toast('Konnte keinen Rückgängig-Punkt anlegen. Nichts gelöscht.', { error: true });
  }
  await commit(L.createInitialState());
  ui.tab = 'uebersicht';
  history.replaceState(null, '', '#uebersicht');
  render();
  toast('Alles gelöscht. Unter „Mehr“ kannst du es rückgängig machen.', { duration: 7000 });
}

// ---------------------------------------------------------------- Ereignisse

const actions = {
  tab: (el, ev) => {
    ev.preventDefault();
    setTab(el.dataset.tab);
  },
  'new-entry': () => openEntrySheet(),
  mode: (el) => {
    ui.mode = el.dataset.mode;
    // Jahr passend zum gerade gezeigten Monat und umgekehrt
    if (ui.mode === 'jahr') ui.year = +ui.month.slice(0, 4);
    else if (+ui.month.slice(0, 4) !== ui.year) ui.month = ui.year === L.yearOf(today()) ? L.monthKey(today()) : `${ui.year}-12`;
    render();
  },
  period: (el) => {
    const dir = +el.dataset.dir;
    if (ui.mode === 'monat') ui.month = L.addMonthKey(ui.month, dir);
    else ui.year += dir;
    render();
  },
  'period-now': () => {
    ui.month = L.monthKey(today());
    ui.year = L.yearOf(today());
    render();
  },
  'goto-month': (el) => {
    ui.mode = 'monat';
    ui.month = el.dataset.key;
    render();
    window.scrollTo(0, 0);
  },
  'filter-cat': (el) => {
    ui.catFilter = el.dataset.id;
    ui.query = '';
    setTab('buchungen');
  },
  'clear-filter': () => {
    ui.catFilter = null;
    render();
  },
  'show-month-entries': () => {
    ui.catFilter = null;
    ui.query = '';
    setTab('buchungen');
  },
  'edit-entry': (el) => {
    const e = state.entries.find((x) => x.id === el.dataset.id);
    if (e) openEntrySheet(e);
  },
  'edit-contract': (el) => {
    const c = state.contracts.find((x) => x.id === el.dataset.id);
    if (c) openContractSheet(c);
  },
  'new-contract': () => openContractSheet(),
  'edit-category': (el) => {
    const c = cat(el.dataset.id);
    if (c) openCategorySheet(c);
  },
  'new-category': () => openCategorySheet(),
  'close-sheet': () => closeSheet(),

  'entry-type': (el) => {
    if (draft.type === el.dataset.type) return;
    draft.type = el.dataset.type;
    sheet.querySelectorAll('[data-action="entry-type"]').forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
    draft.categoryId = null;
    draft.categoryTouched = false;
    readEntryForm();
    renderEntryParts();
    const learned = L.learnedCategory(state, draft.type, draft.note);
    if (learned) selectEntryCat(learned);
  },
  'entry-cat': (el) => {
    draft.categoryTouched = true;
    selectEntryCat(el.dataset.id);
  },
  'entry-sug': (el) => {
    const s = draft.suggestions[+el.dataset.i];
    if (!s) return;
    $('#note', sheet).value = s.note;
    draft.note = s.note;
    draft.categoryTouched = true;
    selectEntryCat(s.categoryId);
    const amt = $('#amount', sheet);
    if (!amt.value.trim()) amt.focus();
  },
  'entry-date': (el) => {
    draft.date = L.addDays(today(), +el.dataset.days);
    $('#date', sheet).value = draft.date;
    $('#date', sheet).classList.remove('invalid');
    syncDateChips();
  },
  'entry-to-contract': () => {
    readEntryForm();
    openContractSheet(null, { type: draft.type, amountText: draft.amountText, name: draft.note, categoryId: draft.categoryId, anchor: draft.date });
  },
  'save-entry': () => saveEntry(),
  'delete-entry': () => deleteEntry(),

  'contract-type': (el) => {
    if (draft.type === el.dataset.type) return;
    draft.type = el.dataset.type;
    sheet.querySelectorAll('[data-action="contract-type"]').forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
    draft.categoryId = draft.type === 'einnahme' ? 'gehalt' : null;
    if (!cat(draft.categoryId)) draft.categoryId = null;
    renderContractCats();
    applyPotMode();
    updateContractCalc();
  },
  'contract-interval': (el) => {
    if (draft.pot) readParts();
    draft.interval = el.dataset.iv;
    sheet.querySelectorAll('[data-action="contract-interval"]').forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
    if (draft.pot) renderParts();
    updateContractCalc();
  },
  'part-add': () => {
    readParts();
    draft.parts.push({ id: L.newId(), name: '', amountText: '', per: 'zahlung', categoryId: null });
    renderParts();
    $('#parts-err', sheet).hidden = true;
    sheet.querySelector('.part-row:last-child .p-name')?.focus();
  },
  'part-del': (el) => {
    readParts();
    draft.parts.splice(+el.dataset.pi, 1);
    renderParts();
    updateContractCalc();
  },
  'contract-cat': (el) => {
    draft.categoryId = el.dataset.id;
    sheet.querySelectorAll('.cat').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === el.dataset.id)));
    $('#cat-err', sheet).hidden = true;
  },
  'save-contract': () => saveContract(),
  'delete-contract': () => deleteContract(),

  'category-type': (el) => {
    draft.type = el.dataset.type;
    sheet.querySelectorAll('[data-action="category-type"]').forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
  },
  'pick-emoji': (el) => {
    $('#k-emoji', sheet).value = el.dataset.e;
  },
  'save-category': () => saveCategory(),
  'delete-category': () => deleteCategory(),

  backup: () => doBackup(),
  'backup-share': () => doBackupShare(),
  csv: () => doCsv(),
  import: () => importInput.click(),
  'undo-import': () => undoImport(),
  wipe: () => wipe(),

  'sync-create': () => syncCreate(),
  'sync-join': () => openSyncJoinSheet(),
  'save-sync-join': () => syncJoin(),
  'sync-now': async (el) => {
    el.disabled = true;
    sync.warned = null;
    await runSync();
    render();
    if (!sync.error) toast('Abgeglichen.', { duration: 2000 });
  },
  'sync-show': () => {
    sync.showKey = true;
    render();
  },
  'sync-hide': () => {
    sync.showKey = false;
    render();
  },
  'sync-copy': () => syncCopy(),
  'sync-off': () => syncOff(),
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) fn(el, ev);
});

document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.id === 'search') {
    ui.query = t.value;
    const box = $('#entries-results');
    if (box) box.innerHTML = renderEntryResults();
    return;
  }
  if (!draft) return;
  if (t.id === 'amount') {
    t.classList.remove('invalid');
    $('#amount-err', sheet).hidden = true;
    if (draft.kind === 'contract') {
      if (draft.pot) draft.amountTouched = t.value.trim() !== '';
      updateContractCalc();
    }
    if (draft.kind === 'entry' && draft.split) renderSplitBox();
  }
  if (draft.kind === 'contract' && t.id === 'c-pot') {
    readContractForm();
    draft.pot = t.checked;
    if (draft.pot && !draft.parts.length) {
      draft.parts.push({ id: L.newId(), name: '', amountText: '', per: 'zahlung', categoryId: draft.categoryId && cat(draft.categoryId)?.type === 'ausgabe' ? draft.categoryId : null });
      draft.amountTouched = false;
    }
    renderParts();
    applyPotMode();
    updateContractCalc();
  }
  if (draft.kind === 'contract' && t.closest?.('.part-row')) {
    t.classList.remove('invalid');
    $('#parts-err', sheet).hidden = true;
    updateContractCalc();
  }
  if (draft.kind === 'entry' && t.id === 'note' && !draft.categoryTouched) {
    const learned = L.learnedCategory(state, draft.type, t.value);
    if (learned) selectEntryCat(learned);
  }
  if (draft.kind === 'entry' && t.id === 'date') {
    if (L.isValidISO(t.value)) {
      draft.date = t.value;
      t.classList.remove('invalid');
    }
    syncDateChips();
  }
  if (draft.kind === 'contract' && (t.id === 'c-anchor' || t.id === 'c-end')) {
    t.classList.remove('invalid');
    updateContractCalc();
  }
  if (t.id === 'c-name' || t.id === 'k-name') {
    t.classList.remove('invalid');
    const err = $(t.id === 'c-name' ? '#name-err' : '#k-err', sheet);
    if (err) err.hidden = true;
  }
});

// Enter (bzw. „Fertig“ auf der Handytastatur) in einem Textfeld = Speichern
sheet.addEventListener('submit', (ev) => ev.preventDefault());
sheet.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' || ev.isComposing || !draft) return;
  const t = ev.target;
  if (t.tagName !== 'INPUT' || t.type === 'checkbox') return;
  ev.preventDefault();
  if (draft.kind === 'entry') {
    // Ohne Kategorie nur die Tastatur schließen, damit man eine antippen kann
    if (!draft.categoryId) {
      document.activeElement?.blur();
      return;
    }
    saveEntry();
  } else if (draft.kind === 'contract') saveContract();
  else if (draft.kind === 'sync') syncJoin();
  else saveCategory();
});

// Tooltip im Jahresdiagramm (Maus)
view.addEventListener('mouseover', (ev) => {
  const col = ev.target.closest('.chart-col');
  const old = view.querySelector('.chart-tip');
  if (!col) {
    old?.remove();
    return;
  }
  if (old && old.dataset.for === col.dataset.key) return;
  old?.remove();
  const chart = col.closest('.chart');
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.dataset.for = col.dataset.key;
  tip.textContent = col.dataset.tip;
  const cr = chart.getBoundingClientRect();
  const r = col.getBoundingClientRect();
  let x = r.left + r.width / 2 - cr.left;
  tip.style.left = x + 'px';
  chart.append(tip);
  // am Rand nicht abschneiden
  const tw = tip.getBoundingClientRect().width;
  x = Math.min(Math.max(x, tw / 2), cr.width - tw / 2);
  tip.style.left = x + 'px';
});
view.addEventListener('mouseleave', () => view.querySelector('.chart-tip')?.remove());

// ---------------------------------------------------------------- Offline & Updates

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Offline-Modus nur online (https) und zum Testen auf localhost; 127.0.0.1 bleibt zum Entwickeln ohne Cache
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  navigator.serviceWorker
    .register('sw.js')
    .then((reg) => {
      const offer = (worker) => {
        toast('Neue Version verfügbar.', {
          duration: 0,
          action: { label: 'Aktualisieren', run: () => worker.postMessage('skipWaiting') },
        });
      };
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
        });
      });
      // Beim Zurückkehren in die App nach Updates schauen
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    })
    .catch((err) => console.warn('Service Worker nicht registriert', err));
  // Beim allerersten Start übernimmt der Service Worker die Seite ebenfalls ("controllerchange"),
  // dann soll aber nicht neu geladen werden, nur bei einem echten Update.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;
    reloading = true;
    location.reload();
  });
}

init();
