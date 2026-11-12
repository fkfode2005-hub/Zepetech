// jeux.js : salon de jeux de ZEPE TECH (compatible CSP : aucun script inline)
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const RATE = 0.08;
  let rewards = { dames: 10, aviatorMax: 20, aviatorPerX: 5, footMin: 3, footMax: 20 };

  async function api(path, method = 'GET', body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { showLogin(); throw new Error('Connecte-toi pour jouer.'); }
    if (!res.ok) throw new Error(data.error || 'Erreur');
    return data;
  }
  function showLogin() {
    $('#lobby').hidden = true; $('#game').hidden = true; $('#login').hidden = false;
  }
  function setStatus(el, text, kind) { el.textContent = text; el.className = 'status' + (kind ? ' ' + kind : ''); }
  function wallet(d) {
    if (!d || d.coins === undefined) return;
    document.querySelectorAll('.coinval').forEach(e => { e.textContent = d.coins; });
    $('#eyebrow').textContent = `Plafond du jour : ${d.earnedToday}/${d.dailyCoinCap} coins gagnés`;
  }
  const rewardText = r => (!r ? '' : r.gain > 0 ? ` +${r.gain} coins${r.capped ? ' (plafond du jour atteint)' : ''}` : " Plafond du jour atteint : plus de coins aujourd'hui.");

  // =====================================================================
  //  Salon
  // =====================================================================
  const KEY = 'zepe_last_game';
  const lastGame = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const remember = id => { try { localStorage.setItem(KEY, id); } catch {} };

  const uid = (() => { let n = 0; return () => 'g' + ++n; })();
  const artAviator = () => {
    const i = uid();
    return `<svg viewBox="0 0 400 160" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs><filter id="${i}"><feGaussianBlur stdDeviation="4"/></filter></defs>
      <path d="M30 142 C140 141 230 124 290 72" fill="none" stroke="#22c55e" stroke-width="9" stroke-linecap="round" filter="url(#${i})" opacity=".65"/>
      <path d="M30 142 C140 141 230 124 290 72" fill="none" stroke="#4ade80" stroke-width="4" stroke-linecap="round"/>
      <text x="278" y="66" font-size="30">✈️</text></svg>`;
  };
  const artDames = () => {
    let s = '<svg viewBox="0 0 400 160" preserveAspectRatio="xMidYMid slice" aria-hidden="true">';
    for (let r = 0; r < 4; r++) for (let c = 0; c < 10; c++) s += `<rect x="${c * 40}" y="${r * 40}" width="40" height="40" fill="${(r + c) % 2 ? '#3f3223' : '#7a6a4f'}" opacity=".85"/>`;
    const pcs = [[1, 0, '#26262a', '#f59e0b'], [3, 1, '#26262a', '#f59e0b'], [2, 1, '#f4efe4', '#5b4630'], [5, 2, '#f4efe4', '#5b4630'], [4, 3, '#f4efe4', '#5b4630'], [6, 0, '#26262a', '#f59e0b']];
    for (const [c, r, f] of pcs) s += `<circle cx="${c * 40 + 20}" cy="${r * 40 + 20}" r="15" fill="${f}" stroke="rgba(255,255,255,.25)" stroke-width="3"/>`;
    return s + '</svg>';
  };
  const artFoot = () => `<svg viewBox="0 0 400 160" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="400" height="160" fill="#14532d"/><rect width="400" height="160" fill="#16a34a" opacity=".25"/>
      <g fill="none" stroke="rgba(255,255,255,.55)" stroke-width="2.5"><rect x="14" y="14" width="372" height="132" rx="4"/><line x1="200" y1="14" x2="200" y2="146"/><circle cx="200" cy="80" r="28"/>
      <rect x="14" y="48" width="48" height="64"/><rect x="338" y="48" width="48" height="64"/></g>
      <text x="170" y="96" font-size="34">⚽</text></svg>`;

  const GAMES = [
    { id: 'aviator', cat: 'chance', title: 'Aviator', cta: 'Lancer le vol', art: artAviator, tag: '<small>x</small>2.47',
      desc: () => `L'avion monte, le multiplicateur aussi. Encaissez avant qu'il s'envole : jusqu'à ${rewards.aviatorMax} coins par vol.`, chips: ['Solo', 'Sans mise'] },
    { id: 'dames', cat: 'reflexion', title: 'Jeu de dames', cta: 'Lancer la partie', art: artDames, tag: '',
      desc: () => `Affrontez le bot sur un plateau 8×8. Chaque victoire rapporte ${rewards.dames} coins.`, chips: ['Contre le bot', 'Sans mise'] },
    { id: 'foot', cat: 'chance', title: 'Foot virtuel', cta: 'Lancer le match', art: artFoot, tag: '2 <small>:</small> 1',
      desc: () => `Pronostiquez un match simulé : plus le risque est grand, plus le gain l'est (de ${rewards.footMin} à ${rewards.footMax} coins).`, chips: ['Solo', 'Pronostic'] }
  ];
  const FILTERS = [['all', 'Tous les jeux'], ['reflexion', 'Réflexion'], ['chance', 'Chance']];
  let filter = 'all';

  function cardHtml(g, o) {
    const chips = g.chips.map(c => `<span class="chip">${c}</span>`).join('') + (o.last ? '<span class="chip hot">Dernière partie</span>' : '');
    return `<article class="gcard${o.featured ? ' featured' : ''}">
      <div class="art">${g.art()}${g.tag ? `<div class="tag">${g.tag}</div>` : ''}</div>
      <div class="gbody">
        ${o.kicker ? `<p class="kicker">${o.kicker}</p>` : `<div class="chips">${chips}</div>`}
        <h3>${g.title}</h3><p>${g.desc()}</p>
        <button class="play" data-go="${g.id}">${g.cta}<i aria-hidden="true">→</i></button>
      </div></article>`;
  }
  function renderLobby() {
    const last = lastGame();
    const feat = GAMES.find(g => g.id === last) || GAMES[0];
    $('#featured').innerHTML = cardHtml(feat, { featured: true, kicker: last ? 'Reprendre là où vous en étiez' : 'À la une' });
    $('#filters').innerHTML = FILTERS.map(([k, label]) => {
      const n = k === 'all' ? GAMES.length : GAMES.filter(g => g.cat === k).length;
      return `<button class="filter" data-f="${k}" aria-pressed="${k === filter}">${label}<small>${n}</small></button>`;
    }).join('');
    $('#cards').innerHTML = GAMES.filter(g => filter === 'all' || g.cat === filter).map(g => cardHtml(g, { last: g.id === last })).join('');
  }
  $('#lobby').addEventListener('click', e => {
    const go = e.target.closest('[data-go]');
    if (go) { location.hash = go.dataset.go; return; }
    const f = e.target.closest('[data-f]');
    if (f) { filter = f.dataset.f; renderLobby(); }
  });

  // =====================================================================
  //  Navigation salon <-> jeu (adresse #dames, #aviator, #foot)
  // =====================================================================
  function route() {
    if (!$('#login').hidden) return;
    const id = location.hash.slice(1);
    const g = GAMES.find(x => x.id === id);
    stopFlight();
    if (!g) {
      $('#game').hidden = true; $('#lobby').hidden = false;
      renderLobby(); window.scrollTo(0, 0);
      return;
    }
    $('#lobby').hidden = true; $('#game').hidden = false;
    ['dames', 'aviator', 'foot'].forEach(k => { $('#p-' + k).hidden = k !== id; });
    remember(id); window.scrollTo(0, 0);
    if (id === 'aviator') enterAviator();
  }
  window.addEventListener('hashchange', route);

  // =====================================================================
  //  Dames
  // =====================================================================
  let game = null, selected = null, busy = false;
  const boardEl = $('#board');

  function renderBoard() {
    boardEl.innerHTML = '';
    if (!game) return;
    const movable = new Set(game.moves.map(m => m.from));
    const dests = new Set(selected === null ? [] : game.moves.filter(m => m.from === selected).map(m => m.to));
    const botSq = new Set(game.lastBot ? [game.lastBot.from, game.lastBot.to] : []);
    for (let i = 0; i < 64; i++) {
      const r = Math.floor(i / 8), c = i % 8, p = game.board[i];
      const sq = document.createElement('div');
      sq.className = 'sq ' + ((r + c) % 2 ? 'dark' : 'light') + (i === selected ? ' sel' : '') + (botSq.has(i) ? ' bot' : '');
      sq.dataset.i = i;
      if (p) {
        const pc = document.createElement('div');
        pc.className = 'piece ' + p.toLowerCase() + (movable.has(i) && !game.over ? ' mv' : '');
        if (p === 'W' || p === 'B') pc.textContent = '♛';
        sq.appendChild(pc);
      }
      if (dests.has(i)) { const d = document.createElement('div'); d.className = 'dot'; sq.appendChild(d); }
      boardEl.appendChild(sq);
    }
  }
  function dStatusFor(res) {
    if (!game) return;
    const st = $('#dStatus');
    if (game.over) {
      if (game.result === 'win') setStatus(st, '🎉 Victoire !' + rewardText(res && res.reward), 'win');
      else if (game.result === 'loss') setStatus(st, 'Défaite. Retente ta chance !', 'loss');
      else setStatus(st, 'Match nul.');
    } else {
      setStatus(st, game.mustCapture ? 'À toi : prise obligatoire.' : 'À toi de jouer.');
    }
  }
  boardEl.addEventListener('click', async e => {
    const sqEl = e.target.closest('.sq');
    if (!sqEl || !game || game.over || busy) return;
    const i = Number(sqEl.dataset.i);
    if (game.moves.some(m => m.from === i)) { selected = i; renderBoard(); return; }
    if (selected !== null && game.moves.some(m => m.from === selected && m.to === i)) {
      busy = true;
      try {
        const res = await api('/api/games/dames/move', 'POST', { from: selected, to: i });
        game = res.game; selected = null; wallet(res); renderBoard(); dStatusFor(res);
      } catch (err) { setStatus($('#dStatus'), err.message, 'loss'); }
      busy = false;
    }
  });
  $('#dNew').addEventListener('click', async () => {
    try {
      const res = await api('/api/games/dames/new', 'POST');
      game = res.game; selected = null; wallet(res); renderBoard(); dStatusFor();
    } catch (err) { setStatus($('#dStatus'), err.message, 'loss'); }
  });

  // =====================================================================
  //  Aviator
  // =====================================================================
  const chart = $('#chart'), ctx = chart.getContext('2d');
  const multEl = $('#mult');
  let flight = null; // { t0, raf, poll }

  function sizeCanvas() {
    const r = chart.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    chart.width = Math.max(1, Math.round(r.width * dpr)); chart.height = Math.max(1, Math.round(r.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function drawCurve(t, color) {
    const w = chart.clientWidth, h = chart.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const maxT = Math.max(10, t * 1.15), maxM = Math.max(2, Math.exp(RATE * maxT));
    const X = s => 14 + (s / maxT) * (w - 28);
    const Y = s => h - 16 - ((Math.exp(RATE * s) - 1) / (maxM - 1)) * (h - 40);
    ctx.lineWidth = 4; ctx.strokeStyle = color; ctx.lineJoin = 'round'; ctx.shadowColor = color; ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.moveTo(X(0), Y(0));
    for (let k = 1; k <= 80; k++) { const s = (t * k) / 80; ctx.lineTo(X(s), Y(s)); }
    ctx.stroke(); ctx.shadowBlur = 0;
    ctx.font = '26px system-ui'; ctx.fillText('✈️', X(t) - 12, Y(t) - 8);
  }
  function stopFlight() { if (flight) { cancelAnimationFrame(flight.raf); clearInterval(flight.poll); flight = null; } }
  function resetAviatorUi() {
    multEl.className = ''; multEl.textContent = '1.00x';
    setStatus($('#aStatus'), 'Prêt au décollage.');
    $('#aStart').disabled = false; $('#aCash').disabled = true;
    if (chart.clientWidth) ctx.clearRect(0, 0, chart.clientWidth, chart.clientHeight);
  }
  function endFlight(kind, mult, text) {
    stopFlight();
    multEl.textContent = mult.toFixed(2) + 'x';
    multEl.className = kind;
    setStatus($('#aStatus'), text, kind === 'cash' ? 'win' : 'loss');
    $('#aStart').disabled = false; $('#aCash').disabled = true;
  }
  function loop() {
    if (!flight) return;
    const t = (performance.now() - flight.t0) / 1000, m = Math.floor(Math.exp(RATE * t) * 100) / 100;
    multEl.textContent = m.toFixed(2) + 'x';
    drawCurve(t, '#4ade80');
    flight.raf = requestAnimationFrame(loop);
  }
  function beginFlight(t0) {
    sizeCanvas();
    multEl.className = '';
    setStatus($('#aStatus'), 'En vol… encaisse au bon moment !');
    $('#aStart').disabled = true; $('#aCash').disabled = false;
    stopFlight();
    flight = { t0, raf: 0, poll: 0 };
    flight.raf = requestAnimationFrame(loop);
    flight.poll = setInterval(async () => {
      try {
        const s = await api('/api/games/aviator/state');
        if (s.status === 'crashed') { drawCurve(Math.log(s.crashAt) / RATE, '#ef4444'); endFlight('crash', s.crashAt, `💥 L'avion s'est envolé à ${s.crashAt.toFixed(2)}x. Pas de gain cette fois.`); }
      } catch {}
    }, 350);
  }
  // En arrivant sur Aviator : reprend un vol en cours (si on avait quitté la page), sinon remet à zéro
  async function enterAviator() {
    sizeCanvas();
    try {
      const s = await api('/api/games/aviator/state');
      if (s.status === 'flying') { beginFlight(performance.now() - (Math.log(Math.max(1, s.mult)) / RATE) * 1000); return; }
    } catch {}
    resetAviatorUi();
  }
  $('#aStart').addEventListener('click', async () => {
    try {
      const res = await api('/api/games/aviator/start', 'POST');
      wallet(res); beginFlight(performance.now());
    } catch (err) { setStatus($('#aStatus'), err.message, 'loss'); }
  });
  $('#aCash').addEventListener('click', async () => {
    $('#aCash').disabled = true;
    try {
      const res = await api('/api/games/aviator/cashout', 'POST');
      wallet(res);
      if (res.status === 'cashed') endFlight('cash', res.mult, `✅ Encaissé à ${res.mult.toFixed(2)}x.` + (res.reward.gain > 0 ? rewardText(res.reward) : ' Trop tôt pour gagner des coins : vise au moins 1.20x.'));
      else endFlight('crash', res.crashAt, `💥 Trop tard ! L'avion s'est envolé à ${res.crashAt.toFixed(2)}x.`);
    } catch (err) { setStatus($('#aStatus'), err.message, 'loss'); $('#aCash').disabled = false; }
  });
  window.addEventListener('resize', () => { if (!flight && !$('#p-aviator').hidden) { sizeCanvas(); } });

  // =====================================================================
  //  Foot virtuel
  // =====================================================================
  let fixture = null, playing = false;
  const labels = f => ({ '1': 'Victoire ' + f.home, N: 'Match nul', '2': 'Victoire ' + f.away });
  function renderFixture() {
    $('#fHome').textContent = fixture.home; $('#fAway').textContent = fixture.away;
    $('#fScore').textContent = '- : -'; $('#log').innerHTML = '';
    const box = $('#picks'); box.innerHTML = '';
    const lab = labels(fixture);
    for (const k of ['1', 'N', '2']) {
      const b = document.createElement('button');
      b.className = 'pick'; b.dataset.k = k;
      const left = document.createElement('span');
      left.textContent = lab[k];
      const pct = document.createElement('span');
      pct.className = 'pct'; pct.textContent = `${Math.round(fixture.p[k] * 100)} % de chances`;
      left.appendChild(pct);
      const gain = document.createElement('span');
      gain.className = 'gain'; gain.textContent = `+${fixture.rewards[k]}`;
      b.append(left, gain);
      b.addEventListener('click', () => predict(k));
      box.appendChild(b);
    }
    setStatus($('#fStatus'), 'Choisis ton pronostic.');
  }
  async function loadFixture(fresh) {
    try {
      const res = await api(fresh ? '/api/games/foot/new' : '/api/games/foot', fresh ? 'POST' : 'GET');
      fixture = res.fixture; wallet(res); renderFixture();
    } catch (err) { setStatus($('#fStatus'), err.message, 'loss'); }
  }
  async function predict(k) {
    if (playing || !fixture) return;
    playing = true;
    document.querySelectorAll('.pick').forEach(b => { b.disabled = true; });
    $('#fNew').disabled = true;
    try {
      const res = await api('/api/games/foot/predict', 'POST', { id: fixture.id, choice: k });
      setStatus($('#fStatus'), '⏱️ Match en cours…');
      const log = $('#log'); log.innerHTML = '';
      for (const ev of res.events) {
        await new Promise(r => setTimeout(r, 900));
        $('#fScore').textContent = `${ev.score[0]} : ${ev.score[1]}`;
        const li = document.createElement('li');
        const mn = document.createElement('b'); mn.textContent = `${ev.minute}'`;
        li.append(mn, ' ⚽ ' + ev.text);
        log.appendChild(li);
      }
      await new Promise(r => setTimeout(r, 600));
      $('#fScore').textContent = `${res.score[0]} : ${res.score[1]}`;
      wallet(res);
      setStatus($('#fStatus'), res.correct ? '🎉 Bien vu, pronostic juste !' + rewardText(res.reward) : 'Pronostic raté. Retente avec un autre match.', res.correct ? 'win' : 'loss');
    } catch (err) { setStatus($('#fStatus'), err.message, 'loss'); }
    playing = false; $('#fNew').disabled = false;
  }
  $('#fNew').addEventListener('click', () => { if (!playing) loadFixture(true); });

  // =====================================================================
  //  Démarrage
  // =====================================================================
  (async () => {
    try {
      const me = await fetch('/api/me').then(r => r.json());
      if (!me.user) { showLogin(); return; }
      $('#uname').textContent = String(me.user.name || 'champion').split(' ')[0];
      const info = await api('/api/games/info');
      wallet(info); rewards = info.rewards;
      $('#dRew').textContent = rewards.dames; $('#aPer').textContent = rewards.aviatorPerX; $('#aMax').textContent = rewards.aviatorMax;
      const cur = await api('/api/games/dames');
      if (cur.game) { game = cur.game; renderBoard(); dStatusFor(); }
      loadFixture(false);
      route();
    } catch { renderLobby(); }
  })();
})();
