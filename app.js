'use strict';

// Seite (index.html) und Programm (app.js) müssen zusammenpassen. Nach einem Update kann der Browser kurz eine
// alte Seite mit neuem Programm mischen – dann einmal neu laden. Bei jedem Update hier, in index.html und sw.js hochzählen.
const APP_VERSION = '6';
if (/^https?:$/.test(location.protocol)) {
  const seite = (document.querySelector('meta[name="app-version"]') || {}).content;
  if (seite !== APP_VERSION && sessionStorage.getItem('neuGeladen') !== APP_VERSION) {
    sessionStorage.setItem('neuGeladen', APP_VERSION);
    location.reload();
  }
}
// ---------- Konstanten ----------
const FELDER = [
  { k: 'n',    t: 'Normal',    big: true },
  { k: 'f',    t: 'Fahrt',     big: true },
  { k: 'a',    t: 'Auslösung', big: true },
  { k: 'p25',  t: '25%' },
  { k: 'p50',  t: '50%' },
  { k: 'p70',  t: '70%' },
  { k: 'p100', t: '100%' },
  { k: 'p150', t: '150%' },
];
// Reihenfolge der Spalten im PDF
const PDF_SPALTEN = ['n', 'p25', 'p50', 'p70', 'p100', 'p150', 'f', 'a'];
const PDF_KOPF = ['Tag', 'Normal', '25%', '50%', '70%', '100%', '150%', 'Fahrt', 'Auslösung', 'Übernachtung'];
const ZULAGEN = ['Sonn.-+Feiertagszulage/ netto', 'Nachtzulage/ netto', 'Fahrtkosten', 'Vorschuss'];
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const WT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

// ---------- Speicher (Android-Datei oder localStorage im Browser) ----------
const Store = {
  load() {
    try {
      const s = window.Android ? Android.loadData() : localStorage.getItem('stundenzettel');
      return s ? JSON.parse(s) : null;
    } catch (e) { return null; }
  },
  save(d) {
    const s = JSON.stringify(d);
    try { if (window.Android) Android.saveData(s); else localStorage.setItem('stundenzettel', s); } catch (e) {}
  },
};

// data.settings = { name, email, cc, t }, data.months['JJJJ-MM'] = { baustelle, blatt, zul, t, days: { 1: { n, f, a, p25 …, u, t } } }
// t = Zeitstempel der letzten Änderung (für den Dropbox-Abgleich: der neuere Eintrag gewinnt).
// Ein geleerter Tag bleibt als { t } stehen, damit das Leeren auch auf den anderen Handys ankommt.
//
// Gerätespeicher (seit 1.5, mehrere Benutzer):
//   { v: 2, lokal, benutzer: [{ id, name, salt, hash, admin, datei, mail, t, del }], konten: { id: { settings, months } } }
// lokal = bleibt nur auf diesem Gerät (Dropbox-Zugang, angemeldeter Benutzer, Abgleich-Stand je Benutzer), wird nie hochgeladen.
// Benutzer "u0" ist der Admin und besitzt die alte Datei /stundenzettel.json (Daten aus Version 1.4 und älter).
const gespeichert = Store.load() || {};
let lokal, benutzer, konten;
if (gespeichert.v === 2) {
  lokal = gespeichert.lokal || {};
  benutzer = gespeichert.benutzer || [];
  konten = gespeichert.konten || {};
} else {
  // Umstieg von 1.4: die bisherigen Daten gehören dem Admin (u0), der beim ersten Start seine PIN festlegt
  const l = gespeichert.lokal || {};
  lokal = { pkce: l.pkce || '', pkceCh: l.pkceCh || '', pkceM: l.pkceM || '', dbx: l.dbx || null, letzter: l.letzter || 0, meta: {} };
  benutzer = [];
  konten = {};
  if (gespeichert.settings || (gespeichert.months && Object.keys(gespeichert.months).length)) {
    konten.u0 = { settings: gespeichert.settings || {}, months: gespeichert.months || {} };
    lokal.meta.u0 = { rev: l.rev || null, dirty: !!l.dirty };
  }
}
lokal = Object.assign({ pkce: '', dbx: null, letzter: 0, meta: {}, aktiv: null, bleiben: true, bRev: null, bDirty: false }, lokal);
let data = { settings: { name: '', email: '', cc: '' }, months: {} };   // Daten des angemeldeten Benutzers
let aenderungen = 0;

// Abgleich-Stand des angemeldeten Benutzers
const km = () => lokal.meta[lokal.aktiv] || (lokal.meta[lokal.aktiv] = { rev: null, dirty: false });
const aktiverBenutzer = () => benutzer.find((u) => u.id === lokal.aktiv && !u.del) || null;
const standardSettings = () => ({ name: (aktiverBenutzer() || {}).name || '', email: '', cc: '' });

function saveLokal() {
  if (lokal.aktiv) konten[lokal.aktiv] = data;
  Store.save({ v: 2, lokal, benutzer, konten });
}
function save() {
  if (!lokal.aktiv) return;
  aenderungen++;
  km().dirty = true;
  saveLokal();
  planeSync(3000);
}

// Ältere Daten (ohne Zeitstempel) nachrüsten
function stempeln(d) {
  if (!d.settings.t) d.settings.t = 1;
  Object.values(d.months).forEach((mo) => {
    mo.days = mo.days || {};
    mo.zul = mo.zul || ZULAGEN.map(() => ({ q: '', r: '' }));
    if (!mo.t && !leererMonat(mo)) mo.t = 1;
    Object.values(mo.days).forEach((t) => { if (!t.t) t.t = 1; });
  });
}
const hatInhalt = (t) => Object.keys(t).some((k) => k !== 't');

const heute = new Date();
let cur = { y: heute.getFullYear(), m: heute.getMonth() };   // m: 0-11

const $ = (id) => document.getElementById(id);
const key = (y, m) => `${y}-${String(m + 1).padStart(2, '0')}`;
const tageImMonat = (y, m) => new Date(y, m + 1, 0).getDate();

function monat(y = cur.y, m = cur.m) {
  const k = key(y, m);
  if (!data.months[k]) data.months[k] = { baustelle: '', blatt: '', days: {}, zul: ZULAGEN.map(() => ({ q: '', r: '' })) };
  return data.months[k];
}
// nur nie bearbeitete Monate (ohne Zeitstempel) – sonst ginge ein Leeren beim Abgleich verloren
function leererMonat(mo) {
  return !mo.t && !mo.baustelle && !mo.blatt && !Object.keys(mo.days).length && mo.zul.every((z) => !z.q && !z.r);
}

// ---------- Zahlen ----------
function zahl(s) {
  if (s == null) return 0;
  const t = String(s).trim().replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : 0;
}
const fmt = (v) => (v ? v.toLocaleString('de-DE', { maximumFractionDigits: 2 }) : '');
const euro = (v) => (v ? v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €' : '-');
const anzeige = (s) => (s == null ? '' : String(s).trim().replace('.', ','));

// ---------- Feiertage NRW ----------
function ostern(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mon = Math.floor((h + l - 7 * m + 114) / 31), tag = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, mon - 1, tag);
}
const feiertagCache = {};
function feiertage(y) {
  if (feiertagCache[y]) return feiertagCache[y];
  const o = ostern(y), plus = (n) => new Date(o.getFullYear(), o.getMonth(), o.getDate() + n);
  const liste = [new Date(y, 0, 1), plus(-2), plus(1), new Date(y, 4, 1), plus(39), plus(50), plus(60),
    new Date(y, 9, 3), new Date(y, 10, 1), new Date(y, 11, 25), new Date(y, 11, 26)];
  return (feiertagCache[y] = new Set(liste.map((d) => `${d.getMonth()}-${d.getDate()}`)));
}
function frei(y, m, d) {
  const wd = new Date(y, m, d).getDay();
  return wd === 0 || wd === 6 || feiertage(y).has(`${m}-${d}`);
}

// ---------- Summen ----------
function summen(mo) {
  const s = {};
  PDF_SPALTEN.forEach((k) => (s[k] = 0));
  Object.values(mo.days).forEach((t) => PDF_SPALTEN.forEach((k) => (s[k] += zahl(t[k]))));
  return s;
}
const zulageBetrag = (z) => zahl(z.q) * zahl(z.r);
const gesamtBetrag = (mo) => mo.zul.reduce((a, z) => a + zulageBetrag(z), 0);

