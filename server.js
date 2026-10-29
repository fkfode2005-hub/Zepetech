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
const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.SESSION_SECRET || '';
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const BOTS_FILE = path.join(DATA_DIR, 'bots.json');
const COOKIE = 'zepe_session';
const workers = new Map();

if (SECRET.length < 32) {
  console.error('SESSION_SECRET must be at least 32 characters. Copy .env.example to .env and set it.');
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
function users() { return readJson(USERS_FILE, []); }
function bots() { return readJson(BOTS_FILE, []); }
function safeEqual(a, b) {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(parts[0]).digest('base64url');
  if (!safeEqual(parts[1], expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}
function currentUser(req) {
  const session = verify(req.cookies[COOKIE]);
  if (!session) return null;
  return users().find(u => u.id === session.uid) || null;
}
function auth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Connecte-toi pour continuer.' });
  req.user = user;
  next();
}
function cleanUser(u) { return { id: u.id, name: u.name, email: u.email }; }

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
  const ip = req.ip || 'unknown';
  if (!rateLimit('register:' + ip, 5)) return res.status(429).json({ error: 'Trop de tentatives. Réessaie plus tard.' });
  const name = String(req.body.name || '').trim().slice(0, 50);
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10 || password.length > 128) {
    return res.status(400).json({ error: 'Nom, e-mail valide et mot de passe de 10 à 128 caractères requis.' });
  }
  const all = users();
  if (all.some(u => u.email === email)) return res.status(409).json({ error: 'Cette adresse e-mail est déjà inscrite.' });
  const user = { id: crypto.randomUUID(), name, email, passwordHash: await bcrypt.hash(password, 12), createdAt: Date.now() };
  all.push(user); writeJson(USERS_FILE, all);
  res.cookie(COOKIE, sign({ uid: user.id, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }), {
    httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000, path: '/'
  });
  res.json({ user: cleanUser(user) });
});

app.post('/api/login', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!rateLimit('login:' + ip, 10)) return res.status(429).json({ error: 'Trop de tentatives. Réessaie plus tard.' });
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = users().find(u => u.email === email);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: 'E-mail ou mot de passe incorrect.' });
  res.cookie(COOKIE, sign({ uid: user.id, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }), {
    httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000, path: '/'
  });
  res.json({ user: cleanUser(user) });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/' });
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => {
  const user = currentUser(req);
  res.json({ user: user ? cleanUser(user) : null });
});

app.get('/api/bots', auth, (req, res) => {
  res.json({ bots: bots().filter(b => b.userId === req.user.id).map(b => ({
    id: b.id, label: b.label, phone: b.phone, status: workers.has(b.id) ? workers.get(b.id).status : (b.status || 'stopped')
  })) });
});

// One bot per account in this starter; do not run untrusted uploaded bot code.
app.post('/api/bots', auth, (req, res) => {
  const existing = bots().filter(b => b.userId === req.user.id);
  if (existing.length >= 1) return res.status(409).json({ error: 'La version de départ autorise un seul bot par compte.' });
  const phone = String(req.body.phone || '').replace(/\D/g, '');
  const label = String(req.body.label || 'Mon bot').trim().slice(0, 40);
  if (phone.length < 8 || phone.length > 15) return res.status(400).json({ error: 'Entre le numéro WhatsApp au format international, chiffres uniquement.' });
  const bot = { id: crypto.randomUUID(), userId: req.user.id, phone, label, status: 'stopped', createdAt: Date.now() };
  const all = bots(); all.push(bot); writeJson(BOTS_FILE, all);
  res.json({ bot: { id: bot.id, label: bot.label, phone: bot.phone, status: bot.status } });
});

app.post('/api/bots/:id/start', auth, (req, res) => {
  const bot = bots().find(b => b.id === req.params.id && b.userId === req.user.id);
  if (!bot) return res.status(404).json({ error: 'Bot introuvable.' });
  if (workers.has(bot.id)) return res.status(409).json({ error: 'Ce bot est déjà lancé.' });

  const workerFile = path.join(__dirname, 'workers', 'whatsapp-worker.js');
  const sessionDir = path.join(DATA_DIR, 'sessions', bot.id);
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [workerFile, bot.phone, sessionDir], {
    cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production' }
  });
  const record = { child, status: 'starting', pairingCode: null, logs: [], startedAt: Date.now() };
  workers.set(bot.id, record);
  const collect = (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      record.logs.push(line.slice(0, 300)); if (record.logs.length > 50) record.logs.shift();
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'pairing') { record.pairingCode = msg.code; record.status = 'pairing'; }
        if (msg.type === 'status') record.status = msg.status;
      } catch {}
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', chunk => { record.logs.push(chunk.toString().slice(0, 300)); if (record.logs.length > 50) record.logs.shift(); });
  child.on('exit', () => {
    if (workers.get(bot.id) === record) {
      record.status = 'stopped';
      workers.delete(bot.id);
    }
  });
  res.json({ ok: true, message: 'Bot démarré. Le code peut prendre quelques secondes à apparaître.' });
});

app.get('/api/bots/:id/status', auth, (req, res) => {
  const bot = bots().find(b => b.id === req.params.id && b.userId === req.user.id);
  if (!bot) return res.status(404).json({ error: 'Bot introuvable.' });
  const record = workers.get(bot.id);
  res.json({ status: record?.status || 'stopped', pairingCode: record?.pairingCode || null, logs: record?.logs || [] });
});

app.post('/api/bots/:id/stop', auth, (req, res) => {
  const bot = bots().find(b => b.id === req.params.id && b.userId === req.user.id);
  if (!bot) return res.status(404).json({ error: 'Bot introuvable.' });
  const record = workers.get(bot.id);
  if (record) { record.child.kill('SIGTERM'); workers.delete(bot.id); }
  res.json({ ok: true });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Route API introuvable.' }));
app.listen(PORT, '0.0.0.0', () => console.log(`ZEPE TECH prêt sur le port ${PORT}`));
