import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.SESSION_SECRET || '';
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const BOTS_FILE = path.join(DATA_DIR, 'bots.json');
const COOKIE = 'zepe_session';
const WEEK = 7 * 24 * 60 * 60 * 1000;
const COOKIE_OPTS = { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/' };
const workers = new Map();

// Réglages de l'économie (modifie ces nombres comme tu veux)
const START_COINS = 100;   // coins offerts à l'inscription
const SLOT_PRICE = 100;    // prix d'un slot en coins
const CLAIM_GAIN = 5;      // coins gagnés par clic
const DAILY_MAX = 15;      // clics max par jour
const COOLDOWN = 20000;    // attente entre deux clics (ms)
const MAX_BOTS = 10;       // bots max par compte

// Rôles : définis par e-mail dans les variables d'environnement de Render
const OWNER_EMAIL = 'fkfode2005@gmail.com';
const ADMIN_EMAILS = ['yero9799@gmail.com'];
const roleOf = u => (OWNER_EMAIL && u.email === OWNER_EMAIL ? 'owner' : ADMIN_EMAILS.includes(u.email) ? 'admin' : 'user');

if (SECRET.length < 32) {
  console.error('SESSION_SECRET doit faire au moins 32 caractères.');
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'sessions'), { recursive: true });

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const users = () => readJson(USERS_FILE, []);
const bots = () => readJson(BOTS_FILE, []);
function saveUser(u) {
  const all = users();
  const i = all.findIndex(x => x.id === u.id);
  if (i >= 0) { all[i] = u; writeJson(USERS_FILE, all); }
}
function safeEqual(a, b) {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`;
}
function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(parts[0]).digest('base64url');
  if (!safeEqual(parts[1], expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    return payload.exp < Date.now() ? null : payload;
  } catch { return null; }
}
function currentUser(req) {
  const session = verify(req.cookies[COOKIE]);
  const u = session && users().find(x => x.id === session.uid);
  if (!u) return null;
  u.coins ??= START_COINS; u.slots ??= 0;
  return u;
}
function auth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Connecte-toi pour continuer.' });
  req.user = user;
  next();
}
function setSession(res, user) {
  res.cookie(COOKIE, sign({ uid: user.id, exp: Date.now() + WEEK }), { ...COOKIE_OPTS, maxAge: WEEK });
}
const today = () => new Date().toISOString().slice(0, 10);
const claimsToday = u => (u.claims && u.claims.day === today() ? u.claims.n : 0);
function cleanUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: roleOf(u), createdAt: u.createdAt, coins: u.coins ?? START_COINS, slots: u.slots ?? 0, claimsToday: claimsToday(u) };
}
function pubBot(b) {
  const w = workers.get(b.id);
  return { id: b.id, label: b.label, phone: b.phone, status: w ? w.status : 'stopped', pairingCode: w ? w.pairingCode : null };
}
function stopWorker(id) {
  const w = workers.get(id);
  if (w) { workers.delete(id); w.child.kill('SIGTERM'); }
}

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"],
      upgradeInsecureRequests: null
    }
  }
}));
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const attempts = new Map();
function rateLimit(key, max = 8, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter(t => now - t < windowMs);
  if (recent.length >= max) return false;
  recent.push(now); attempts.set(key, recent); return true;
}

app.post('/api/register', async (req, res) => {
  if (!rateLimit('register:' + req.ip, 5)) return res.status(429).json({ error: 'Trop de tentatives. Réessaie plus tard.' });
  const name = String(req.body.name || '').trim().slice(0, 50);
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10 || password.length > 128) {
    return res.status(400).json({ error: 'Nom, e-mail valide et mot de passe de 10 à 128 caractères requis.' });
  }
  const all = users();
  if (all.some(u => u.email === email)) return res.status(409).json({ error: 'Cette adresse e-mail est déjà inscrite.' });
  const user = { id: crypto.randomUUID(), name, email, passwordHash: await bcrypt.hash(password, 12), createdAt: Date.now(), coins: START_COINS, slots: 0 };
  all.push(user); writeJson(USERS_FILE, all);
  setSession(res, user);
  res.json({ user: cleanUser(user) });
});

app.post('/api/login', async (req, res) => {
  if (!rateLimit('login:' + req.ip, 10)) return res.status(429).json({ error: 'Trop de tentatives. Réessaie plus tard.' });
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = users().find(u => u.email === email);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: 'E-mail ou mot de passe incorrect.' });
  setSession(res, user);
  res.json({ user: cleanUser(user) });
});

app.post('/api/logout', (_req, res) => { res.clearCookie(COOKIE, COOKIE_OPTS); res.json({ ok: true }); });
app.get('/api/me', (req, res) => { const u = currentUser(req); res.json({ user: u ? cleanUser(u) : null }); });

// Tout le tableau de bord en une seule requête
app.get('/api/overview', auth, (req, res) => {
  const mine = bots().filter(b => b.userId === req.user.id).map(pubBot);
  res.json({ user: cleanUser(req.user), bots: mine, config: { slotPrice: SLOT_PRICE, dailyMax: DAILY_MAX, claimGain: CLAIM_GAIN, maxBots: MAX_BOTS } });
});

// Coins
app.post('/api/coins/claim', auth, (req, res) => {
  const u = req.user;
  const c = u.claims && u.claims.day === today() ? u.claims : { day: today(), n: 0, last: 0 };
  if (c.n >= DAILY_MAX) return res.status(429).json({ error: 'Limite du jour atteinte. Reviens demain.' });
  if (Date.now() - c.last < COOLDOWN) return res.status(429).json({ error: 'Patiente quelques secondes avant de réessayer.' });
  c.n += 1; c.last = Date.now(); u.claims = c; u.coins += CLAIM_GAIN;
  saveUser(u);
  res.json({ ok: true, message: `+${CLAIM_GAIN} coins` });
});

app.post('/api/coins/transfer', auth, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const amount = Math.floor(Number(req.body.amount));
  if (!(amount >= 1) || amount > req.user.coins) return res.status(400).json({ error: 'Montant invalide ou coins insuffisants.' });
  const target = users().find(x => x.email === email);
  if (!target || target.id === req.user.id) return res.status(404).json({ error: 'Aucun autre compte avec cet e-mail.' });
  target.coins = (target.coins ?? START_COINS) + amount;
  req.user.coins -= amount;
  saveUser(target); saveUser(req.user);
  res.json({ ok: true, message: `${amount} coins envoyés.` });
});

// Slots
app.post('/api/slots/buy', auth, (req, res) => {
  if (req.user.coins < SLOT_PRICE) return res.status(402).json({ error: `Il te faut ${SLOT_PRICE} coins pour un slot.` });
  req.user.coins -= SLOT_PRICE; req.user.slots += 1;
  saveUser(req.user);
  res.json({ ok: true, message: 'Slot acheté.' });
});

// Bots
app.post('/api/bots', auth, (req, res) => {
  const all = bots();
  if (all.filter(b => b.userId === req.user.id).length >= MAX_BOTS) return res.status(409).json({ error: `Limite de ${MAX_BOTS} bots atteinte.` });
  const phone = String(req.body.phone || '').replace(/\D/g, '');
  const label = String(req.body.label || 'Mon bot').trim().slice(0, 40) || 'Mon bot';
  if (phone.length < 8 || phone.length > 15) return res.status(400).json({ error: 'Entre le numéro WhatsApp au format international, chiffres uniquement.' });
  const bot = { id: crypto.randomUUID(), userId: req.user.id, phone, label, createdAt: Date.now() };
  all.push(bot); writeJson(BOTS_FILE, all);
  res.json({ ok: true, bot: pubBot(bot) });
});

app.post('/api/bots/:id/start', auth, (req, res) => {
  const mine = bots().filter(b => b.userId === req.user.id);
  const bot = mine.find(b => b.id === req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot introuvable.' });
  if (workers.has(bot.id)) return res.status(409).json({ error: 'Ce bot est déjà lancé.' });
  if (mine.filter(b => workers.has(b.id)).length >= req.user.slots) return res.status(402).json({ error: 'Aucun slot libre. Achète un slot avec tes coins.' });
  const workerFile = path.join(__dirname, 'workers', 'whatsapp-worker.js');
  if (!fs.existsSync(workerFile)) return res.status(501).json({ error: "Le module WhatsApp n'est pas encore installé (workers/whatsapp-worker.js)." });
  const sessionDir = path.join(DATA_DIR, 'sessions', bot.id);
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [workerFile, bot.phone, sessionDir], {
    cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production' }
  });
  const record = { child, status: 'starting', pairingCode: null };
  workers.set(bot.id, record);
  child.stdout.on('data', chunk => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'pairing') { record.pairingCode = msg.code; record.status = 'pairing'; }
        if (msg.type === 'status') { record.status = msg.status; if (msg.status === 'online') record.pairingCode = null; }
      } catch {}
    }
  });
  child.stderr.resume();
  child.on('exit', () => { if (workers.get(bot.id) === record) workers.delete(bot.id); });
  res.json({ ok: true, message: 'Démarrage en cours. Le code de jumelage arrive dans quelques secondes.' });
});

app.post('/api/bots/:id/stop', auth, (req, res) => {
  const bot = bots().find(b => b.id === req.params.id && b.userId === req.user.id);
  if (!bot) return res.status(404).json({ error: 'Bot introuvable.' });
  stopWorker(bot.id);
  res.json({ ok: true, message: 'Bot arrêté.' });
});

app.delete('/api/bots/:id', auth, (req, res) => {
  const all = bots();
  const bot = all.find(b => b.id === req.params.id && b.userId === req.user.id);
  if (!bot) return res.status(404).json({ error: 'Bot introuvable.' });
  stopWorker(bot.id);
  writeJson(BOTS_FILE, all.filter(b => b.id !== bot.id));
  fs.rmSync(path.join(DATA_DIR, 'sessions', bot.id), { recursive: true, force: true });
  res.json({ ok: true, message: 'Bot supprimé.' });
});

// Administration (propriétaire et admins)
function adminOnly(req, res, next) {
  if (roleOf(req.user) === 'user') return res.status(403).json({ error: 'Accès réservé aux administrateurs.' });
  next();
}
// Le propriétaire gère tout le monde ; un admin gère seulement les utilisateurs simples.
const canManage = (actor, target) => roleOf(actor) === 'owner' || roleOf(target) === 'user';

app.get('/api/admin/users', auth, adminOnly, (_req, res) => {
  const allBots = bots();
  res.json({ users: users().map(u => ({ ...cleanUser(u), slots: u.slots ?? 0, bots: allBots.filter(b => b.userId === u.id).map(pubBot) })) });
});

app.post('/api/admin/users/:id/coins', auth, adminOnly, (req, res) => {
  const target = users().find(u => u.id === req.params.id);
  const amount = Math.trunc(Number(req.body.amount));
  if (!target) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  if (!canManage(req.user, target)) return res.status(403).json({ error: 'Tu ne peux pas modifier ce compte.' });
  if (!amount || Math.abs(amount) > 1000000) return res.status(400).json({ error: 'Montant invalide.' });
  target.coins = Math.max(0, (target.coins ?? START_COINS) + amount);
  saveUser(target);
  res.json({ ok: true, message: `${target.name} a maintenant ${target.coins} coins.` });
});

function adminBot(req, res) {
  const bot = bots().find(b => b.id === req.params.id);
  const owner = bot && users().find(u => u.id === bot.userId);
  if (!bot || !owner) { res.status(404).json({ error: 'Bot introuvable.' }); return null; }
  if (!canManage(req.user, owner)) { res.status(403).json({ error: 'Tu ne peux pas gérer ce bot.' }); return null; }
  return bot;
}
app.post('/api/admin/bots/:id/stop', auth, adminOnly, (req, res) => {
  const bot = adminBot(req, res); if (!bot) return;
  stopWorker(bot.id);
  res.json({ ok: true, message: 'Bot arrêté.' });
});
app.delete('/api/admin/bots/:id', auth, adminOnly, (req, res) => {
  const bot = adminBot(req, res); if (!bot) return;
  stopWorker(bot.id);
  writeJson(BOTS_FILE, bots().filter(b => b.id !== bot.id));
  fs.rmSync(path.join(DATA_DIR, 'sessions', bot.id), { recursive: true, force: true });
  res.json({ ok: true, message: 'Bot supprimé.' });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Route API introuvable.' }));
app.listen(PORT, '0.0.0.0', () => console.log(`ZEPE TECH prêt sur le port ${PORT}`));