// ---------- Hauptansicht ----------
function render() {
  const mo = monat();
  $('monat').textContent = `${MONATE[cur.m]} ${cur.y}`;
  zeigeKopfName();
  $('baustelle').value = mo.baustelle;
  $('blatt').value = mo.blatt;

  const ul = $('tage');
  ul.innerHTML = '';
  const n = tageImMonat(cur.y, cur.m);
  for (let d = 1; d <= n; d++) {
    const t = mo.days[d] || {};
    const li = document.createElement('li');
    const istFrei = frei(cur.y, cur.m, d);
    if (istFrei) li.classList.add('frei');
    if (cur.y === heute.getFullYear() && cur.m === heute.getMonth() && d === heute.getDate()) li.classList.add('heute');
    li.innerHTML = `<div class="tag"><b>${d}</b><small>${WT[new Date(cur.y, cur.m, d).getDay()]}</small></div><div class="inhalt"></div>`;
    const inh = li.querySelector('.inhalt');
    const z1 = document.createElement('div');
    z1.className = 'zeile1';
    const teile = [];
    if (t.n && !zahl(t.n) && t.n.trim()) teile.push(`<span class="pill urlaub">${esc(t.n)}</span>`);
    else if (zahl(t.n)) teile.push(`<span class="pill">${anzeige(t.n)} h</span>`);
    ['p25', 'p50', 'p70', 'p100', 'p150'].forEach((k) => {
      if (zahl(t[k])) teile.push(`<span>${anzeige(t[k])} <span class="ft">${k.slice(1)}%</span></span>`);
    });
    if (zahl(t.f)) teile.push(`<span>${anzeige(t.f)} <span class="ft">Fahrt</span></span>`);
    if (anzeige(t.a)) teile.push(`<span>${esc(anzeige(t.a))} <span class="ft">Ausl.</span></span>`);
    z1.innerHTML = teile.length ? teile.join('') : `<span class="leer">${istFrei ? '–' : 'noch leer'}</span>`;
    inh.appendChild(z1);
    if (t.u) {
      const o = document.createElement('div');
      o.className = 'ort';
      o.textContent = t.u;
      inh.appendChild(o);
    }
    li.addEventListener('click', () => oeffneTag(d));
    ul.appendChild(li);
  }

  // Summen oben
  const s = summen(mo);
  const sTeile = [`Normal <b>${fmt(s.n) || 0}</b>`];
  ['p25', 'p50', 'p70', 'p100', 'p150'].forEach((k) => { if (s[k]) sTeile.push(`${k.slice(1)}% <b>${fmt(s[k])}</b>`); });
  sTeile.push(`Fahrt <b>${fmt(s.f) || 0}</b>`);
  if (s.a) sTeile.push(`Auslösung <b>${fmt(s.a)}</b>`);
  $('summen').innerHTML = sTeile.map((x) => `<span>${x}</span>`).join('');

  renderZulagen();
}

