// games.js : jeux de ZEPE TECH (Dames, Aviator, Foot virtuel)
// Toute la logique tourne sur le serveur : le navigateur ne décide jamais du résultat
// ni du nombre de coins gagnés.
import crypto from 'node:crypto';

// ---------- Réglages (modifie ces nombres comme tu veux) ----------
export const GAMES_CONFIG = {
  dailyCoinCap: 60,                              // coins max gagnés avec les jeux, par joueur et par jour
  dames: { reward: 10 },                         // coins pour une victoire contre le bot
  aviator: { rewardPerX: 5, rewardMax: 20 },     // coins = (multiplicateur - 1) x 5, plafonné à 20
  foot: { unit: 3, min: 3, max: 20 },            // coins = 3 / probabilité du pronostic, entre 3 et 20
  cooldownMs: 400                                // délai minimum entre deux actions d'un joueur
};
const cfg = GAMES_CONFIG;

const rand01 = () => crypto.randomInt(0, 2 ** 30) / 2 ** 30;
const randInt = n => crypto.randomInt(n);
const pick = a => a[randInt(a.length)];
const today = () => new Date().toISOString().slice(0, 10);

// ---------- Coins gagnés (avec plafond quotidien) ----------
const earnedToday = u => (u.gameCoins && u.gameCoins.day === today() ? u.gameCoins.n : 0);
function grant(u, amount, saveUser) {
  const before = earnedToday(u);
  const gain = Math.max(0, Math.min(amount, cfg.dailyCoinCap - before));
  if (gain > 0) {
    u.gameCoins = { day: today(), n: before + gain };
    u.coins = (u.coins ?? 0) + gain;
    u.xp = (u.xp ?? 0) + 5;
    saveUser(u);
  }
  return { gain, capped: gain < amount };
}

// =====================================================================
//  DAMES (plateau 8x8, contre le bot)
//  Pièces : 'w' = joueur (en bas), 'b' = bot (en haut), majuscule = dame.
//  Règles : prise obligatoire, la plus longue, les pions prennent aussi
//  en arrière, les dames se déplacent et prennent à distance.
// =====================================================================
const DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const inb = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
const sideOf = p => (p ? p.toLowerCase() : null);
const isKing = p => p === 'W' || p === 'B';
const other = s => (s === 'w' ? 'b' : 'w');

export function newBoard() {
  const b = Array(64).fill('');
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 !== 1) continue;
      if (r < 3) b[r * 8 + c] = 'b';
      else if (r > 4) b[r * 8 + c] = 'w';
    }
  }
  return b;
}

// Toutes les séquences de prises complètes pour la pièce en `from`
function capturesFrom(board, from) {
  const piece = board[from];
  const side = sideOf(piece);
  const b = board.slice();
  b[from] = '';
  const out = [];
  const dfs = (pos, caps) => {
    const r0 = (pos / 8) | 0, c0 = pos % 8;
    let found = false;
    for (const [dr, dc] of DIRS) {
      let r = r0 + dr, c = c0 + dc;
      if (isKing(piece)) while (inb(r, c) && !b[r * 8 + c]) { r += dr; c += dc; }
      if (!inb(r, c)) continue;
      const idx = r * 8 + c;
      const target = b[idx];
      if (!target || sideOf(target) === side || caps.includes(idx)) continue;
      let lr = r + dr, lc = c + dc;
      while (inb(lr, lc) && !b[lr * 8 + lc]) {
        found = true;
        dfs(lr * 8 + lc, caps.concat(idx));
        if (!isKing(piece)) break;
        lr += dr; lc += dc;
      }
    }
    if (!found && caps.length) out.push({ from, to: pos, captured: caps });
  };
  dfs(from, []);
  return out;
}

export function legalMoves(board, side) {
  const caps = [];
  for (let i = 0; i < 64; i++) if (sideOf(board[i]) === side) caps.push(...capturesFrom(board, i));
  if (caps.length) {
    const max = Math.max(...caps.map(m => m.captured.length));
    return caps.filter(m => m.captured.length === max);
  }
  const moves = [];
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (sideOf(p) !== side) continue;
    const r0 = (i / 8) | 0, c0 = i % 8;
    if (isKing(p)) {
      for (const [dr, dc] of DIRS) {
        let r = r0 + dr, c = c0 + dc;
        while (inb(r, c) && !board[r * 8 + c]) { moves.push({ from: i, to: r * 8 + c, captured: [] }); r += dr; c += dc; }
      }
    } else {
      const dr = side === 'w' ? -1 : 1;
      for (const dc of [-1, 1]) {
        const r = r0 + dr, c = c0 + dc;
        if (inb(r, c) && !board[r * 8 + c]) moves.push({ from: i, to: r * 8 + c, captured: [] });
      }
    }
  }
  return moves;
}

