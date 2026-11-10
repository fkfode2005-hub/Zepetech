// workers/whatsapp-worker.js
// Lancé par server.js : node whatsapp-worker.js <numéro> <dossier-de-session>
// Écrit des lignes JSON lues par le serveur :
//   {"type":"pairing","code":"ZEPECODE"}  et  {"type":"status","status":"online"}
import crypto from 'node:crypto';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys';

const [phone, sessionDir] = process.argv.slice(2);
if (!phone || !sessionDir) { console.error('Usage: node whatsapp-worker.js <numéro> <session>'); process.exit(1); }

const PAIRING_CODE = 'ZEPECODE';
const PREFIX = '!';
const BOT_NAME = 'ZEPE MD';

const send = obj => console.log(JSON.stringify(obj));
const noop = () => {};
const logger = { level: 'silent', trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child() { return logger; } };
const rnd = n => Math.floor(Math.random() * n);
const pick = a => a[rnd(a.length)];
const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

// ---------- Registre de commandes ----------
const commands = Object.create(null);
const CATS = { outils: '🛠 Outils', fun: '🎉 Fun', jeux: '🎮 Jeux', groupe: '👥 Groupe' };
const cmd = (name, cat, help, run, opts = {}) => { commands[name] = { cat, help, run, ...opts }; };

// État en mémoire (remis à zéro quand le bot redémarre)
const games = new Map();
const antilink = new Set();
const warns = new Map();
const lastCmd = new Map();

const JOKES = [
  'Pourquoi les plongeurs plongent-ils toujours en arrière ? Parce que sinon ils tombent dans le bateau.',
  "Quel est le comble pour un électricien ? De ne pas être au courant.",
  "Pourquoi l'ordinateur est-il allé chez le médecin ? Il avait un virus.",
  "Pourquoi les poissons n'aiment pas jouer au tennis ? Ils ont peur du filet.",
  "Que dit un escargot sur le dos d'une tortue ? Youpiii !",
  "Que fait un crocodile qui surveille une pharmacie ? Il garde-Nil."
];
const QUOTES = [
  "Un petit pas chaque jour vaut mieux qu'un grand saut un jour.",
  "Ce que tu répètes devient ce que tu es.",
  "Commence là où tu es, avec ce que tu as.",
  "La patience ouvre plus de portes que la force.",
  "Tes erreurs d'aujourd'hui sont les leçons de demain."
];
const QUIZ = [
  ['Quelle est la capitale de la Guinée ?', 'conakry'],
  ['Quelle est la capitale du Sénégal ?', 'dakar'],
  ['Quelle est la capitale de la France ?', 'paris'],
  ['Quel est le plus grand océan du monde ?', 'pacifique'],
  ['Quelle planète est la plus proche du Soleil ?', 'mercure'],
  ["Combien de côtés a un hexagone ?", '6'],
  ["Quelle est la formule chimique de l'eau ?", 'h2o'],
  ['Quel est le plus grand désert chaud du monde ?', 'sahara']
];