function renderZulagen() {
  const mo = monat();
  const box = $('zrows');
  if (!box.children.length) {
    ZULAGEN.forEach((name, i) => {
      const row = document.createElement('div');
      row.className = 'zrow';
      row.innerHTML = `<span>${name}</span><input inputmode="decimal" data-i="${i}" data-f="q" placeholder="Anz.">` +
        `<span>×</span><input inputmode="decimal" data-i="${i}" data-f="r" placeholder="€"><div class="res"></div>`;
      box.appendChild(row);
    });
    box.addEventListener('input', (e) => {
      const i = e.target.dataset.i, f = e.target.dataset.f;
      if (i == null) return;
      const mo = monat();
      mo.zul[i][f] = e.target.value;
      mo.t = Date.now();
      save();
      updateZulagenErgebnis();
    });
  }
  box.querySelectorAll('input').forEach((inp) => (inp.value = mo.zul[inp.dataset.i][inp.dataset.f]));
  updateZulagenErgebnis();
}
function updateZulagenErgebnis() {
  const mo = monat();
  $('zrows').querySelectorAll('.res').forEach((el, i) => {
    const b = zulageBetrag(mo.zul[i]);
    el.textContent = b ? '= ' + euro(b) : '';
  });
  $('gesamt').textContent = 'Gesamtbetrag: ' + euro(gesamtBetrag(mo));
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- Tag bearbeiten ----------
let aktTag = null;

function baueEditor() {
  const g = $('edGrid');
  FELDER.forEach((f) => {
    const l = document.createElement('label');
    if (f.big) l.className = 'big';
    l.innerHTML = `${f.t}<input id="ed_${f.k}" inputmode="decimal" autocomplete="off">`;
    g.appendChild(l);
  });
  // Normal darf auch Text sein (Urlaub/Krank)
  $('ed_n').setAttribute('inputmode', 'decimal');
  const alle = [...FELDER.map((f) => f.k), 'u'];
  alle.forEach((k) => $('ed_' + k).addEventListener('input', () => speichereTag()));
  alle.forEach((k) => $('ed_' + k).addEventListener('focus', (e) => setTimeout(() => e.target.select(), 0)));
}

function oeffneTag(d) {
  aktTag = d;
  const t = monat().days[d] || {};
  const dt = new Date(cur.y, cur.m, d);
  $('edTitel').textContent = `${WT[dt.getDay()]}, ${String(d).padStart(2, '0')}.${String(cur.m + 1).padStart(2, '0')}.${cur.y}`;
  FELDER.forEach((f) => ($('ed_' + f.k).value = t[f.k] || ''));
  $('ed_u').value = t.u || '';
  fuelleOrte();
  zeige('editor', true);
}

function speichereTag() {
  if (aktTag == null) return;
  const mo = monat();
  const t = {};
  [...FELDER.map((f) => f.k), 'u'].forEach((k) => {
    const v = $('ed_' + k).value.trim();
    if (v) t[k] = v;
  });
  // nur bei echter Änderung speichern – bloßes Öffnen darf keinen neueren Stand vom anderen Handy überschreiben
  const alt = mo.days[aktTag] || {};
  const ohneT = (x) => JSON.stringify(Object.keys(x).filter((k) => k !== 't').sort().map((k) => [k, x[k]]));
  if (ohneT(alt) === ohneT(t)) return;
  t.t = Date.now();
  mo.days[aktTag] = t;   // geleert = nur { t }
  save();
}

function setzeFelder(t) {
  FELDER.forEach((f) => ($('ed_' + f.k).value = t[f.k] || ''));
  $('ed_u').value = t.u || '';
  speichereTag();
}

function letzterArbeitstag(vor) {
  // sucht rückwärts (auch im Vormonat) den letzten Tag mit Stunden
  let y = cur.y, m = cur.m, d = vor - 1;
  for (let i = 0; i < 62; i++) {
    if (d < 1) { m--; if (m < 0) { m = 11; y--; } d = tageImMonat(y, m); }
    const mo = data.months[key(y, m)];
    const t = mo && mo.days[d];
    if (t && zahl(t.n)) return t;
    d--;
  }
  return null;
}

function fuelleOrte() {
  const orte = new Map();
  Object.keys(data.months).sort().reverse().forEach((k) => {
    Object.values(data.months[k].days).forEach((t) => { if (t.u && !orte.has(t.u)) orte.set(t.u, 1); });
  });
  $('orte').innerHTML = [...orte.keys()].slice(0, 30).map((o) => `<option value="${esc(o)}">`).join('');
}

function wechsleTag(delta) {
  speichereTag();
  const n = tageImMonat(cur.y, cur.m);
  const d = aktTag + delta;
  if (d >= 1 && d <= n) oeffneTag(d);
}

// ---------- Sheets ----------
function zeige(id, an) {
  $(id).hidden = !an;
  if (!an && id === 'editor') { speichereTag(); aktTag = null; render(); }
  if (!an && id === 'settings' && !$('login').hidden && !loginWahl) zeigeLogin();
}
window.onAndroidBack = function () {
  if (!$('pinDlg').hidden) { $('pdAbbr').click(); return true; }
  if (!$('vorschau').hidden) { schliesseVorschau(); return true; }
  for (const id of ['editor', 'settings']) if (!$(id).hidden) { zeige(id, false); return true; }
  if (!$('login').hidden && loginWahl) { loginWahl = null; zeigeLogin(); return true; }
  return false;
};

function toast(msg, ms = 2400) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- PDF-Blatt zeichnen (Einheiten wie A4 bei 96 dpi: 794 x 1123) ----------
const A4W = 793.76, A4H = 1122.56;
const LOGO = new Image();
LOGO.src = window.LOGO_SRC || '';

function zeichneBlatt(ctx, y, m) {
  const mo = monat(y, m);
  const FONT = 'Arial, Helvetica, "Liberation Sans", Roboto, sans-serif';
  const txt = (s, x, yy, { size = 12.5, bold = false, align = 'center', maxW = 0 } = {}) => {
    s = String(s);
    let sz = size;
    ctx.font = `${bold ? 'bold ' : ''}${sz}px ${FONT}`;
    if (maxW) while (sz > 6 && ctx.measureText(s).width > maxW) { sz -= 0.5; ctx.font = `${bold ? 'bold ' : ''}${sz}px ${FONT}`; }
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#000';
    ctx.fillText(s, x, yy);
  };
  const box = (x1, y1, x2, y2, fill, lw = 1) => {
    if (fill) { ctx.fillStyle = fill; ctx.fillRect(x1, y1, x2 - x1, y2 - y1); }
    ctx.lineWidth = lw;
    ctx.strokeStyle = '#000';
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
  };
  const linie = (x1, y1, x2, y2, lw = 1) => {
    ctx.lineWidth = lw; ctx.strokeStyle = '#000';
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  };

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, A4W, A4H);

  // Logo + Titel
  if (LOGO.complete && LOGO.naturalWidth) ctx.drawImage(LOGO, 61, 60, 92, 92 * LOGO.naturalHeight / LOGO.naturalWidth);
  txt('Stundenaufstellung Montage- (Baustelle)', 381, 64, { size: 21.5, bold: true });

  // Kopf
  txt('Baustelle:', 286, 110, { size: 13.5, bold: true, align: 'right' });
  box(290, 98, 748.4, 122.5);
  txt(mo.baustelle, 294, 110.5, { size: 13, align: 'left', maxW: 450 });
  txt('Monat:', 286, 135, { size: 13.5, bold: true, align: 'right' });
  box(290, 122.5, 407.6, 147.4);
  txt(`${MONATE[m]} ${y}`, 293, 135, { size: 13, align: 'left', maxW: 112 });
  txt('Name:', 463, 135, { size: 13.5, bold: true, align: 'right' });
  box(466.6, 122.5, 748.4, 147.4);
  txt(data.settings.name, 469.5, 135, { size: 13, align: 'left', maxW: 275 });

  // Tabelle
  const X = [39.7, 98.1, 171.8, 230.7, 289.7, 348.7, 407.6, 466.6, 539.7, 628.2, 748.4];
  const KT = 157.6, KB = 194.5, RH = 19.05, SUMT = KB + 31 * RH, SUMB = SUMT + 19.1;
  const mitte = (i) => (X[i] + X[i + 1]) / 2;

  box(X[0], KT, X[10], KB, '#D9D9D9');
  PDF_KOPF.forEach((t, i) => txt(t, mitte(i), (KT + KB) / 2, { size: 13.5, bold: true, maxW: X[i + 1] - X[i] - 4 }));

  const n = tageImMonat(y, m);
  for (let r = 0; r < 31; r++) {
    const top = KB + r * RH, cy = top + RH / 2, d = r + 1;
    const fillTag = d <= n && frei(y, m, d) ? '#FFC000' : '#F2F2F2';
    ctx.fillStyle = fillTag;
    ctx.fillRect(X[0], top, X[1] - X[0], RH);
    if (d <= n) {
      txt(d, mitte(0), cy + 0.5, { size: 13, bold: true });
      const t = mo.days[d] || {};
      PDF_SPALTEN.forEach((k, i) => {
        const v = anzeige(t[k]);
        if (v) txt(v, mitte(i + 1), cy + 0.5, { size: 12.5, maxW: X[i + 2] - X[i + 1] - 4 });
      });
      if (t.u) txt(t.u, mitte(9), cy + 0.5, { size: 11, maxW: X[10] - X[9] - 6 });
    }
  }
  // Summe
  ctx.fillStyle = '#D9D9D9';
  ctx.fillRect(X[0], SUMT, X[10] - X[0], SUMB - SUMT);
  txt('Summe', mitte(0), (SUMT + SUMB) / 2, { size: 13.5, bold: true, maxW: X[1] - X[0] - 3 });
  const s = summen(mo);
  PDF_SPALTEN.forEach((k, i) => { if (s[k]) txt(fmt(s[k]), mitte(i + 1), (SUMT + SUMB) / 2, { size: 13.5, bold: true }); });

  // Gitter
  for (let r = 1; r <= 31; r++) linie(X[0], KB + r * RH, X[10], KB + r * RH, 0.9);
  X.slice(1, 10).forEach((x) => linie(x, KT, x, SUMB, 0.9));
  linie(X[0], KB, X[10], KB, 1.4);
  linie(X[0], SUMT, X[10], SUMT, 1.4);
  box(X[0], KT, X[10], SUMB, null, 1.8);

  // Zulagen
  const ZT = 816.4, ZH = 22.7;
  mo.zul.forEach((z, i) => {
    const t = ZT + i * ZH, cy = t + ZH / 2;
    box(39.7, t, 289.7, t + ZH);
    txt(ZULAGEN[i], 42.5, cy, { size: 13, align: 'left', maxW: 244 });
    box(289.7, t, 348.7, t + ZH);
    if (zahl(z.q)) txt(fmt(zahl(z.q)), 319.2, cy, { size: 12.5, maxW: 55 });
    txt('x', 378.7, cy, { size: 13, bold: true });
    box(407.6, t, 539.7, t + ZH);
    if (zahl(z.r)) txt(euro(zahl(z.r)), 473.6, cy, { size: 12.5, maxW: 126 });
    txt('=', 584, cy, { size: 13, bold: true });
    box(628.2, t, 748.4, t + ZH);
    txt(euro(zulageBetrag(z)), 688.3, cy, { size: 12.5, maxW: 114 });
  });

  // Blatt + Gesamtbetrag
  txt('Blatt:', 169, 938.3, { size: 13.5, bold: true, align: 'right' });
  box(171.8, 925.8, 289.7, 950.8);
  if (mo.blatt) txt(mo.blatt, 230.7, 938.3, { size: 13, maxW: 110 });
  txt('Gesamtbetrag:', 463, 938.3, { size: 13.5, bold: true, align: 'right' });
  box(466.6, 925.8, 748.4, 950.8);
  txt(euro(gesamtBetrag(mo)), 607.5, 938.3, { size: 13, bold: true, maxW: 270 });
}

// ---------- Minimaler PDF-Schreiber (eine Seite, ein JPEG) ----------
function baueePdf(jpeg, wPx, hPx) {
  const W = 595.28, H = 841.89;
  const enc = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };
  const teile = [], offs = [];
  let len = 0;
  const push = (x) => { const b = typeof x === 'string' ? enc(x) : x; teile.push(b); len += b.length; };
  const obj = (nr, body) => { offs[nr] = len; push(`${nr} 0 obj\n${body}\nendobj\n`); };

  push('%PDF-1.4\n');
  push(new Uint8Array([37, 226, 227, 207, 211, 10]));
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offs[4] = len;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${wPx} /Height ${hPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  push(jpeg);
  push('\nendstream\nendobj\n');
  const inhalt = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${inhalt.length} >>\nstream\n${inhalt}\nendstream`);
  obj(6, `<< /Title (Stundenaufstellung) /Producer (Stundenzettel-App) >>`);
  const xref = len;
  let x = 'xref\n0 7\n0000000000 65535 f \n';
  for (let i = 1; i <= 6; i++) x += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  push(x + `trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(len);
  let p = 0;
  teile.forEach((b) => { out.set(b, p); p += b.length; });
  return out;
}

function bytesZuBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ZuBytes(b64) {
  const s = atob(b64), b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}
const dateiName = (s) => s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe')
  .replace(/Ü/g, 'Ue').replace(/ß/g, 'ss').replace(/[^\w\-. ]+/g, '').replace(/\s+/g, '_');

function erzeugePdf(y, m) {
  const SCALE = 3;
  const c = document.createElement('canvas');
  c.width = Math.round(A4W * SCALE);
  c.height = Math.round(A4H * SCALE);
  const ctx = c.getContext('2d');
  ctx.scale(SCALE, SCALE);
  zeichneBlatt(ctx, y, m);
  const jpeg = base64ZuBytes(c.toDataURL('image/jpeg', 0.9).split(',')[1]);
  return baueePdf(jpeg, c.width, c.height);
}

async function pdfSenden() {
  const y = cur.y, m = cur.m;
  if (!LOGO.complete) await new Promise((r) => { LOGO.onload = LOGO.onerror = r; });
  const pdf = erzeugePdf(y, m);
  const name = dateiName(`Stundenaufstellung ${MONATE[m]} ${y} ${data.settings.name}`) + '.pdf';
  const betreff = `Stundenaufstellung ${MONATE[m]} ${y} – ${data.settings.name}`;
  const text = `Hallo,\n\nanbei meine Stundenaufstellung für ${MONATE[m]} ${y}.\n\nViele Grüße\n${data.settings.name}`;
  if (window.Android) {
    Android.sharePdf(bytesZuBase64(pdf), name, data.settings.email || '', data.settings.cc || '', betreff, text);
  } else if (istHandy() && kopiereEmpfaenger() && teileImBrowser(pdf, name, 'application/pdf', betreff, text)) {
    // Handy (Web-App): Teilen-Menü ist offen, die Adresse der Buchhaltung liegt in der Zwischenablage
  } else {
    // PC: PDF herunterladen und eine fertige Mail öffnen, die PDF nur noch anhängen
    ladeHerunter(pdf, name, 'application/pdf');
    const s = data.settings;
    if (s.email) {
      const q = [`subject=${encodeURIComponent(betreff)}`, `body=${encodeURIComponent(text)}`];
      if (s.cc) q.unshift(`cc=${encodeURIComponent(s.cc)}`);
      setTimeout(() => { location.href = `mailto:${encodeURIComponent(s.email)}?${q.join('&')}`; }, 400);
      toast('PDF ist in „Downloads“ – bitte an die Mail anhängen');
    } else {
      toast('PDF ist in „Downloads“ gespeichert');
    }
  }
}

// Im Teilen-Menü lässt sich kein Empfänger vorgeben -> Adresse der Buchhaltung in die Zwischenablage.
// Vor navigator.share aufrufen: das verbraucht die Tipp-Berechtigung, die das Kopieren auch braucht. Gibt immer true zurück.
function kopiereEmpfaenger() {
  const mail = data.settings.email;
  if (!mail) return true;
  const hinweis = (ok) => toast(ok ? `${mail} kopiert – in der Mail bei „An“ einfügen` : `Mail an: ${mail}`, 7000);
  try { navigator.clipboard.writeText(mail).then(() => hinweis(true), () => hinweis(false)); } catch (e) { hinweis(false); }
  return true;
}

// Handy/Tablet (Touch) oder PC mit Maus?
function istHandy() { return window.matchMedia && matchMedia('(pointer: coarse)').matches; }

// iPhone/Browser: Teilen-Menü öffnen. false = geht hier nicht
function teileImBrowser(inhalt, name, mime, betreff, text) {
  try {
    const datei = new File([inhalt], name, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [datei] })) {
      navigator.share({ files: [datei], title: betreff, text: text || '' }).catch(() => {});
      return true;
    }
  } catch (e) { /* weiter mit Download */ }
  return false;
}
function ladeHerunter(inhalt, name, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([inhalt], { type: mime }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------- Backup ----------
function backupTeilen() {
  const json = JSON.stringify(data, null, 1);
  const name = `stundenzettel-backup-${new Date().toISOString().slice(0, 10)}.json`;
  if (window.Android) {
    Android.shareFile(bytesZuBase64(new TextEncoder().encode(json)), name, 'application/json', 'Stundenzettel Backup');
  } else if (!(istHandy() && teileImBrowser(json, name, 'application/json', 'Stundenzettel Backup'))) {
    ladeHerunter(json, name, 'application/json');
  }
}
function backupLaden(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (!d || typeof d.months !== 'object') throw new Error();
      const b = { settings: Object.assign(standardSettings(), d.settings || {}), months: d.months };
      stempeln(b);
      if (!confirm(lokal.dbx
        ? `Backup für ${data.settings.name || 'diesen Benutzer'} laden? Es wird mit den Dropbox-Daten zusammengeführt (der neuere Eintrag gewinnt).`
        : `Backup für ${data.settings.name || 'diesen Benutzer'} laden? Seine aktuellen Daten auf diesem Gerät werden dadurch ersetzt.`)) return;
      data = lokal.dbx ? mischeDaten(data, b) : b;
      save();
      ladeEinstellungen();
      render();
      toast('Backup geladen');
    } catch (e) { alert('Das ist keine gültige Backup-Datei.'); }
  };
  r.readAsText(file);
}

function ladeEinstellungen() {
  $('setName').value = data.settings.name;
  $('setMail').value = data.settings.email;
  $('setCc').value = data.settings.cc;
  zeigeBenutzerTeil();
  zeigeDropbox();
}

// ---------- Zusammenführen zweier Datenstände (pro Tag / Monatskopf / Einstellungen gewinnt der neuere Zeitstempel) ----------
const neuer = (a, b) => ((b.t || 0) > (a.t || 0) ? b : a);
const kopie = (x) => JSON.parse(JSON.stringify(x));

function mischeMonat(a, b) {
  if (!a || !b) return kopie(a || b);
  const k = neuer(a, b);   // Baustelle, Blatt und Zulagen gehören zusammen
  const out = { baustelle: k.baustelle || '', blatt: k.blatt || '', zul: kopie(k.zul || ZULAGEN.map(() => ({ q: '', r: '' }))), t: k.t || 0, days: {} };
  Object.keys(Object.assign({}, a.days, b.days)).forEach((d) => {
    const x = a.days[d], y = b.days[d];
    out.days[d] = kopie(x && y ? neuer(x, y) : x || y);
  });
  return out;
}
function mischeDaten(a, b) {
  const months = {};
  Object.keys(Object.assign({}, a.months, b.months)).forEach((k) => (months[k] = mischeMonat(a.months[k], b.months[k])));
  return { settings: kopie(neuer(a.settings, b.settings)), months };
}
// Einheitliche Textform zum Vergleichen (Schlüssel sortiert, leere Werte weg)
function kanon(x) {
  if (Array.isArray(x)) return x.map(kanon);
  if (x && typeof x === 'object') { const o = {}; Object.keys(x).sort().forEach((k) => { if (x[k] !== '' && x[k] != null) o[k] = kanon(x[k]); }); return o; }
  return x;
}
// nur durchgeblätterte, nie bearbeitete Monate werden nicht abgeglichen
const echteMonate = (months) => Object.fromEntries(Object.entries(months).filter(([, mo]) => !leererMonat(mo)));
const kanonText = (d) => JSON.stringify(kanon({ settings: d.settings, months: echteMonate(d.months) }));

// ---------- Dropbox ----------
// Gleiche Dropbox-App wie die Fremdfirmen-App (gemeinsames Konto); Datei liegt unter Apps/Fremdfirmen/
const DROPBOX_APP_KEY = '4i9ocbg02anqwyj';   // kein Geheimnis, nur die App-Kennung
const DBX_BENUTZER = '/stundenzettel-benutzer.json';   // Benutzerliste (Namen + PIN-Prüfwerte)
// Datei des angemeldeten Benutzers: Admin u0 = /stundenzettel.json (wie bis 1.4), sonst /stundenzettel-<id>.json
const dbxDatei = () => ((aktiverBenutzer() || {}).datei || `/stundenzettel-${lokal.aktiv}.json`);

