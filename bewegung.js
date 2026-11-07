// Bewegung nach den Skills „apple-design“ / „emil-design-eng“ – gleiche Datei in Stundenzettel und Fremdfirmen.
// Sofortige Druck-Rückmeldung, Blätter fahren mit der iOS-Kurve rein/raus und lassen sich am Griff wegziehen,
// durchscheinender Kopf, Toast von unten, Seitenwechsel in Pfeil-/Navigationsrichtung. Nur transform/opacity, alles < 400 ms.
// Dazu (nur Stundenzettel) die Weihnachtsdeko: Mütze aufs J + leiser Schnee im Kopf.
(function () {
  'use strict';
  const ruhig = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';

  const css = `
  :root { --ease-out: ${EASE_OUT}; --ease-drawer: cubic-bezier(0.32, 0.72, 0, 1); }
  /* Druck: sofort, kurz */
  button, .klick, .firma, .archivzeile, .lgnamen button { transition: transform 120ms var(--ease-out); }
  button:active, .lgnamen button:active { transform: scale(0.97); }
  .klick:active, .firma:active, .archivzeile:active, #tage li:not(:has(input)):active { transform: scale(0.985); }
  #tage li:not(:has(input)) { transition: transform 120ms var(--ease-out); }
  /* Kopf als Material: Inhalt läuft unscharf darunter */
  header { background: rgba(255,255,255,.78) !important; -webkit-backdrop-filter: blur(18px) saturate(180%); backdrop-filter: blur(18px) saturate(180%); }
  /* Zahlen springen nicht */
  .kachel .z, .summe .h, .firma .zahlen b, .liste .rechts .h, .tag b, #monat { font-variant-numeric: tabular-nums; }
  .kachel .z, .summe .h, .firma .zahlen b { letter-spacing: -0.02em; }
  /* Blätter: Hintergrund blendet, Blatt fährt mit der iOS-Kurve – raus auf demselben Weg */
  .backdrop { background: rgba(0,0,0,0) !important; transition: background-color 300ms var(--ease-out); }
  .backdrop.auf { background: rgba(0,0,0,.35) !important; }
  .backdrop:not(.auf) { pointer-events: none; }
  .backdrop .sheet { transform: translateY(100%); transition: transform 380ms var(--ease-drawer); }
  .backdrop.auf .sheet { transform: none; }
  .sheet .griff { width: 40px; height: 5px; border-radius: 3px; background: #d1d5db; margin: -4px auto 10px; cursor: grab; touch-action: none; }
  .sheet > h2 { touch-action: none; }
  /* Toast kommt von unten und geht dorthin zurück */
  #toast { transform: translate(-50%, 14px) !important; transition: opacity 240ms var(--ease-out), transform 240ms var(--ease-out) !important; }
  #toast.show { transform: translate(-50%, 0) !important; }
  /* Weihnachten */
  .logobox { position: relative; display: block; flex: none; cursor: pointer; }
  .logobox img { display: block; }
  .muetze { position: absolute; width: 20%; left: 20.5%; top: -30%; pointer-events: none; transform-origin: 35% 85%; transform: rotate(-20deg); }
  .wackeln .muetze { animation: muetzeWackeln 700ms var(--ease-out); }
  @keyframes muetzeWackeln { 0%{transform:rotate(-20deg)} 25%{transform:rotate(-30deg)} 50%{transform:rotate(-13deg)} 75%{transform:rotate(-22deg)} 100%{transform:rotate(-20deg)} }
  .schnee { position: absolute; inset: 0 0 -3px 0; overflow: hidden; pointer-events: none; z-index: 0; }
  .schnee i { position: absolute; top: -8px; border-radius: 50%; background: #9ccfd3; opacity: .55; animation: schneeFallen linear infinite; }
  .schnee i.stern { background: none; color: #7cc4c9; font-style: normal; line-height: 1; opacity: .6; }
  @keyframes schneeFallen { from { transform: translate(0, -10px); } to { transform: translate(var(--dx), 110px); } }
  header > .hrow, header > .mrow { position: relative; z-index: 1; }
  .weihnachtszeit header > .hrow { padding-top: 15px; }   /* Platz für die Mütze über dem Logo */
  @media (prefers-reduced-motion: reduce) {
    .backdrop .sheet { transition: none; }
    button:active, .klick:active, .firma:active, #tage li:active { transform: none !important; }
    .schnee { display: none; } .wackeln .muetze { animation: none; }
  }`;
  document.head.appendChild(Object.assign(document.createElement('style'), { textContent: css }));

  // ---- Blätter: hidden-Eigenschaft animiert (die App-Logik setzt weiter einfach .hidden) ----
  function blatt(el) {
    const sheet = el.querySelector('.sheet');
    if (!sheet || el._bewegt) return;
    el._bewegt = true;
    let zu = el.hasAttribute('hidden'), timer = null;
    if (!zu) el.classList.add('auf');
    Object.defineProperty(el, 'hidden', {
      configurable: true,
      get: () => zu,
      set: (v) => {
        v = !!v;
        if (v === zu) return;
        zu = v;
        clearTimeout(timer);
        sheet.style.transform = '';
        if (!v) {
          el.removeAttribute('hidden');
          void el.offsetWidth;                         // Startzustand festhalten, dann reinfahren
          el.classList.add('auf');
        } else {
          el.classList.remove('auf');
          timer = setTimeout(() => { if (zu) el.setAttribute('hidden', ''); }, ruhig() ? 0 : 400);
        }
      },
    });
    // Griff oben: Blatt folgt dem Finger 1:1, schneller Wisch oder weit genug nach unten = zu
    sheet.insertAdjacentHTML('afterbegin', '<div class="griff"></div>');
    let zug = null;
    sheet.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('.griff, .sheet > h2') || e.target.closest('button, input, select, textarea')) return;
      zug = { y0: e.clientY, spur: [[e.clientY, performance.now()]], id: e.pointerId };
      sheet.setPointerCapture(e.pointerId);
      sheet.style.transition = 'none';
    });
    sheet.addEventListener('pointermove', (e) => {
      if (!zug || e.pointerId !== zug.id) return;
      let dy = e.clientY - zug.y0;
      if (dy < 0) dy = -(-dy * 0.55 * 300) / (300 + 0.55 * -dy);   // nach oben: Gummiband
      sheet.style.transform = `translateY(${dy}px)`;
      zug.spur.push([e.clientY, performance.now()]);
      if (zug.spur.length > 5) zug.spur.shift();
    });
    const loslassen = (e) => {
      if (!zug || e.pointerId !== zug.id) return;
      const a = zug.spur[0], b = zug.spur[zug.spur.length - 1];
      const tempo = ((b[0] - a[0]) / Math.max(1, b[1] - a[1])) * 1000;   // px/s
      const dy = e.clientY - zug.y0;
      zug = null;
      sheet.style.transition = '';
      if (dy > 120 || tempo > 600) {
        const zuKnopf = el.querySelector('[data-close], #pdAbbr');
        if (zuKnopf) zuKnopf.click(); else el.hidden = true;
      }
      sheet.style.transform = '';
    };
    sheet.addEventListener('pointerup', loslassen);
    sheet.addEventListener('pointercancel', loslassen);
  }

  // ---- Inhalt kommt aus der Richtung, in die man geht (1 = von rechts, -1 = von links) ----
  function rein(els, richtung, weg = 28) {
    if (!richtung || ruhig()) return;
    [].concat(els).forEach((el) => {
      if (!el || !el.animate) return;
      el.animate([{ transform: `translateX(${richtung * weg}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }],
        { duration: 240, easing: EASE_OUT });
    });
  }

  // ---- Weihnachten: 1. Dezember bis 6. Januar, jedes Jahr von selbst ----
  function istWeihnachtszeit(d = new Date()) {
    if (/[?&]weihnachten=1/.test(location.search)) return true;   // zum Testen
    return d.getMonth() === 11 || (d.getMonth() === 0 && d.getDate() <= 6);
  }
  const MUETZE = `<svg class="muetze" viewBox="0 0 100 80" aria-hidden="true">
    <path d="M10 62 C 18 34, 40 14, 66 10 C 80 8, 90 14, 88 24 C 78 22, 70 28, 66 38 C 62 48, 64 56, 70 62 Z" fill="#d42a33"/>
    <path d="M40 60 C 44 40, 54 26, 66 22 C 72 20, 80 20, 86 22 C 78 24, 70 30, 66 38 C 62 48, 64 56, 70 62 Z" fill="#a91d26" opacity=".55"/>
    <rect x="2" y="56" width="76" height="16" rx="8" fill="#fff" stroke="#d1d5db" stroke-width="1.5"/>
    <circle cx="86" cy="24" r="9" fill="#fff" stroke="#d1d5db" stroke-width="1.5"/></svg>`;
  function weihnachten(kopf) {
    if (!istWeihnachtszeit()) return;
    document.body.classList.add('weihnachtszeit');
    document.querySelectorAll('img.jlogo').forEach((img) => {
      if (img.parentElement.classList.contains('logobox')) return;
      const box = document.createElement('span');
      box.className = 'logobox';
      box.title = 'Frohe Weihnachten!';
      img.replaceWith(box);
      box.appendChild(img);
      box.insertAdjacentHTML('beforeend', MUETZE);
      box.addEventListener('click', () => { box.classList.remove('wackeln'); void box.offsetWidth; box.classList.add('wackeln'); });
    });
    if (!kopf || kopf.querySelector('.schnee')) return;
    const schnee = document.createElement('div');
    schnee.className = 'schnee';
    for (let i = 0; i < 16; i++) {
      const f = document.createElement('i'), stern = i % 5 === 0, g = stern ? 9 + Math.random() * 3 : 2 + Math.random() * 3;
      if (stern) { f.className = 'stern'; f.textContent = '❄'; f.style.fontSize = g + 'px'; } else { f.style.width = f.style.height = g + 'px'; }
      f.style.left = Math.random() * 100 + '%';
      f.style.setProperty('--dx', (Math.random() * 24 - 12) + 'px');
      f.style.animationDuration = (7 + Math.random() * 6) + 's';
      f.style.animationDelay = (-Math.random() * 12) + 's';
      schnee.appendChild(f);
    }
    kopf.prepend(schnee);
  }

  document.querySelectorAll('.backdrop').forEach(blatt);
  window.Bewegung = { rein, weihnachten, istWeihnachtszeit };
})();