// ---------- Outils ----------
cmd('ping', 'outils', 'Vérifie que le bot répond.', () => 'Pong ! Le bot est en ligne ✅');
cmd('heure', 'outils', "Affiche la date et l'heure (UTC).", () => new Date().toLocaleString('fr-FR', { timeZone: 'UTC' }) + ' (UTC)');
cmd('calc', 'outils', 'Calcule une expression. Ex : !calc (12+8)*3', ({ args }) => {
  const e = args.join(' ').replace(/,/g, '.').replace(/x/gi, '*');
  if (!e || e.length > 60 || !/^[0-9+\-*/().%\s]+$/.test(e)) return 'Écris un calcul simple. Ex : !calc (12+8)*3';
  try {
    const r = Function('"use strict";return (' + e + ')')();
    return Number.isFinite(r) ? `${e} = ${r}` : 'Calcul impossible.';
  } catch { return 'Calcul invalide.'; }
});
cmd('mdp', 'outils', 'Génère un mot de passe. Ex : !mdp 16', ({ args }) => {
  const n = Math.min(32, Math.max(8, parseInt(args[0]) || 12));
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*?';
  return 'Ton mot de passe :\n' + Array.from(crypto.randomBytes(n), b => chars[b % chars.length]).join('');
});
cmd('choisir', 'outils', 'Choisit au hasard. Ex : !choisir pizza, riz, pâtes', ({ args }) => {
  const opts = args.join(' ').split(/,| ou /).map(s => s.trim()).filter(Boolean);
  return opts.length < 2 ? 'Donne au moins 2 choix séparés par des virgules.' : 'Je choisis : ' + pick(opts);
});
cmd('menu', 'outils', 'Affiche toutes les commandes.', () => {
  const lines = [`*${BOT_NAME}*`, ''];
  for (const [cat, title] of Object.entries(CATS)) {
    const names = Object.entries(commands).filter(([, c]) => c.cat === cat).map(([n]) => PREFIX + n);
    if (names.length) lines.push(`*${title}*`, names.join('  '), '');
  }
  lines.push(`Détails : ${PREFIX}aide <commande>`);
  return lines.join('\n');
});
cmd('aide', 'outils', 'Explique une commande. Ex : !aide calc', ({ args }) => {
  const n = (args[0] || '').replace(PREFIX, '').toLowerCase();
  const c = commands[n];
  return c ? `${PREFIX}${n} : ${c.help}` : `Commande inconnue. Tape ${PREFIX}menu.`;
});

// ---------- Fun ----------
cmd('pileouface', 'fun', 'Lance une pièce.', () => pick(['Pile 🪙', 'Face 🪙']));
cmd('de', 'fun', 'Lance un dé. Ex : !de 20', ({ args }) => {
  const n = Math.min(1000, Math.max(2, parseInt(args[0]) || 6));
  return `🎲 D${n} : ${1 + rnd(n)}`;
});
cmd('8ball', 'fun', 'Pose une question. Ex : !8ball Vais-je réussir ?', ({ args }) =>
  args.length ? pick(['Oui, sans aucun doute.', 'Probablement.', 'Redemande plus tard.', 'Peu probable.', 'Non.', 'Tout indique que oui.']) : 'Pose une question après la commande.');
cmd('blague', 'fun', 'Raconte une blague.', () => pick(JOKES));
cmd('motivation', 'fun', 'Un petit message pour avancer.', () => pick(QUOTES));
cmd('pfc', 'fun', 'Pierre, feuille, ciseaux. Ex : !pfc pierre', ({ args }) => {
  const opts = ['pierre', 'feuille', 'ciseaux'];
  let you = norm(args[0] || ''); if (you === 'papier') you = 'feuille';
  if (!opts.includes(you)) return 'Choisis : pierre, feuille ou ciseaux.';
  const bot = pick(opts);
  const wins = { pierre: 'ciseaux', feuille: 'pierre', ciseaux: 'feuille' };
  const res = you === bot ? 'Égalité.' : wins[you] === bot ? 'Tu gagnes ! 🎉' : 'Je gagne ! 🤖';
  return `Toi : ${you}\nMoi : ${bot}\n${res}`;
});

// ---------- Jeux ----------
cmd('devine', 'jeux', 'Devine un nombre de 1 à 100. Ex : !devine puis !devine 42', ({ jid, args }) => {
  const key = 'devine:' + jid;
  const guess = parseInt(args[0]);
  let g = games.get(key);
  if (!g) {
    g = { n: 1 + rnd(100), tries: 0 }; games.set(key, g);
    if (Number.isNaN(guess)) return "J'ai choisi un nombre entre 1 et 100. Envoie !devine <nombre>.";
  }
  if (Number.isNaN(guess)) return 'Partie en cours. Envoie !devine <nombre>.';
  g.tries++;
  if (guess === g.n) { games.delete(key); return `🎉 Bravo ! C'était ${g.n}, trouvé en ${g.tries} essai(s).`; }
  return guess < g.n ? "C'est plus grand ⬆️" : "C'est plus petit ⬇️";
});
cmd('quiz', 'jeux', 'Pose une question. Réponds avec !rep <réponse>.', ({ jid }) => {
  const q = pick(QUIZ); games.set('quiz:' + jid, q);
  return '❓ ' + q[0] + '\nRéponds avec !rep <ta réponse>';
});
cmd('rep', 'jeux', 'Répond au quiz en cours.', ({ jid, args }) => {
  const q = games.get('quiz:' + jid);
  if (!q) return 'Aucun quiz en cours. Lance !quiz.';
  if (norm(args.join(' ')) === q[1]) { games.delete('quiz:' + jid); return '✅ Bonne réponse !'; }
  return '❌ Raté, essaie encore.';
});