function zufall(n) {
  const z = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const r = new Uint8Array(n);
  crypto.getRandomValues(r);
  return Array.from(r, (v) => z[v % z.length]).join('');
}
// Anmelde-Geheimnis (PKCE) vorab erzeugen: so kann der Knopf den Browser sofort öffnen
async function bereitePkce(neu) {
  if (lokal.pkce && lokal.pkceCh && !neu) return;
  const v = zufall(64);
  let ch = v, m = 'plain';
  try {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));
    ch = btoa(String.fromCharCode.apply(null, h)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    m = 'S256';
  } catch (e) { /* ohne crypto.subtle: einfache Variante */ }
  lokal.pkce = v; lokal.pkceCh = ch; lokal.pkceM = m;
  saveLokal();
}
function dbxAnmelden() {
  const oeffne = () => {
    const url = 'https://www.dropbox.com/oauth2/authorize?response_type=code&token_access_type=offline' +
      `&client_id=${encodeURIComponent(DROPBOX_APP_KEY)}&code_challenge=${lokal.pkceCh}&code_challenge_method=${lokal.pkceM}`;
    if (window.Android && Android.openUrl) Android.openUrl(url);
    else if (!window.open(url, '_blank')) location.href = url;
  };
  if (lokal.pkce && lokal.pkceCh) oeffne(); else bereitePkce().then(oeffne);
}
async function dbxTokenAnfrage(params) {
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(Object.assign({ client_id: DROPBOX_APP_KEY }, params)).toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(j.error_description || j.error || 'Anmeldung fehlgeschlagen'); e.auth = res.status === 400 || res.status === 401; throw e; }
  return j;
}
async function dbxVerbinden() {
  const code = $('dbxCode').value.replace(/\s+/g, '');   // Leerzeichen/Zeilenumbrüche vom Kopieren entfernen
  if (!code) { toast('Bitte den Code von Dropbox einfügen'); return; }
  if (!lokal.pkce) { toast('Bitte zuerst „Bei Dropbox anmelden“ antippen'); return; }
  const knopf = $('dbxVerbinden');
  if (knopf.disabled) return;                             // Doppeltipp: der Code gilt nur einmal
  knopf.disabled = true;
  knopf.textContent = 'Verbinde …';
  try {
    const j = await dbxTokenAnfrage({ grant_type: 'authorization_code', code, code_verifier: lokal.pkce });
    lokal.dbx = { refresh: j.refresh_token, access: j.access_token, exp: Date.now() + (j.expires_in || 0) * 1000 };
    lokal.pkce = ''; lokal.pkceCh = '';
    Object.values(lokal.meta).forEach((m) => { m.rev = null; m.dirty = true; });
    lokal.bRev = null;
    lokal.bDirty = benutzer.length > 0;
    saveLokal();
    $('dbxCode').value = '';
    toast('Mit Dropbox verbunden');
    zeigeDropbox();
    sync();
  } catch (e) {
    $('dbxCode').value = '';
    bereitePkce(true);   // der alte Code ist verbraucht -> neues Anmelde-Geheimnis für den nächsten Versuch
    alert('Verbinden hat nicht geklappt: ' + e.message + '\n\nDer Code gilt nur einmal und nur wenige Minuten. Bitte noch einmal „1. Bei Dropbox anmelden“ antippen und den neuen Code direkt einfügen.');
  } finally {
    knopf.disabled = false;
    knopf.textContent = '3. Verbinden';
  }
}
function dbxTrennen() {
  if (!confirm('Dropbox-Abgleich auf diesem Handy beenden? Die Daten bleiben auf dem Handy und in der Dropbox erhalten.')) return;
  lokal.dbx = null; lokal.bRev = null; lokal.pkce = ''; lokal.pkceCh = '';
  Object.values(lokal.meta).forEach((m) => { m.rev = null; });
  saveLokal();
  setzeStatus('aus');
  zeigeDropbox();
}
async function dbxToken() {
  if (lokal.dbx.access && lokal.dbx.exp > Date.now() + 60000) return lokal.dbx.access;
  const j = await dbxTokenAnfrage({ grant_type: 'refresh_token', refresh_token: lokal.dbx.refresh });
  lokal.dbx.access = j.access_token;
  lokal.dbx.exp = Date.now() + (j.expires_in || 0) * 1000;
  saveLokal();
  return lokal.dbx.access;
}
// Antwort: { ok, status, text }. 409 = "gibt es nicht" bzw. Konflikt und wird vom Aufrufer behandelt.
async function dbxAufruf(url, headers, body) {
  for (let versuch = 0; versuch < 2; versuch++) {
    const token = await dbxToken();
    const res = await fetch(url, { method: 'POST', headers: Object.assign({ Authorization: 'Bearer ' + token }, headers), body });
    if (res.status === 401 && versuch === 0) { lokal.dbx.access = ''; continue; }
    const text = await res.text();
    if (!res.ok && res.status !== 409) { const e = new Error(`Dropbox-Fehler ${res.status}: ${text.slice(0, 120)}`); e.auth = res.status === 401; throw e; }
    return { ok: res.ok, status: res.status, text };
  }
}
async function dbxRev(pfad) {
  const r = await dbxAufruf('https://api.dropboxapi.com/2/files/get_metadata', { 'Content-Type': 'application/json' }, JSON.stringify({ path: pfad }));
  return r.ok ? JSON.parse(r.text).rev : null;
}
async function dbxLaden(rev) {
  const r = await dbxAufruf('https://content.dropboxapi.com/2/files/download', { 'Dropbox-API-Arg': JSON.stringify({ path: 'rev:' + rev }) });
  if (!r.ok) throw new Error('Datei konnte nicht geladen werden');
  return JSON.parse(r.text);
}
async function dbxSpeichern(pfad, text, rev) {
  const arg = { path: pfad, mode: rev ? { '.tag': 'update', update: rev } : 'add', autorename: false, mute: true, strict_conflict: true };
  const r = await dbxAufruf('https://content.dropboxapi.com/2/files/upload',
    { 'Dropbox-API-Arg': JSON.stringify(arg), 'Content-Type': 'application/octet-stream' }, new TextEncoder().encode(text));
  return r.ok ? JSON.parse(r.text).rev : null;   // null = anderes Handy war schneller -> nochmal abgleichen
}

// ---------- Abgleich ----------
let syncLaeuft = false, syncNochmal = false, syncTimer = null, renderOffen = false, syncFehler = '';

function planeSync(ms) {
  if (!lokal.dbx) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, ms);
}

async function sync() {
  if (!lokal.dbx) return;
  if (syncLaeuft) { syncNochmal = true; return; }
  syncLaeuft = true;
  setzeStatus('laeuft');
  try {
    await syncBenutzer();
    if (aktiverBenutzer()) await syncKonto();
    lokal.letzter = Date.now();
    saveLokal();
    syncFehler = '';
    setzeStatus('ok');
  } catch (e) {
    syncFehler = e.auth ? 'Dropbox-Zugang abgelaufen – bitte neu verbinden' : (navigator.onLine === false ? 'Kein Internet' : e.message);
    setzeStatus('fehler');
  } finally {
    syncLaeuft = false;
    const offen = lokal.bDirty || (lokal.aktiv && km().dirty);
    if (syncNochmal || (offen && !syncFehler)) { syncNochmal = false; planeSync(1500); }
  }
}