export function applyMove(board, m) {
  const b = board.slice();
  const p = b[m.from];
  b[m.from] = '';
  for (const c of m.captured) b[c] = '';
  const r = (m.to / 8) | 0;
  b[m.to] = p === 'w' && r === 0 ? 'W' : p === 'b' && r === 7 ? 'B' : p;
  return b;
}

function evalBoard(board, side) {
  let s = 0;
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (!p) continue;
    const r = (i / 8) | 0;
    let v = isKing(p) ? 300 : 100;
    if (!isKing(p)) v += (p === 'b' ? r : 7 - r) * 4;
    s += sideOf(p) === 'b' ? v : -v;
  }
  return side === 'b' ? s : -s;
}

function search(board, side, depth, alpha, beta) {
  const moves = legalMoves(board, side);
  if (!moves.length) return -10000 - depth;
  if (depth === 0) return evalBoard(board, side);
  let best = -Infinity;
  for (const m of moves) {
    const v = -search(applyMove(board, m), other(side), depth - 1, -beta, -alpha);
    if (v > best) best = v;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

const BOT_DEPTH = 3; // monte à 4 pour un bot plus fort
export function botChoose(board) {
  const moves = legalMoves(board, 'b');
  if (!moves.length) return null;
  let best = null, bestScore = -Infinity;
  for (const m of moves) {
    const sc = -search(applyMove(board, m), 'w', BOT_DEPTH - 1, -Infinity, Infinity) + rand01() * 6;
    if (sc > bestScore) { bestScore = sc; best = m; }
  }
  return best;
}

export function newDames() {
  return { board: newBoard(), over: false, result: null, plies: 0, quiet: 0, lastBot: null, rewarded: false };
}

function advance(game, m) {
  const wasMan = !isKing(game.board[m.from]);
  game.board = applyMove(game.board, m);
  game.plies++;
  game.quiet = m.captured.length || wasMan ? 0 : game.quiet + 1;
}

// Joue le coup du joueur puis la réponse du bot. Retourne { error } si le coup est interdit.
export function stepDames(game, from, to) {
  if (game.over) return { error: 'La partie est terminée.' };
  const m = legalMoves(game.board, 'w').find(x => x.from === from && x.to === to);
  if (!m) return { error: 'Coup interdit.' };
  advance(game, m);
  game.lastBot = null;
  const bm = botChoose(game.board);
  if (!bm) { game.over = true; game.result = 'win'; return {}; }
  advance(game, bm);
  game.lastBot = { from: bm.from, to: bm.to, captured: bm.captured };
  if (!legalMoves(game.board, 'w').length) { game.over = true; game.result = 'loss'; }
  else if (game.quiet >= 30 || game.plies >= 160) { game.over = true; game.result = 'draw'; }
  return {};
}

export function damesView(game) {
  const moves = game.over ? [] : legalMoves(game.board, 'w');
  const uniq = new Map();
  for (const m of moves) uniq.set(m.from + '-' + m.to, { from: m.from, to: m.to });
  return {
    board: game.board,
    moves: [...uniq.values()],
    mustCapture: moves.some(m => m.captured.length > 0),
    over: game.over,
    result: game.result,
    lastBot: game.lastBot
  };
}

// =====================================================================
//  AVIATOR (vol gratuit : le serveur choisit le point de crash à l'avance)
// =====================================================================
const RATE = 0.08; // multiplicateur = exp(0.08 x secondes)
export const aviatorMult = t => Math.exp(RATE * t);
export function newCrash() {
  const r = rand01();
  return Math.min(100, Math.max(1, Math.floor(95 / (1 - r)) / 100));
}
export function newFlight() {
  const crashAt = newCrash();
  return { startedAt: Date.now(), crashAt, crashT: Math.log(crashAt) / RATE, status: 'flying', reward: null };
}
const floor2 = x => Math.floor(x * 100) / 100;
// Met le vol à jour selon l'heure et retourne le multiplicateur courant
export function flightTick(f, now = Date.now()) {
  if (f.status !== 'flying') return f.status === 'cashed' ? f.cashMult : f.crashAt;
  const t = (now - f.startedAt) / 1000;
  if (t >= f.crashT) { f.status = 'crashed'; return f.crashAt; }
  return floor2(aviatorMult(t));
}
export function flightCashout(f, now = Date.now()) {
  const mult = flightTick(f, now);
  if (f.status !== 'flying') return { status: f.status, mult };
  f.status = 'cashed';
  f.cashMult = mult;
  return { status: 'cashed', mult, amount: Math.min(cfg.aviator.rewardMax, Math.floor((mult - 1) * cfg.aviator.rewardPerX)) };
}

// =====================================================================
//  FOOT VIRTUEL (pronostic sur un match simulé)
// =====================================================================
export const TEAMS = [
  { name: 'Brésil', power: 90 }, { name: 'France', power: 90 }, { name: 'Argentine', power: 89 },
  { name: 'Espagne', power: 88 }, { name: 'Maroc', power: 82 }, { name: 'Sénégal', power: 80 },
  { name: 'Égypte', power: 76 }, { name: 'Nigeria', power: 76 }, { name: "Côte d'Ivoire", power: 76 },
  { name: 'Cameroun', power: 72 }, { name: 'Mali', power: 70 }, { name: 'Guinée', power: 66 }
];

export function footProbs(home, away) {
  const ratio = (home.power - away.power) / 100;
  const lh = 1.35 * Math.exp(1.2 * ratio) * 1.05;
  const la = 1.15 * Math.exp(-1.2 * ratio);
  const pk = (l, k) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; };
  let p1 = 0, pn = 0, p2 = 0;
  for (let h = 0; h <= 10; h++) {
    for (let a = 0; a <= 10; a++) {
      const p = pk(lh, h) * pk(la, a);
      if (h > a) p1 += p; else if (h < a) p2 += p; else pn += p;
    }
  }
  const s = p1 + pn + p2;
  return { lh, la, p: { '1': p1 / s, N: pn / s, '2': p2 / s } };
}

const footReward = p => Math.max(cfg.foot.min, Math.min(cfg.foot.max, Math.round(cfg.foot.unit / p)));

export function newFixture() {
  const home = pick(TEAMS);
  let away; do { away = pick(TEAMS); } while (away === home);
  const { lh, la, p } = footProbs(home, away);
  return {
    id: crypto.randomUUID(), home, away, lh, la, p,
    rewards: { '1': footReward(p['1']), N: footReward(p.N), '2': footReward(p['2']) }
  };
}

const samplePoisson = l => { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= rand01(); } while (p > L); return Math.min(8, k - 1); };