const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const win = (b, p) => LINES.some(l => l.every(i => b[i] === p));
const show = b => [0, 3, 6].map(i => [0, 1, 2].map(j => (b[i + j] === 'X' ? '❌' : b[i + j] === 'O' ? '⭕' : `${i + j + 1}\uFE0F\u20E3`)).join('')).join('\n');
function botMove(b) {
  const free = b.map((v, i) => (v ? null : i)).filter(i => i !== null);
  for (const p of ['O', 'X']) for (const i of free) { b[i] = p; const w = win(b, p); b[i] = ''; if (w) return i; }
  return b[4] ? pick(free) : 4;
}
cmd('morpion', 'jeux', 'Morpion contre le bot. Ex : !morpion puis !morpion 5', ({ jid, args }) => {
  const key = 'morpion:' + jid;
  const pos = parseInt(args[0]);
  let b = games.get(key);
  if (!b) {
    b = Array(9).fill(''); games.set(key, b);
    if (Number.isNaN(pos)) return 'Morpion ! Tu es ❌. Joue avec !morpion <1-9>\n\n' + show(b);
  }
  if (Number.isNaN(pos) || pos < 1 || pos > 9) return 'Joue avec !morpion <1-9>\n\n' + show(b);
  if (b[pos - 1]) return 'Case déjà prise.\n\n' + show(b);
  b[pos - 1] = 'X';
  if (win(b, 'X')) { games.delete(key); return '🎉 Tu as gagné !\n\n' + show(b); }
  if (b.every(Boolean)) { games.delete(key); return 'Égalité.\n\n' + show(b); }
  b[botMove(b)] = 'O';
  if (win(b, 'O')) { games.delete(key); return 'Le bot a gagné 🤖\n\n' + show(b); }
  if (b.every(Boolean)) { games.delete(key); return 'Égalité.\n\n' + show(b); }
  return show(b);
});

// ---------- Groupe ----------
cmd('infogroupe', 'groupe', 'Infos sur le groupe.', async ({ sock, jid }) => {
  const meta = await sock.groupMetadata(jid);
  return `*${meta.subject}*\nMembres : ${meta.participants.length}\nAdmins : ${meta.participants.filter(p => p.admin).length}`;
}, { group: true });
cmd('tagall', 'groupe', 'Mentionne tout le monde (admins).', async ({ sock, jid, args }) => {
  const meta = await sock.groupMetadata(jid);
  const ids = meta.participants.map(p => p.id);
  return { text: (args.join(' ') || 'Appel à tous !') + '\n' + ids.map(id => '@' + id.split('@')[0]).join(' '), mentions: ids };
}, { group: true, admin: true });
cmd('antilien', 'groupe', 'Active ou coupe l\'anti-lien. Ex : !antilien on', ({ jid, args }) => {
  const v = (args[0] || '').toLowerCase();
  if (v === 'on') { antilink.add(jid); return 'Anti-lien activé ✅ (le bot doit être admin pour supprimer les messages).'; }
  if (v === 'off') { antilink.delete(jid); return 'Anti-lien désactivé.'; }
  return `Anti-lien : ${antilink.has(jid) ? 'activé' : 'désactivé'}. Utilise !antilien on ou off.`;
}, { group: true, admin: true });
cmd('kick', 'groupe', 'Retire un membre. Ex : !kick @membre', async ({ sock, jid, m }) => {
  const targets = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  if (!targets.length) return 'Mentionne le membre à retirer.';
  try { await sock.groupParticipantsUpdate(jid, targets, 'remove'); return 'Membre retiré.'; }
  catch { return 'Impossible : le bot doit être admin du groupe.'; }
}, { group: true, admin: true });