// Stunden des angemeldeten Benutzers mit seiner Datei abgleichen
async function syncKonto() {
  const pfad = dbxDatei(), id = lokal.aktiv, meta = km();
  for (let runde = 0; runde < 5; runde++) {
    const rev = await dbxRev(pfad);
    if (lokal.aktiv !== id) return;                                     // inzwischen abgemeldet
    if (rev && rev === meta.rev && !meta.dirty) break;                  // nichts Neues, nichts zu senden
    const fern = rev ? await dbxLaden(rev) : null;
    if (lokal.aktiv !== id) return;
    const fernDaten = fern && fern.months && typeof fern.months === 'object'
      ? { settings: Object.assign(standardSettings(), fern.settings || {}), months: fern.months } : null;
    // Ab hier ohne Unterbrechung: lokalen und fernen Stand zusammenführen
    const stand = aenderungen;
    if (fernDaten) stempeln(fernDaten);
    const gemischt = fernDaten ? mischeDaten(data, fernDaten) : data;
    const gemischtText = kanonText(gemischt);
    if (gemischtText !== kanonText(data)) {
      data = gemischt;
      saveLokal();
      nachFremdAenderung();
    }
    if (fernDaten && gemischtText === kanonText(fernDaten)) {          // Dropbox ist schon aktuell
      meta.rev = rev;
      meta.dirty = aenderungen !== stand;
      break;
    }
    const neuRev = await dbxSpeichern(pfad, JSON.stringify({ v: 1, settings: gemischt.settings, months: echteMonate(gemischt.months) }), rev);
    if (neuRev) {
      meta.rev = neuRev;
      meta.dirty = aenderungen !== stand;
      break;
    }
  }
}

// Benutzerliste abgleichen (pro Benutzer gewinnt der neuere Zeitstempel; Löschen = del)
function mischeBenutzer(a, b) {
  const m = new Map();
  [...a, ...b].forEach((u) => { const x = m.get(u.id); if (!x || (u.t || 0) > (x.t || 0)) m.set(u.id, u); });
  return [...m.values()].sort((x, y) => (x.id === 'u0' ? -1 : y.id === 'u0' ? 1 : x.name.localeCompare(y.name, 'de')));
}
const benutzerText = (l) => JSON.stringify(kanon(l));
async function syncBenutzer() {
  for (let runde = 0; runde < 5; runde++) {
    const rev = await dbxRev(DBX_BENUTZER);
    if (rev && rev === lokal.bRev && !lokal.bDirty) return;
    if (!rev && !benutzer.length) return;                              // noch niemand angelegt
    const fern = rev ? ((await dbxLaden(rev)).liste || []) : [];
    const gemischt = mischeBenutzer(benutzer, fern);
    const text = benutzerText(gemischt);
    if (text !== benutzerText(benutzer)) {
      benutzer = gemischt;
      saveLokal();
      nachBenutzerAenderung();
    }
    if (rev && text === benutzerText(fern)) { lokal.bRev = rev; lokal.bDirty = false; return; }
    const neuRev = await dbxSpeichern(DBX_BENUTZER, JSON.stringify({ v: 1, liste: gemischt }), rev);
    if (neuRev) { lokal.bRev = neuRev; lokal.bDirty = false; return; }
  }
}
function nachBenutzerAenderung() {
  if (lokal.aktiv && !aktiverBenutzer()) { abmelden(true); return; }   // eigener Benutzer wurde entfernt
  if (!$('login').hidden && !loginWahl) zeigeLogin();   // nicht, während eine PIN getippt wird
  if (!$('settings').hidden) ladeEinstellungen();
  if (lokal.aktiv) zeigeKopfName();
}

// Daten kamen vom anderen Handy: neu zeichnen – aber nicht, während gerade getippt wird (Tastatur würde zugehen)
const tipptGerade = () => { const a = document.activeElement; return !!a && a.tagName === 'INPUT'; };
function nachFremdAenderung() {
  if (tipptGerade()) { renderOffen = true; return; }
  zeichneNeu();
}
function zeichneNeu() {
  render();
  if (aktTag != null && !$('editor').hidden) {
    const t = monat().days[aktTag] || {};
    FELDER.forEach((f) => ($('ed_' + f.k).value = t[f.k] || ''));
    $('ed_u').value = t.u || '';
  }
  if (!$('settings').hidden) ladeEinstellungen();
}

function setzeStatus(s) {
  const b = $('syncBtn');
  b.hidden = s === 'aus';
  b.textContent = { ok: '✓', laeuft: '↻', fehler: '!' }[s] || '';
  b.className = 'nav sync ' + s;
  if (!$('settings').hidden) zeigeDropbox();
  if (!$('login').hidden && !loginWahl) zeigeLogin();
}
function zeigeDropbox() {
  const an = !!lokal.dbx;
  $('dbxAus').style.display = an ? 'none' : '';
  $('dbxAn').style.display = an ? '' : 'none';
  if (!an) { bereitePkce(); return; }
  const zeit = lokal.letzter ? new Date(lokal.letzter).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '–';
  $('dbxStatus').textContent = syncFehler ? `⚠ ${syncFehler}` : (syncLaeuft ? 'Abgleich läuft …' : `Verbunden ✓ – letzter Abgleich ${zeit} Uhr`);
}
window.onAppResume = () => planeSync(300);

// ---------- Benutzer & Anmeldung (PIN) ----------
// Die PIN ist ein Sichtschutz zwischen Kollegen, kein Tresor: alle teilen sich dasselbe Dropbox-Konto.
// Eigenes SHA-256 statt crypto.subtle, weil das in der Android-App (file://) fehlen kann und alle Geräte gleich rechnen müssen.
const ror = (x, n) => (x >>> n) | (x << (32 - n));
function sha256(text) {
  const K = sha256.K || (sha256.K = (() => {
    const k = [], prim = [];
    for (let n = 2; prim.length < 64; n++) if (prim.every((p) => n % p)) { prim.push(n); k.push(((Math.cbrt(n) % 1) * 4294967296) | 0); }
    return k;
  })());
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const b = new TextEncoder().encode(text);
  const len = (b.length + 72) & ~63;
  const m = new Uint8Array(len);
  m.set(b);
  m[b.length] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(len - 4, b.length * 8);
  const w = new Array(64);
  for (let o = 0; o < len; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, bb, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    [a, bb, c, d, e, f, g, h].forEach((x, i) => (H[i] = (H[i] + x) | 0));
  }
  return H.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}
function pinHash(salt, pin) {
  let h = salt + ':' + pin;
  for (let i = 0; i < 300; i++) h = sha256(h + salt);
  return h;
}
const gueltigePin = (p) => /^\d{4,8}$/.test(p);

// Benutzer anlegen bzw. PIN setzen (lokal; Dropbox gleicht beim nächsten Abgleich ab)
function neuerBenutzer(name, pin, { id, admin = false, datei = '' } = {}) {
  id = id || 'u' + Date.now().toString(36) + zufall(4).replace(/[^a-zA-Z0-9]/g, 'x').toLowerCase();
  const salt = zufall(16);
  const u = { id, name, salt, hash: pinHash(salt, pin), admin, datei: datei || `/stundenzettel-${id}.json`,
    mail: data.settings.email || '', t: Date.now() };
  benutzer = mischeBenutzer(benutzer, [u]);
  lokal.bDirty = true;
  saveLokal();
  planeSync(300);
  return u;
}
function setzePin(id, pin) {
  const u = benutzer.find((x) => x.id === id);
  u.salt = zufall(16);
  u.hash = pinHash(u.salt, pin);
  u.t = Date.now();
  lokal.bDirty = true;
  saveLokal();
  planeSync(300);
}

// Kleiner Dialog für Name + PIN. Ergebnis: { name, pin } oder null
function pinDialog({ titel, mitName = false, name = '', knopf = 'Speichern', hinweis = '' }) {
  return new Promise((fertig) => {
    $('pdTitel').textContent = titel;
    $('pdNameWrap').hidden = !mitName;
    $('pdName').value = name;
    $('pdPin').value = '';
    $('pdPin2').value = '';
    $('pdHinweis').textContent = hinweis;
    $('pdOk').textContent = knopf;
    $('pinDlg').hidden = false;
    setTimeout(() => (mitName && !name ? $('pdName') : $('pdPin')).focus(), 50);
    const ende = (wert) => { $('pinDlg').hidden = true; $('pdOk').onclick = $('pdAbbr').onclick = null; fertig(wert); };
    $('pdAbbr').onclick = () => ende(null);
    $('pdOk').onclick = () => {
      const n = $('pdName').value.trim(), p = $('pdPin').value.trim();
      if (mitName && !n) { toast('Bitte einen Namen eintragen'); return; }
      if (mitName && benutzer.some((u) => !u.del && u.name.toLowerCase() === n.toLowerCase() && u.name !== name)) { toast('Diesen Namen gibt es schon'); return; }
      if (!gueltigePin(p)) { toast('Die PIN muss 4 bis 8 Ziffern haben'); return; }
      if (p !== $('pdPin2').value.trim()) { toast('Die beiden PINs sind nicht gleich'); return; }
      ende({ name: n, pin: p });
    };
  });
}