export function footSimulate(fx, choice) {
  const nh = samplePoisson(fx.lh), na = samplePoisson(fx.la);
  const events = [];
  for (let i = 0; i < nh; i++) events.push({ minute: 1 + randInt(90), team: 'home' });
  for (let i = 0; i < na; i++) events.push({ minute: 1 + randInt(90), team: 'away' });
  events.sort((a, b) => a.minute - b.minute);
  let h = 0, a = 0;
  for (const e of events) {
    if (e.team === 'home') h++; else a++;
    e.score = [h, a];
    e.text = `But de ${e.team === 'home' ? fx.home.name : fx.away.name}`;
  }
  const outcome = nh > na ? '1' : nh < na ? '2' : 'N';
  return { score: [nh, na], events, outcome, correct: outcome === choice };
}

const fixtureView = fx => ({ id: fx.id, home: fx.home.name, away: fx.away.name, p: fx.p, rewards: fx.rewards });

// =====================================================================
//  Routes
// =====================================================================
export function mountGames(app, { auth, saveUser }) {
  const dames = new Map(), flights = new Map(), fixtures = new Map(), last = new Map();

  const throttle = (req, res) => {
    const now = Date.now();
    if (now - (last.get(req.user.id) || 0) < cfg.cooldownMs) {
      res.status(429).json({ error: 'Doucement, attends un instant.' });
      return false;
    }
    last.set(req.user.id, now);
    return true;
  };
  const wallet = u => ({ coins: u.coins ?? 0, earnedToday: earnedToday(u), dailyCoinCap: cfg.dailyCoinCap });

  app.get('/api/games/info', auth, (req, res) => {
    res.json({
      ...wallet(req.user),
      rewards: { dames: cfg.dames.reward, aviatorMax: cfg.aviator.rewardMax, aviatorPerX: cfg.aviator.rewardPerX, footMin: cfg.foot.min, footMax: cfg.foot.max }
    });
  });

  // ----- Dames -----
  app.get('/api/games/dames', auth, (req, res) => {
    const g = dames.get(req.user.id);
    res.json({ game: g ? damesView(g) : null, ...wallet(req.user) });
  });
  app.post('/api/games/dames/new', auth, (req, res) => {
    if (!throttle(req, res)) return;
    const g = newDames();
    dames.set(req.user.id, g);
    res.json({ game: damesView(g), ...wallet(req.user) });
  });
  app.post('/api/games/dames/move', auth, (req, res) => {
    if (!throttle(req, res)) return;
    const g = dames.get(req.user.id);
    if (!g) return res.status(404).json({ error: 'Aucune partie en cours. Lance une nouvelle partie.' });
    const from = Number(req.body.from), to = Number(req.body.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > 63 || to < 0 || to > 63) {
      return res.status(400).json({ error: 'Coup invalide.' });
    }
    const r = stepDames(g, from, to);
    if (r.error) return res.status(400).json({ error: r.error });
    let reward = null;
    if (g.over && g.result === 'win' && !g.rewarded) { g.rewarded = true; reward = grant(req.user, cfg.dames.reward, saveUser); }
    res.json({ game: damesView(g), reward, ...wallet(req.user) });
  });

  // ----- Aviator -----
  app.post('/api/games/aviator/start', auth, (req, res) => {
    if (!throttle(req, res)) return;
    const old = flights.get(req.user.id);
    if (old) { flightTick(old); if (old.status === 'flying') return res.status(409).json({ error: 'Un vol est déjà en cours.' }); }
    const f = newFlight();
    flights.set(req.user.id, f);
    res.json({ status: 'flying', ...wallet(req.user) });
  });
  app.get('/api/games/aviator/state', auth, (req, res) => {
    const f = flights.get(req.user.id);
    if (!f) return res.json({ status: 'idle' });
    const mult = flightTick(f);
    res.json(f.status === 'flying' ? { status: 'flying', mult } : { status: f.status, mult, crashAt: f.status === 'crashed' ? f.crashAt : undefined });
  });
  app.post('/api/games/aviator/cashout', auth, (req, res) => {
    const f = flights.get(req.user.id);
    if (!f) return res.status(404).json({ error: 'Aucun vol en cours.' });
    const r = flightCashout(f);
    if (r.status === 'crashed') return res.json({ status: 'crashed', crashAt: f.crashAt, ...wallet(req.user) });
    if (r.status !== 'cashed' || f.rewardGiven) return res.status(409).json({ error: 'Ce vol est déjà terminé.' });
    f.rewardGiven = true;
    const reward = grant(req.user, r.amount, saveUser);
    res.json({ status: 'cashed', mult: r.mult, reward, ...wallet(req.user) });
  });

  // ----- Foot virtuel -----
  const currentFixture = uid => { let fx = fixtures.get(uid); if (!fx) { fx = newFixture(); fixtures.set(uid, fx); } return fx; };
  app.get('/api/games/foot', auth, (req, res) => {
    res.json({ fixture: fixtureView(currentFixture(req.user.id)), ...wallet(req.user) });
  });
  app.post('/api/games/foot/new', auth, (req, res) => {
    if (!throttle(req, res)) return;
    const fx = newFixture();
    fixtures.set(req.user.id, fx);
    res.json({ fixture: fixtureView(fx), ...wallet(req.user) });
  });
  app.post('/api/games/foot/predict', auth, (req, res) => {
    if (!throttle(req, res)) return;
    const choice = String(req.body.choice || '');
    if (!['1', 'N', '2'].includes(choice)) return res.status(400).json({ error: 'Choisis 1, N ou 2.' });
    const fx = fixtures.get(req.user.id);
    if (!fx || String(req.body.id) !== fx.id) return res.status(409).json({ error: 'Ce match est déjà joué. Lance un nouveau match.' });
    fixtures.delete(req.user.id); // un match ne se joue qu'une fois
    const sim = footSimulate(fx, choice);
    const reward = sim.correct ? grant(req.user, fx.rewards[choice], saveUser) : null;
    res.json({ home: fx.home.name, away: fx.away.name, ...sim, reward, ...wallet(req.user) });
  });
}