// ---------- Traitement des messages ----------
const LINK = /(https?:\/\/|www\.|chat\.whatsapp\.com)/i;

async function handle(sock, m) {
  const jid = m.key.remoteJid;
  if (!jid || jid === 'status@broadcast') return;
  const isGroup = jid.endsWith('@g.us');
  const me = (sock.user?.id || '').split(':')[0] + '@s.whatsapp.net';
  const sender = m.key.fromMe ? me : (m.key.participant || jid);
  const text = (m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || '').trim();
  if (!text) return;
  if (m.key.fromMe && !text.startsWith(PREFIX)) return;

  // Anti-lien : supprime le message, avertit, retire au 3e avertissement
  if (isGroup && !m.key.fromMe && antilink.has(jid) && LINK.test(text)) {
    const meta = await sock.groupMetadata(jid);
    if (!meta.participants.some(p => p.id === sender && p.admin)) {
      try { await sock.sendMessage(jid, { delete: m.key }); } catch {}
      const k = jid + ':' + sender;
      const n = (warns.get(k) || 0) + 1; warns.set(k, n);
      const tag = '@' + sender.split('@')[0];
      if (n >= 3) {
        warns.delete(k);
        await sock.sendMessage(jid, { text: `${tag} a reçu 3 avertissements et est retiré.`, mentions: [sender] });
        try { await sock.groupParticipantsUpdate(jid, [sender], 'remove'); } catch {}
      } else {
        await sock.sendMessage(jid, { text: `⚠️ ${tag}, les liens sont interdits dans ce groupe. Avertissement ${n}/3.`, mentions: [sender] });
      }
      return;
    }
  }

  if (!text.startsWith(PREFIX)) return;
  const [name, ...args] = text.slice(PREFIX.length).split(/\s+/);
  const c = commands[name.toLowerCase()];
  if (!c) return;
  const now = Date.now();
  if (now - (lastCmd.get(sender) || 0) < 1500) return; // anti-spam
  lastCmd.set(sender, now);

  const ctx = { sock, m, jid, sender, args, isGroup };
  let reply;
  try {
    if (c.group && !isGroup) reply = 'Cette commande marche seulement dans un groupe.';
    else if (c.admin) {
      const meta = await sock.groupMetadata(jid);
      reply = meta.participants.some(p => p.id === sender && p.admin) ? await c.run(ctx) : 'Commande réservée aux admins du groupe.';
    } else reply = await c.run(ctx);
  } catch (e) {
    console.error('Erreur commande :', e?.message);
    reply = 'Une erreur est survenue.';
  }
  if (reply) await sock.sendMessage(jid, typeof reply === 'string' ? { text: reply } : reply, { quoted: m });
}

// ---------- Connexion WhatsApp ----------
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version, auth: state, logger, printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'), markOnlineOnConnect: false
  });
  sock.ev.on('creds.update', saveCreds);

  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phone, PAIRING_CODE);
        send({ type: 'pairing', code });
      } catch (e) {
        console.error('Impossible de demander le code :', e?.message);
        send({ type: 'status', status: 'stopped' });
        process.exit(1);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') send({ type: 'status', status: 'online' });
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) { send({ type: 'status', status: 'stopped' }); process.exit(0); }
      send({ type: 'status', status: 'starting' });
      setTimeout(start, 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      if (!m.message) continue;
      const ts = Number(m.messageTimestamp?.toNumber?.() ?? m.messageTimestamp ?? 0);
      if (Date.now() / 1000 - ts > 60) continue; // ignore les vieux messages
      try { await handle(sock, m); } catch (e) { console.error('Erreur message :', e?.message); }
    }
  });
}

process.on('SIGTERM', () => process.exit(0));
start().catch(e => { console.error(e); process.exit(1); });