// --- Anmeldebildschirm ---
let loginWahl = null, fehlversuche = 0, gesperrtBis = 0;

function zeigeLogin() {
  $('login').hidden = false;
  document.body.style.overflow = 'hidden';   // Hauptseite dahinter nicht mitscrollen
  const liste = benutzer.filter((u) => !u.del);
  const altU0 = konten.u0 && !benutzer.some((u) => u.id === 'u0');   // Daten aus 1.4, aber noch keine PIN
  $('lgListe').hidden = $('lgPin').hidden = $('lgErst').hidden = true;
  if (loginWahl && !liste.some((u) => u.id === loginWahl)) loginWahl = null;

  if (loginWahl) {
    const u = liste.find((x) => x.id === loginWahl);
    $('lgPinName').textContent = u.name;
    $('lgPin').hidden = false;
    $('lgPinFeld').value = '';
    setTimeout(() => $('lgPinFeld').focus(), 50);
  } else if (liste.length) {
    $('lgListe').hidden = false;
    $('lgNamen').innerHTML = liste.map((u) => `<button data-u="${esc(u.id)}">${esc(u.name)}</button>`).join('');
    $('lgNamen').querySelectorAll('button').forEach((b) => (b.onclick = () => { loginWahl = b.dataset.u; zeigeLogin(); }));
  } else {
    $('lgErst').hidden = false;
    const laedt = lokal.dbx && !lokal.letzter && syncLaeuft;
    $('lgErstText').textContent = laedt ? 'Benutzer werden aus Dropbox geladen …'
      : altU0 ? 'Neu: Die App hat jetzt Benutzer mit PIN. Lege für dich eine PIN fest – deine bisherigen Stunden bleiben erhalten.'
      : lokal.dbx ? 'Noch kein Benutzer angelegt. Lege dich als ersten Benutzer an – du bist dann Admin und kannst weitere Benutzer anlegen.'
      : 'Hast du schon einen Benutzer (z. B. auf dem Handy)? Dann zuerst mit Dropbox verbinden – danach erscheint dein Name und du meldest dich mit deiner PIN an.';
    // Ohne Dropbox ist „verbinden“ fast immer richtig; „neu anfangen“ nur, wenn es noch niemanden gibt
    const nurDbx = !lokal.dbx && !altU0;
    $('lgErstDbx').parentElement.hidden = !nurDbx;
    $('lgErstKnopf').hidden = !!laedt;
    $('lgErstKnopf').className = nurDbx ? '' : 'primary';
    $('lgErstKnopf').textContent = altU0 ? 'PIN festlegen' : nurDbx ? 'Noch niemand angelegt: ersten Benutzer anlegen' : 'Ersten Benutzer anlegen';
  }
  $('lgDbx').textContent = lokal.dbx ? 'Dropbox verbunden ✓' : 'Dropbox verbinden';
}

async function ersterBenutzer() {
  // Mit Dropbox erst nachsehen, ob es dort schon Benutzer gibt – sonst entstünde ein zweiter Admin
  if (lokal.dbx) {
    $('lgErstKnopf').disabled = true;
    lokal.bRev = null;
    while (syncLaeuft) await new Promise((r) => setTimeout(r, 200));   // laufenden Abgleich abwarten
    await sync();
    $('lgErstKnopf').disabled = false;
    if (syncFehler) { alert('Dropbox ist gerade nicht erreichbar (' + syncFehler + '). Bitte mit Internet noch einmal versuchen.'); return; }
    if (benutzer.some((u) => !u.del)) { zeigeLogin(); return; }
  }
  const altU0 = konten.u0 && !benutzer.some((u) => u.id === 'u0');
  const vorschlag = altU0 ? (konten.u0.settings || {}).name || '' : '';
  const r = await pinDialog({ titel: altU0 ? 'PIN festlegen' : 'Ersten Benutzer anlegen', mitName: true, name: vorschlag, knopf: 'Anlegen',
    hinweis: 'Die PIN brauchst du beim Öffnen der App (außer bei „Angemeldet bleiben“).' });
  if (!r) return;
  // Admin übernimmt die alte Datei /stundenzettel.json – nur wenn es hier alte Daten gibt oder Dropbox schon verbunden ist.
  // Ohne Dropbox bekommt ein neues Gerät eine eigene ID, damit es später keine fremden Daten überschreibt.
  const u0 = altU0 || lokal.dbx;
  const u = neuerBenutzer(r.name, r.pin, { id: u0 ? 'u0' : '', admin: true, datei: u0 ? '/stundenzettel.json' : '' });
  if (altU0 && !konten.u0.settings.name) konten.u0.settings.name = r.name;
  anmelden(u.id, true);
}

function pruefeLogin() {
  const u = benutzer.find((x) => x.id === loginWahl && !x.del);
  if (!u) return;
  if (Date.now() < gesperrtBis) { toast(`Zu viele Fehlversuche – bitte ${Math.ceil((gesperrtBis - Date.now()) / 1000)} s warten`); return; }
  const p = $('lgPinFeld').value.trim();
  if (pinHash(u.salt, p) !== u.hash) {
    fehlversuche++;
    if (fehlversuche >= 5) { gesperrtBis = Date.now() + 30000; fehlversuche = 0; }
    $('lgPinFeld').value = '';
    toast('PIN falsch');
    return;
  }
  fehlversuche = 0;
  anmelden(u.id, $('lgBleiben').checked);
}

function anmelden(id, bleiben) {
  const u = benutzer.find((x) => x.id === id);
  lokal.aktiv = id;
  lokal.bleiben = !!bleiben;
  if (!konten[id]) konten[id] = { settings: { name: u.name, email: u.mail || '', cc: '', t: 0 }, months: {} };
  data = konten[id];
  data.settings = Object.assign(standardSettings(), data.settings);
  data.months = data.months || {};
  stempeln(data);
  saveLokal();
  loginWahl = null;
  $('login').hidden = true;
  document.body.style.overflow = '';
  $('settings').hidden = true;
  cur = { y: heute.getFullYear(), m: heute.getMonth() };
  render();
  const h = document.querySelector('#tage li.heute');
  if (h) h.scrollIntoView({ block: 'center' });
  else window.scrollTo(0, 0);
  setzeStatus(lokal.dbx ? 'ok' : 'aus');
  planeSync(300);
}

async function abmelden(erzwungen) {
  if (!lokal.aktiv) return;
  if (!$('editor').hidden) zeige('editor', false);
  if (lokal.dbx && km().dirty && !erzwungen) { try { await sync(); } catch (e) { /* bleibt markiert, wird später nachgeholt */ } }
  saveLokal();
  lokal.aktiv = null;
  data = { settings: { name: '', email: '', cc: '' }, months: {} };
  saveLokal();
  $('settings').hidden = true;
  zeigeLogin();
  if (erzwungen) toast('Dein Benutzer wurde vom Admin entfernt');
}

// Name im Kopf, sobald es mehr als einen Benutzer gibt
function zeigeKopfName() {
  const u = aktiverBenutzer();
  $('kopfName').textContent = u && benutzer.filter((x) => !x.del).length > 1 ? u.name : '';
}

// --- Benutzer in den Einstellungen ---
function zeigeBenutzerTeil() {
  const ich = aktiverBenutzer();
  $('kontoTeil').hidden = !ich;
  if (!ich) return;
  $('benIch').textContent = ich.name + (ich.admin ? ' (Admin)' : '');
  $('adminTeil').hidden = !ich.admin;
  if (!ich.admin) return;
  $('benListe').innerHTML = benutzer.filter((u) => !u.del).map((u) =>
    `<li><span>${esc(u.name)}${u.admin ? ' <small>Admin</small>' : ''}</span>` +
    `<button data-pin="${esc(u.id)}">PIN neu</button>` +
    (u.id === ich.id ? '' : `<button data-weg="${esc(u.id)}">Entfernen</button>`) + '</li>').join('');
  $('benListe').querySelectorAll('[data-pin]').forEach((b) => (b.onclick = async () => {
    const u = benutzer.find((x) => x.id === b.dataset.pin);
    const r = await pinDialog({ titel: `Neue PIN für ${u.name}`, knopf: 'PIN setzen' });
    if (r) { setzePin(u.id, r.pin); toast(`PIN für ${u.name} geändert`); }
  }));
  $('benListe').querySelectorAll('[data-weg]').forEach((b) => (b.onclick = () => {
    const u = benutzer.find((x) => x.id === b.dataset.weg);
    if (!confirm(`${u.name} entfernen? Die Anmeldung ist dann nicht mehr möglich. Die Stunden bleiben in der Dropbox gespeichert.`)) return;
    u.del = true;
    u.t = Date.now();
    lokal.bDirty = true;
    saveLokal();
    planeSync(300);
    zeigeBenutzerTeil();
    zeigeKopfName();
  }));
}

// ---------- Ereignisse ----------
function init() {
  baueEditor();

  $('prev').onclick = () => { if (leererMonat(monat())) delete data.months[key(cur.y, cur.m)]; cur.m--; if (cur.m < 0) { cur.m = 11; cur.y--; } render(); };
  $('next').onclick = () => { if (leererMonat(monat())) delete data.months[key(cur.y, cur.m)]; cur.m++; if (cur.m > 11) { cur.m = 0; cur.y++; } render(); };
  $('baustelle').oninput = (e) => { const mo = monat(); mo.baustelle = e.target.value; mo.t = Date.now(); save(); };
  $('blatt').oninput = (e) => { const mo = monat(); mo.blatt = e.target.value; mo.t = Date.now(); save(); };

  document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => zeige(b.closest('.backdrop').id, false)));
  document.querySelectorAll('.backdrop:not(.dlg)').forEach((bd) => bd.addEventListener('click', (e) => { if (e.target === bd) zeige(bd.id, false); }));

  document.querySelectorAll('[data-set]').forEach((b) => (b.onclick = () => {
    const was = b.dataset.set;
    if (was === 'urlaub') setzeFelder({ n: 'Urlaub' });
    else if (was === 'krank') setzeFelder({ n: 'Krank' });
    else if (was === 'leer') setzeFelder({});
    else if (was === 'kopie') {
      const t = letzterArbeitstag(aktTag);
      if (t) { setzeFelder(Object.assign({}, t)); toast('Vom letzten Arbeitstag übernommen'); }
      else toast('Kein früherer Arbeitstag gefunden');
    }
  }));
  $('edPrev').onclick = () => wechsleTag(-1);
  $('edNext').onclick = () => wechsleTag(1);

  $('settingsBtn').onclick = () => { ladeEinstellungen(); zeige('settings', true); };
  $('setName').oninput = (e) => { data.settings.name = e.target.value; data.settings.t = Date.now(); save(); };
  $('setMail').oninput = (e) => { data.settings.email = e.target.value.trim(); data.settings.t = Date.now(); save(); };
  $('setCc').oninput = (e) => { data.settings.cc = e.target.value.trim(); data.settings.t = Date.now(); save(); };
  $('syncBtn').onclick = () => { ladeEinstellungen(); zeige('settings', true); };
  $('dbxStart').onclick = dbxAnmelden;
  $('dbxVerbinden').onclick = dbxVerbinden;
  $('dbxTrennen').onclick = dbxTrennen;
  $('dbxJetzt').onclick = () => { lokal.bRev = null; if (lokal.aktiv) km().rev = null; sync(); };
  // Aufgeschobenes Neuzeichnen nachholen, sobald nicht mehr getippt wird
  document.addEventListener('focusout', () => setTimeout(() => {
    if (renderOffen && !tipptGerade()) { renderOffen = false; zeichneNeu(); }
  }, 250));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) planeSync(300); });
  setInterval(() => { if (!document.hidden) sync(); }, 30000);
  // Web-App (iPhone/PC): Offline-Betrieb. In der Android-App (file://) nicht nötig.
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});

  // Anmeldung
  $('lgPinFeld').addEventListener('keydown', (e) => { if (e.key === 'Enter') pruefeLogin(); });
  $('lgOk').onclick = pruefeLogin;
  $('lgZurueck').onclick = () => { loginWahl = null; zeigeLogin(); };
  $('lgErstKnopf').onclick = ersterBenutzer;
  $('lgDbx').onclick = $('lgErstDbx').onclick = () => { ladeEinstellungen(); zeige('settings', true); };
  $('abmelden').onclick = () => abmelden(false);
  $('pinAendern').onclick = async () => {
    const r = await pinDialog({ titel: 'Eigene PIN ändern', knopf: 'PIN ändern' });
    if (r) { setzePin(lokal.aktiv, r.pin); toast('PIN geändert'); }
  };
  $('benNeu').onclick = async () => {
    const r = await pinDialog({ titel: 'Neuer Benutzer', mitName: true, knopf: 'Anlegen',
      hinweis: 'Name und PIN der Person mitteilen. Auf ihrem Gerät: App öffnen, mit Dropbox verbinden, Namen antippen, PIN eingeben.' });
    if (!r) return;
    neuerBenutzer(r.name, r.pin);
    zeigeBenutzerTeil();
    zeigeKopfName();
    toast(`${r.name} angelegt`);
  };

  setzeStatus(lokal.dbx ? 'ok' : 'aus');
  if (lokal.aktiv && lokal.bleiben && benutzer.some((u) => u.id === lokal.aktiv && !u.del)) anmelden(lokal.aktiv, true);
  else { lokal.aktiv = null; zeigeLogin(); planeSync(300); }
  $('backupBtn').onclick = backupTeilen;
  $('restoreBtn').onclick = () => $('restoreFile').click();
  $('restoreFile').onchange = (e) => { if (e.target.files[0]) backupLaden(e.target.files[0]); e.target.value = ''; };

  $('pdfBtn').onclick = async () => {
    const b = $('pdfBtn');
    b.disabled = true;
    b.textContent = 'PDF wird erstellt …';
    try { await pdfSenden(); } catch (e) { alert('PDF-Fehler: ' + e.message); }
    b.disabled = false;
    b.textContent = 'PDF erstellen & senden';
  };

  $('vorschauBtn').onclick = () => zeigeVorschau().catch((e) => alert('Vorschau-Fehler: ' + e.message));
  document.querySelectorAll('[data-vclose]').forEach((b) => (b.onclick = schliesseVorschau));
  $('vBild').addEventListener('click', vorschauZoom);
  $('vSenden').onclick = async () => {
    const b = $('vSenden');
    b.disabled = true;
    try { await pdfSenden(); } catch (e) { alert('PDF-Fehler: ' + e.message); }
    b.disabled = false;
  };

}

// ---------- PDF-Vorschau ----------
async function zeigeVorschau() {
  if (!LOGO.complete) await new Promise((r) => { LOGO.onload = LOGO.onerror = r; });
  const SCALE = 2;
  const c = document.createElement('canvas');
  c.width = Math.round(A4W * SCALE);
  c.height = Math.round(A4H * SCALE);
  const ctx = c.getContext('2d');
  ctx.scale(SCALE, SCALE);
  zeichneBlatt(ctx, cur.y, cur.m);
  $('vBild').src = c.toDataURL('image/jpeg', 0.85);
  $('vTitel').textContent = `${MONATE[cur.m]} ${cur.y}`;
  $('vBody').classList.remove('zoom');
  $('vBody').scrollTo(0, 0);
  $('vorschau').hidden = false;
}

function schliesseVorschau() {
  $('vorschau').hidden = true;
  $('vBild').removeAttribute('src');
}

// Tippen: an der getippten Stelle hinein- bzw. wieder herauszoomen
function vorschauZoom(e) {
  const body = $('vBody'), bild = $('vBild');
  if (body.classList.contains('zoom')) { body.classList.remove('zoom'); return; }
  const r = bild.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
  body.classList.add('zoom');
  const r2 = bild.getBoundingClientRect();
  body.scrollLeft = fx * r2.width - body.clientWidth / 2;
  body.scrollTop = fy * r2.height - body.clientHeight / 2;
}

init();
