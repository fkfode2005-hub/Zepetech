// workers/whatsapp-worker.js
// Lancé par server.js : node whatsapp-worker.js <numéro> <dossier-de-session>
// Écrit des lignes JSON lues par le serveur :
//   {"type":"pairing","code":"ZEPECODE"}  et  {"type":"status","status":"online"}
import crypto from 'node:crypto';
import os from 'node:os';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, proto, downloadMediaMessage, normalizeMessageContent } from '@whiskeysockets/baileys';

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

// Un participant peut être identifié par id, lid ou numéro selon la version de WhatsApp
const sameUser = (p, id) => !!id && (p.id === id || p.lid === id || p.phoneNumber === id);
const isAdminIn = (meta, id) => meta.participants.some(p => sameUser(p, id) && p.admin);
const tagOf = id => '@' + String(id).split('@')[0];

// ---------- Registre de commandes ----------
const commands = Object.create(null);
const CATS = { outils: '🛠 Outils', fun: '🎉 Fun', jeux: '🎮 Jeux', groupe: '👥 Groupe', reglages: '⚙️ Réglages' };
const cmd = (name, cat, help, run, opts = {}) => { commands[name] = { cat, help, run, ...opts }; };

// État en mémoire (remis à zéro quand le bot redémarre)
const games = new Map();
const antilink = new Set();
const antidelete = new Set();
const muted = new Set();
const warns = new Map();
const lastCmd = new Map();
const msgCache = new Map(); // jid:id -> { text, sender } pour !antidelete
const antiImage = new Set(), antiVideo = new Set(), antiSticker = new Set(), antiAudio = new Set();
const antispamSet = new Set(), antitagSet = new Set();
const floodTrack = new Map(); // jid:sender -> { n, start }
let anticallOn = false;
const sudoUsers = new Set();
const prefixes = new Map();   // jid -> préfixe personnalisé
const noPrefixSet = new Set();
const privateChats = new Set();
const autodeleteSet = new Set();
let alwaysOnlineTimer = null;
let currentSock = null;       // connexion active (mise à jour à chaque reconnexion)
const sentByBot = new Map();  // jid -> [clés des derniers messages envoyés par le bot]
const usageCount = new Map(); // jid -> Map(sender -> nombre de commandes)
const awayMsg = new Map();    // jid -> message d'absence
const awayCooldown = new Map();
const welcomeSet = new Set(), goodbyeSet = new Set();
const callWarned = new Map(); // appelant -> dernier message envoyé

function rememberSent(jid, key) {
  const arr = sentByBot.get(jid) || [];
  arr.push(key);
  if (arr.length > 50) arr.shift();
  sentByBot.set(jid, arr);
}

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
cmd('menu', 'outils', 'Affiche le menu. Ex : !menu fun, !menu groupe, !menu tout', ({ args }) => {
  const visible = Object.entries(commands).filter(([, c]) => !c.hidden);
  const q = norm(args[0] || '').replace(/^(\u{1F6E0}|\W)+/u, '');
  const alias = { outil: 'outils', jeu: 'jeux', reglage: 'reglages', settings: 'reglages', group: 'groupe' };
  const cat = alias[q] || q;
  const block = c => {
    const names = visible.filter(([, x]) => x.cat === c).map(([n]) => PREFIX + n);
    return `*${CATS[c]}* (${names.length})\n${names.join('  ')}`;
  };
  if (q === 'tout' || q === 'all') return [`*${BOT_NAME}*`, '', ...Object.keys(CATS).map(block).flatMap(b => [b, ''])].join('\n').trim();
  if (CATS[cat]) return `*${BOT_NAME}*\n\n${block(cat)}\n\nDétails : ${PREFIX}aide <commande>`;
  const lines = [`*${BOT_NAME}* — ${visible.length} commandes`, ''];
  for (const [c, title] of Object.entries(CATS)) lines.push(`${title} : ${PREFIX}menu ${c}  (${visible.filter(([, x]) => x.cat === c).length})`);
  lines.push('', `Tout afficher : ${PREFIX}menu tout`, `Détails : ${PREFIX}aide <commande>`);
  return lines.join('\n');
});
cmd('aide', 'outils', 'Explique une commande. Ex : !aide calc', ({ args }) => {
  const n = (args[0] || '').replace(PREFIX, '').toLowerCase();
  const c = commands[n];
  return c ? `${PREFIX}${n} : ${c.help}` : `Commande inconnue. Tape ${PREFIX}menu.`;
});
cmd('meteo', 'outils', 'Donne la météo actuelle. Ex : !meteo Conakry', async ({ args }) => {
  const ville = args.join(' ').trim();
  if (!ville) return 'Donne une ville. Ex : !meteo Conakry';
  try {
    const geo = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&language=fr&name=' + encodeURIComponent(ville)).then(r => r.json());
    const loc = geo.results?.[0];
    if (!loc) return 'Ville introuvable.';
    const data = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m`).then(r => r.json());
    const c = data.current;
    return `📍 *${loc.name}${loc.country ? ', ' + loc.country : ''}*\n🌡 ${c.temperature_2m}°C\n💧 Humidité : ${c.relative_humidity_2m}%\n💨 Vent : ${c.wind_speed_10m} km/h`;
  } catch { return 'Service météo indisponible pour le moment.'; }
});
cmd('wikipedia', 'outils', 'Résume un sujet Wikipédia. Ex : !wikipedia Guinée', async ({ args }) => {
  const q = args.join(' ').trim();
  if (!q) return 'Donne un sujet. Ex : !wikipedia Guinée';
  try {
    const r = await fetch('https://fr.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(q));
    if (!r.ok) return 'Aucun article trouvé pour ce sujet.';
    const d = await r.json();
    return `*${d.title}*\n${d.extract}${d.content_urls ? '\n' + d.content_urls.desktop.page : ''}`;
  } catch { return 'Service Wikipédia indisponible pour le moment.'; }
});
cmd('sondage', 'outils', 'Crée un sondage. Ex : !sondage Pizza ou burger ? | Pizza | Burger', async ({ sock, jid, args }) => {
  const parts = args.join(' ').split('|').map(s => s.trim()).filter(Boolean);
  if (parts.length < 3) return "Format : !sondage Question | Option1 | Option2 (...)";
  const [question, ...options] = parts;
  if (options.length > 12) return 'Maximum 12 options.';
  await sock.sendMessage(jid, { poll: { name: question, values: options, selectableCount: 1 } });
  return null;
});
cmd('translate', 'outils', 'Traduit un texte. Ex : !translate en Bonjour tout le monde', async ({ args }) => {
  const lang = (args[0] || '').toLowerCase();
  const text = args.slice(1).join(' ');
  if (!lang || !text) return 'Format : !translate <code langue> <texte>. Ex : !translate en Bonjour';
  try {
    const d = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=fr|${encodeURIComponent(lang)}`).then(r => r.json());
    return d.responseData?.translatedText ? '🌐 ' + d.responseData.translatedText : 'Traduction impossible.';
  } catch { return 'Service de traduction indisponible pour le moment.'; }
});
cmd('currency', 'outils', 'Convertit une devise. Ex : !currency 100 USD EUR', async ({ args }) => {
  const [amountStr, from, to] = args;
  const amount = Number(amountStr);
  if (!amount || !from || !to) return 'Format : !currency <montant> <de> <vers>. Ex : !currency 100 USD EUR';
  try {
    const d = await fetch(`https://api.frankfurter.app/latest?amount=${amount}&from=${from.toUpperCase()}&to=${to.toUpperCase()}`).then(r => r.json());
    const v = d.rates?.[to.toUpperCase()];
    return v ? `${amount} ${from.toUpperCase()} = ${v} ${to.toUpperCase()}` : 'Devise inconnue.';
  } catch { return 'Service de conversion indisponible pour le moment.'; }
});
cmd('crypto', 'outils', 'Prix d\'une cryptomonnaie. Ex : !crypto bitcoin', async ({ args }) => {
  const id = (args[0] || '').toLowerCase();
  if (!id) return 'Donne le nom de la cryptomonnaie. Ex : !crypto bitcoin';
  try {
    const d = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd,eur`).then(r => r.json());
    const v = d[id];
    return v ? `💰 ${id} : $${v.usd} / €${v.eur}` : 'Cryptomonnaie inconnue.';
  } catch { return 'Service indisponible pour le moment.'; }
});
cmd('shorturl', 'outils', 'Raccourcit un lien. Ex : !shorturl https://exemple.com', async ({ args }) => {
  const url = args[0];
  if (!url || !/^https?:\/\//i.test(url)) return 'Donne un lien valide commençant par http(s)://';
  try {
    const r = await fetch('https://is.gd/create.php?format=simple&url=' + encodeURIComponent(url));
    const t = await r.text();
    return t.startsWith('http') ? t : 'Impossible de raccourcir ce lien.';
  } catch { return 'Service indisponible pour le moment.'; }
});
cmd('livre', 'outils', 'Cherche un livre. Ex : !livre Le Petit Prince', async ({ args }) => {
  const q = args.join(' ');
  if (!q) return 'Donne un titre. Ex : !livre Le Petit Prince';
  try {
    const d = await fetch('https://openlibrary.org/search.json?title=' + encodeURIComponent(q) + '&limit=1').then(r => r.json());
    const b = d.docs?.[0];
    if (!b) return 'Aucun livre trouvé.';
    return `📖 *${b.title}*\nAuteur(s) : ${(b.author_name || []).join(', ') || 'inconnu'}\nAnnée : ${b.first_publish_year || '?'}`;
  } catch { return 'Service indisponible pour le moment.'; }
});
cmd('joursferies', 'outils', 'Prochains jours fériés. Ex : !joursferies FR', async ({ args }) => {
  const country = (args[0] || 'FR').toUpperCase();
  try {
    const r = await fetch('https://date.nager.at/api/v3/NextPublicHolidays/' + country);
    if (!r.ok) return 'Pays non pris en charge par ce service.';
    const d = await r.json();
    if (!d.length) return 'Aucune donnée disponible.';
    return '📅 Prochains jours fériés (' + country + ') :\n' + d.slice(0, 5).map(h => `${h.date} — ${h.localName}`).join('\n');
  } catch { return 'Service indisponible pour le moment.'; }
});
cmd('qrcode', 'outils', 'Génère un QR code. Ex : !qrcode https://exemple.com', async ({ sock, jid, args, m }) => {
  const text = args.join(' ');
  if (!text) return 'Donne un texte ou un lien. Ex : !qrcode https://exemple.com';
  const url = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(text);
  await sock.sendMessage(jid, { image: { url }, caption: '📱 QR code' }, { quoted: m });
  return null;
});
cmd('store', 'outils', 'Infos sur les packs de coins.', () => "💰 Achète des coins et des slots depuis ton tableau de bord ZEPE TECH, dans la section « Acheter des coins ».");
cmd('hosting', 'outils', "Infos sur l'hébergement du bot.", () => "🌐 Ce bot tourne sur l'infrastructure ZEPE TECH. Démarre, arrête ou surveille-le depuis ton tableau de bord.");
cmd('ranking', 'outils', 'Classement des membres les plus actifs ici.', ({ jid }) => {
  const u = usageCount.get(jid);
  if (!u || !u.size) return 'Aucune activité enregistrée pour le moment.';
  const top = [...u.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  return {
    text: '🏆 Classement :\n' + top.map(([id, n], i) => `${i + 1}. ${tagOf(id)} — ${n} commande(s)`).join('\n'),
    mentions: top.map(([id]) => id)
  };
});
cmd('respondeur', 'groupe', "Message d'absence automatique. Ex : !respondeur on Je reviens vite !", ({ jid, args }) => {
  const v = (args[0] || '').toLowerCase();
  if (v === 'off') { awayMsg.delete(jid); return 'Répondeur désactivé.'; }
  if (v === 'on') {
    const msg = args.slice(1).join(' ') || 'Je ne suis pas disponible pour le moment.';
    awayMsg.set(jid, msg);
    return 'Répondeur activé ✅';
  }
  return `Répondeur : ${awayMsg.has(jid) ? 'activé' : 'désactivé'}. Utilise !respondeur on <message> ou !respondeur off.`;
});
cmd('listcommands', 'outils', 'Liste toutes les commandes, sans détail.', () => Object.entries(commands).filter(([, c]) => !c.hidden).map(([n]) => n).sort().map(n => PREFIX + n).join('  '));
cmd('doc', 'outils', 'Comment utiliser le bot.', () => `Tape ${PREFIX}menu pour voir les catégories, ou ${PREFIX}aide <commande> pour le détail d'une commande.`);

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

const CARDS = [
  ['Le Soleil', 'Réussite, clarté, énergie positive.'],
  ["L'Étoile", 'Espoir, inspiration, bonne étoile.'],
  ['La Lune', 'Intuition, doute, prends ton temps.'],
  ['Le Monde', 'Accomplissement, un cycle se termine bien.'],
  ['La Force', 'Courage, patience, maîtrise de soi.'],
  ['La Roue de Fortune', 'Changement, un tournant arrive.'],
  ["L'Ermite", 'Introspection, cherche en toi la réponse.'],
  ['Le Jugement', 'Un nouveau départ, une décision à prendre.']
];
cmd('catfact', 'fun', 'Un fait amusant sur les chats (en anglais).', async () => {
  try { const d = await fetch('https://catfact.ninja/fact').then(r => r.json()); return '🐱 ' + d.fact; }
  catch { return 'Service indisponible pour le moment.'; }
});
cmd('dogpic', 'fun', "Envoie une photo de chien au hasard.", async ({ sock, jid, m }) => {
  try {
    const d = await fetch('https://dog.ceo/api/breeds/image/random').then(r => r.json());
    await sock.sendMessage(jid, { image: { url: d.message }, caption: '🐶 Woof !' }, { quoted: m });
    return null;
  } catch { return 'Service indisponible pour le moment.'; }
});
cmd('chucknorris', 'fun', 'Une blague Chuck Norris (en anglais).', async () => {
  try { const d = await fetch('https://api.chucknorris.io/jokes/random').then(r => r.json()); return '🥋 ' + d.value; }
  catch { return 'Service indisponible pour le moment.'; }
});
cmd('citation', 'fun', 'Une citation inspirante.', () => '💬 ' + pick(QUOTES));
cmd('xkcd', 'fun', 'La dernière bande dessinée xkcd (en anglais).', async ({ sock, jid, m }) => {
  try {
    const d = await fetch('https://xkcd.com/info.0.json').then(r => r.json());
    await sock.sendMessage(jid, { image: { url: d.img }, caption: `*${d.title}*\n${d.alt}` }, { quoted: m });
    return null;
  } catch { return 'Service indisponible pour le moment.'; }
});
cmd('carte', 'fun', 'Tire une carte au hasard.', () => {
  const [name, meaning] = pick(CARDS);
  return `🃏 *${name}*\n${meaning}`;
});

const FRAKTUR_UP = { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' };
function toFraktur(str) {
  return str.replace(/[a-zA-Z]/g, ch => {
    if (ch >= 'a' && ch <= 'z') return String.fromCodePoint(0x1D51E + (ch.charCodeAt(0) - 97));
    if (FRAKTUR_UP[ch]) return FRAKTUR_UP[ch];
    return String.fromCodePoint(0x1D504 + (ch.charCodeAt(0) - 65));
  });
}
cmd('fancy', 'fun', 'Écrit ton texte en style gothique. Ex : !fancy Zepe Tech', ({ args }) => {
  const t = args.join(' ');
  return t ? toFraktur(t) : 'Écris un texte après la commande.';
});
cmd('ascii', 'fun', 'Encadre ton texte façon bannière. Ex : !ascii Zepe Tech', ({ args }) => {
  const t = args.join(' ').slice(0, 40);
  if (!t) return 'Écris un texte après la commande.';
  const line = '━'.repeat(t.length + 4);
  return `╭${line}╮\n│  ${t.toUpperCase()}  │\n╰${line}╯`;
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

const ANA_WORDS = ['guinee', 'conakry', 'whatsapp', 'ordinateur', 'telephone', 'montagne', 'riviere', 'bibliotheque', 'elephant', 'soleil'].map(norm);
cmd('math', 'jeux', 'Petit calcul mental. Réponds avec !math <nombre>.', ({ jid, args }) => {
  const key = 'math:' + jid;
  const guess = parseInt(args[0]);
  let g = games.get(key);
  if (!g) {
    const a = 1 + rnd(50), b = 1 + rnd(50), op = pick(['+', '-', '*']);
    const r = op === '+' ? a + b : op === '-' ? a - b : a * b;
    g = { r, q: `${a} ${op} ${b}` }; games.set(key, g);
    if (Number.isNaN(guess)) return `🧮 Combien font ${g.q} ? Réponds avec !math <nombre>.`;
  }
  if (Number.isNaN(guess)) return `Partie en cours : ${g.q} ? Réponds avec !math <nombre>.`;
  if (guess === g.r) { games.delete(key); return '🎉 Bravo, bonne réponse !'; }
  games.delete(key);
  return `❌ Raté, c'était ${g.r}. Tape !math pour rejouer.`;
});
cmd('anagramme', 'jeux', 'Devine le mot mélangé. Ex : !anagramme puis !anagramme <mot>', ({ jid, args }) => {
  const key = 'ana:' + jid;
  let g = games.get(key);
  if (!g) {
    const word = pick(ANA_WORDS).replace(/\s/g, '');
    const letters = word.split('');
    let mixed; do { mixed = letters.slice().sort(() => Math.random() - 0.5).join(''); } while (mixed === word);
    g = { word, mixed }; games.set(key, g);
    return `🔤 Remets les lettres dans l'ordre : *${mixed.toUpperCase()}*\nRéponds avec !anagramme <mot>`;
  }
  const guess = norm(args.join(''));
  if (!guess) return `Lettres : *${g.mixed.toUpperCase()}*\nRéponds avec !anagramme <mot>`;
  if (guess === g.word) { games.delete(key); return '🎉 Bravo, trouvé !'; }
  return '❌ Pas encore, réessaie.';
});

// ---------- Groupe ----------
cmd('infogroupe', 'groupe', 'Infos sur le groupe.', async ({ sock, jid }) => {
  const meta = await sock.groupMetadata(jid);
  return `*${meta.subject}*\nMembres : ${meta.participants.length}\nAdmins : ${meta.participants.filter(p => p.admin).length}`;
}, { group: true });
cmd('tagall', 'groupe', 'Mentionne tout le monde (admins).', async ({ sock, jid, args }) => {
  const meta = await sock.groupMetadata(jid);
  const ids = meta.participants.map(p => p.id);
  return { text: (args.join(' ') || 'Appel à tous !') + '\n' + ids.map(tagOf).join(' '), mentions: ids };
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
cmd('kickall', 'groupe', 'Retire tous les membres non-admins (confirmation requise). Ex : !kickall confirmer', async ({ sock, jid, args, sender }) => {
  if ((args[0] || '').toLowerCase() !== 'confirmer') return "⚠️ Action irréversible. Tape !kickall confirmer pour retirer tous les membres non-admins.";
  const meta = await sock.groupMetadata(jid);
  const targets = meta.participants.filter(p => !p.admin && !sameUser(p, sender)).map(p => p.id);
  if (!targets.length) return 'Aucun membre non-admin à retirer.';
  try { await sock.groupParticipantsUpdate(jid, targets, 'remove'); return `${targets.length} membre(s) retiré(s).`; }
  catch { return 'Impossible : le bot doit être admin du groupe.'; }
}, { group: true, admin: true });
cmd('promote', 'groupe', 'Rend un membre admin. Ex : !promote @membre', async ({ sock, jid, m }) => {
  const targets = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  if (!targets.length) return 'Mentionne le membre à promouvoir.';
  try { await sock.groupParticipantsUpdate(jid, targets, 'promote'); return 'Membre promu admin ✅'; }
  catch { return 'Impossible : le bot doit être admin du groupe.'; }
}, { group: true, admin: true });
cmd('demote', 'groupe', "Retire les droits admin. Ex : !demote @membre", async ({ sock, jid, m }) => {
  const targets = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  if (!targets.length) return 'Mentionne un admin à rétrograder.';
  try { await sock.groupParticipantsUpdate(jid, targets, 'demote'); return 'Droits admin retirés.'; }
  catch { return 'Impossible : le bot doit être admin du groupe.'; }
}, { group: true, admin: true });
cmd('mute', 'groupe', 'Rend un membre muet dans le groupe. Ex : !mute @membre', ({ jid, m }) => {
  const targets = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  if (!targets.length) return 'Mentionne le membre à rendre muet.';
  targets.forEach(t => muted.add(jid + ':' + t));
  return 'Membre rendu muet : ses messages seront supprimés (le bot doit être admin).';
}, { group: true, admin: true });
cmd('demute', 'groupe', 'Redonne la parole à un membre. Ex : !demute @membre', ({ jid, m }) => {
  const targets = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  if (!targets.length) return 'Mentionne le membre concerné.';
  targets.forEach(t => muted.delete(jid + ':' + t));
  return 'Membre réautorisé à parler.';
}, { group: true, admin: true });
cmd('grouplink', 'groupe', "Donne le lien d'invitation du groupe.", async ({ sock, jid }) => {
  try { const code = await sock.groupInviteCode(jid); return 'https://chat.whatsapp.com/' + code; }
  catch { return 'Impossible : le bot doit être admin du groupe.'; }
}, { group: true, admin: true });
cmd('revokelink', 'groupe', "Révoque et régénère le lien d'invitation.", async ({ sock, jid }) => {
  try { const code = await sock.groupRevokeInvite(jid); return 'Ancien lien révoqué. Nouveau lien :\nhttps://chat.whatsapp.com/' + code; }
  catch { return 'Impossible : le bot doit être admin du groupe.'; }
}, { group: true, admin: true });
commands.revoke = { ...commands.revokelink, hidden: true }; // alias caché du menu
cmd('getid', 'groupe', "Affiche l'identifiant du chat et de l'expéditeur.", ({ jid, sender, isGroup }) =>
  `Chat : ${jid}\nExpéditeur : ${sender}\nType : ${isGroup ? 'groupe' : 'privé'}`);
cmd('getpp', 'groupe', "Donne la photo de profil d'un membre. Ex : !getpp @membre", async ({ sock, jid, m, sender }) => {
  const targets = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  const target = targets[0] || sender;
  try {
    const url = await sock.profilePictureUrl(target, 'image');
    await sock.sendMessage(jid, { image: { url }, caption: 'Photo de profil' }, { quoted: m });
    return null;
  } catch { return "Aucune photo de profil publique pour ce membre."; }
});
cmd('antidelete', 'groupe', 'Republie les messages supprimés. Ex : !antidelete on', ({ jid, args }) => {
  const v = (args[0] || '').toLowerCase();
  if (v === 'on') { antidelete.add(jid); return 'Anti-suppression activé ✅'; }
  if (v === 'off') { antidelete.delete(jid); return 'Anti-suppression désactivé.'; }
  return `Anti-suppression : ${antidelete.has(jid) ? 'activé' : 'désactivé'}. Utilise !antidelete on ou off.`;
}, { group: true, admin: true });
cmd('block', 'groupe', 'Bloque un numéro (propriétaire du bot uniquement). Ex : !block @contact', async ({ sock, m, sender }) => {
  if (!m.key.fromMe) return "Réservé au propriétaire du bot.";
  const targets = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [sender];
  try { await sock.updateBlockStatus(targets[0], 'block'); return 'Contact bloqué.'; } catch { return 'Échec du blocage.'; }
});
cmd('unblock', 'groupe', 'Débloque un numéro (propriétaire du bot uniquement). Ex : !unblock @contact', async ({ sock, m, sender }) => {
  if (!m.key.fromMe) return "Réservé au propriétaire du bot.";
  const targets = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [sender];
  try { await sock.updateBlockStatus(targets[0], 'unblock'); return 'Contact débloqué.'; } catch { return 'Échec du déblocage.'; }
});

function antiMediaToggle(set, label) {
  return ({ jid, args }) => {
    const v = (args[0] || '').toLowerCase();
    if (v === 'on') { set.add(jid); return `Anti-${label} activé ✅ (le bot doit être admin).`; }
    if (v === 'off') { set.delete(jid); return `Anti-${label} désactivé.`; }
    return `Anti-${label} : ${set.has(jid) ? 'activé' : 'désactivé'}. Utilise on ou off.`;
  };
}
cmd('antiimage', 'groupe', "Supprime les images des non-admins. Ex : !antiimage on", antiMediaToggle(antiImage, 'image'), { group: true, admin: true });
cmd('antivideo', 'groupe', "Supprime les vidéos des non-admins. Ex : !antivideo on", antiMediaToggle(antiVideo, 'vidéo'), { group: true, admin: true });
cmd('antisticker', 'groupe', "Supprime les stickers des non-admins. Ex : !antisticker on", antiMediaToggle(antiSticker, 'sticker'), { group: true, admin: true });
cmd('antiaudio', 'groupe', "Supprime les messages vocaux des non-admins. Ex : !antiaudio on", antiMediaToggle(antiAudio, 'audio'), { group: true, admin: true });
cmd('antispam', 'groupe', 'Avertit les membres qui envoient trop de messages. Ex : !antispam on', antiMediaToggle(antispamSet, 'spam'), { group: true, admin: true });
cmd('antitag', 'groupe', 'Supprime les mentions en masse des non-admins. Ex : !antitag on', antiMediaToggle(antitagSet, 'tag'), { group: true, admin: true });
cmd('admincheck', 'groupe', 'Liste les admins du groupe.', async ({ sock, jid }) => {
  const meta = await sock.groupMetadata(jid);
  const admins = meta.participants.filter(p => p.admin);
  if (!admins.length) return 'Aucun admin trouvé.';
  return { text: '👑 Admins :\n' + admins.map(a => tagOf(a.id)).join('\n'), mentions: admins.map(a => a.id) };
}, { group: true });
cmd('tagadmin', 'groupe', 'Mentionne uniquement les admins.', async ({ sock, jid, args }) => {
  const meta = await sock.groupMetadata(jid);
  const admins = meta.participants.filter(p => p.admin);
  if (!admins.length) return 'Aucun admin trouvé.';
  return { text: (args.join(' ') || 'Appel aux admins !') + '\n' + admins.map(a => tagOf(a.id)).join(' '), mentions: admins.map(a => a.id) };
}, { group: true });
cmd('clean', 'groupe', 'Supprime les derniers messages envoyés par le bot ici.', async ({ sock, jid }) => {
  const keys = sentByBot.get(jid) || [];
  for (const k of keys) { try { await sock.sendMessage(jid, { delete: k }); } catch {} }
  sentByBot.set(jid, []);
  return null;
}, { group: true, admin: true });
cmd('resetchat', 'groupe', "Efface l'état du bot pour ce chat (jeux, avertissements).", ({ jid }) => {
  for (const k of [...games.keys()]) if (k.endsWith(':' + jid)) games.delete(k);
  for (const k of [...warns.keys()]) if (k.startsWith(jid + ':')) warns.delete(k);
  return 'État du chat réinitialisé.';
}, { group: true, admin: true });
cmd('mystatus', 'groupe', 'Ton statut dans ce groupe.', async ({ sock, jid, sender }) => {
  const meta = await sock.groupMetadata(jid);
  const isAdmin = isAdminIn(meta, sender);
  const n = warns.get(jid + ':' + sender) || 0;
  const isMuted = muted.has(jid + ':' + sender);
  return `Rôle : ${isAdmin ? 'admin' : 'membre'}\nAvertissements : ${n}/3\nMuet : ${isMuted ? 'oui' : 'non'}`;
}, { group: true });
cmd('welcome', 'groupe', "Message de bienvenue automatique. Ex : !welcome on", ({ jid, args }) => {
  const v = (args[0] || '').toLowerCase();
  if (v === 'on') { welcomeSet.add(jid); return 'Message de bienvenue activé ✅'; }
  if (v === 'off') { welcomeSet.delete(jid); return 'Message de bienvenue désactivé.'; }
  return `Bienvenue : ${welcomeSet.has(jid) ? 'activé' : 'désactivé'}. Utilise on ou off.`;
}, { group: true, admin: true });
cmd('goodbye', 'groupe', "Message d'au revoir automatique. Ex : !goodbye on", ({ jid, args }) => {
  const v = (args[0] || '').toLowerCase();
  if (v === 'on') { goodbyeSet.add(jid); return "Message d'au revoir activé ✅"; }
  if (v === 'off') { goodbyeSet.delete(jid); return "Message d'au revoir désactivé."; }
  return `Au revoir : ${goodbyeSet.has(jid) ? 'activé' : 'désactivé'}. Utilise on ou off.`;
}, { group: true, admin: true });
cmd('leave', 'groupe', 'Fait quitter le bot de ce groupe (propriétaire uniquement).', async ({ sock, jid, m }) => {
  if (!m.key.fromMe) return 'Réservé au propriétaire du bot.';
  await sock.sendMessage(jid, { text: 'À bientôt 👋' });
  await sock.groupLeave(jid);
  return null;
}, { group: true });
cmd('vcfgroupe', 'groupe', 'Exporte les numéros du groupe en fichier .vcf.', async ({ sock, jid, m }) => {
  const meta = await sock.groupMetadata(jid);
  const vcf = meta.participants.map(p => {
    const num = (p.phoneNumber || p.id).split('@')[0];
    return `BEGIN:VCARD\nVERSION:3.0\nFN:Membre ${num}\nTEL;TYPE=CELL:+${num}\nEND:VCARD`;
  }).join('\n');
  await sock.sendMessage(jid, { document: Buffer.from(vcf, 'utf8'), mimetype: 'text/vcard', fileName: 'groupe.vcf' }, { quoted: m });
  return null;
}, { group: true, admin: true });
cmd('setgpp', 'groupe', "Change la photo du groupe (réponds à une image).", async ({ sock, jid, m }) => {
  const ctxInfo = m.message?.extendedTextMessage?.contextInfo;
  if (!ctxInfo?.quotedMessage?.imageMessage) return 'Réponds à une image avec cette commande.';
  try {
    const quoted = { key: { remoteJid: jid, id: ctxInfo.stanzaId, participant: ctxInfo.participant }, message: ctxInfo.quotedMessage };
    const buffer = await downloadMediaMessage(quoted, 'buffer', {});
    await sock.updateProfilePicture(jid, buffer);
    return 'Photo du groupe mise à jour ✅';
  } catch { return "Échec : le bot doit être admin et l'image doit être valide."; }
}, { group: true, admin: true });
cmd('setgdesc', 'groupe', 'Change la description du groupe. Ex : !setgdesc Bienvenue !', async ({ sock, jid, args }) => {
  const desc = args.join(' ');
  if (!desc) return 'Écris une description après la commande.';
  try { await sock.groupUpdateDescription(jid, desc); return 'Description mise à jour ✅'; }
  catch { return 'Impossible : le bot doit être admin du groupe.'; }
}, { group: true, admin: true });

// ---------- Réglages ----------
cmd('setprefix', 'reglages', 'Change le préfixe des commandes ici. Ex : !setprefix #', ({ jid, args, m }) => {
  if (!m.key.fromMe) return 'Réservé au propriétaire du bot.';
  const p = args[0];
  if (!p || p.length > 3) return 'Donne un préfixe court. Ex : !setprefix #';
  prefixes.set(jid, p);
  return `Préfixe changé en "${p}" pour ce chat.`;
});
cmd('noprefix', 'reglages', "Active ou coupe l'usage sans préfixe ici. Ex : !noprefix on", ({ jid, args, m }) => {
  if (!m.key.fromMe) return 'Réservé au propriétaire du bot.';
  const v = (args[0] || '').toLowerCase();
  if (v === 'on') { noPrefixSet.add(jid); return 'Les commandes marchent maintenant sans préfixe ici.'; }
  if (v === 'off') { noPrefixSet.delete(jid); return 'Préfixe de nouveau obligatoire ici.'; }
  return `Sans préfixe : ${noPrefixSet.has(jid) ? 'activé' : 'désactivé'}. Utilise on ou off.`;
});
cmd('setprivate', 'reglages', 'Seul le propriétaire pourra utiliser les commandes ici.', ({ jid, m }) => {
  if (!m.key.fromMe) return 'Réservé au propriétaire du bot.';
  privateChats.add(jid); return 'Mode privé activé pour ce chat.';
});
cmd('setpublic', 'reglages', 'Tout le monde pourra utiliser les commandes ici.', ({ jid, m }) => {
  if (!m.key.fromMe) return 'Réservé au propriétaire du bot.';
  privateChats.delete(jid); return 'Mode public activé pour ce chat.';
});
cmd('autodelete', 'reglages', 'Supprime les réponses du bot après 30s ici. Ex : !autodelete on', ({ jid, args }) => {
  const v = (args[0] || '').toLowerCase();
  if (v === 'on') { autodeleteSet.add(jid); return 'Auto-suppression activée (30s) ✅'; }
  if (v === 'off') { autodeleteSet.delete(jid); return 'Auto-suppression désactivée.'; }
  return `Auto-suppression : ${autodeleteSet.has(jid) ? 'activée' : 'désactivée'}. Utilise on ou off.`;
}, { group: true, admin: true });
cmd('alwaysonline', 'reglages', 'Garde le bot toujours visible en ligne. Ex : !alwaysonline on', ({ args, m }) => {
  if (!m.key.fromMe) return 'Réservé au propriétaire du bot.';
  const v = (args[0] || '').toLowerCase();
  if (v === 'on') {
    if (alwaysOnlineTimer) return 'Déjà activé.';
    const ping = () => currentSock?.sendPresenceUpdate('available').catch(() => {});
    ping();
    alwaysOnlineTimer = setInterval(ping, 60000); // utilise toujours la connexion active, même après une reconnexion
    return 'Toujours en ligne activé ✅';
  }
  if (v === 'off') {
    if (alwaysOnlineTimer) { clearInterval(alwaysOnlineTimer); alwaysOnlineTimer = null; }
    return 'Toujours en ligne désactivé.';
  }
  return `Toujours en ligne : ${alwaysOnlineTimer ? 'activé' : 'désactivé'}. Utilise on ou off.`;
});
cmd('anticall', 'reglages', 'Rejette automatiquement les appels. Ex : !anticall on', ({ args, m }) => {
  if (!m.key.fromMe) return 'Réservé au propriétaire du bot.';
  const v = (args[0] || '').toLowerCase();
  if (v === 'on') { anticallOn = true; return 'Anti-appel activé ✅ Les appels entrants seront rejetés.'; }
  if (v === 'off') { anticallOn = false; return 'Anti-appel désactivé.'; }
  return `Anti-appel : ${anticallOn ? 'activé' : 'désactivé'}. Utilise on ou off.`;
});
cmd('setpp', 'reglages', "Change la photo du bot (réponds à une image).", async ({ sock, m }) => {
  if (!m.key.fromMe) return 'Réservé au propriétaire du bot.';
  const ctxInfo = m.message?.extendedTextMessage?.contextInfo;
  if (!ctxInfo?.quotedMessage?.imageMessage) return 'Réponds à une image avec cette commande.';
  try {
    const jidQ = m.key.remoteJid;
    const quoted = { key: { remoteJid: jidQ, id: ctxInfo.stanzaId, participant: ctxInfo.participant }, message: ctxInfo.quotedMessage };
    const buffer = await downloadMediaMessage(quoted, 'buffer', {});
    const me = (sock.user?.id || '').split(':')[0].split('@')[0] + '@s.whatsapp.net';
    await sock.updateProfilePicture(me, buffer);
    return 'Photo du bot mise à jour ✅';
  } catch { return 'Échec : image invalide.'; }
});
cmd('sendstory', 'reglages', 'Publie un statut texte sur WhatsApp. Ex : !sendstory Bonjour !', async ({ sock, args, m }) => {
  if (!m.key.fromMe) return 'Réservé au propriétaire du bot.';
  const text = args.join(' ');
  if (!text) return 'Écris un texte après la commande.';
  try { await sock.sendMessage('status@broadcast', { text }); return 'Statut publié ✅'; }
  catch { return 'Échec de la publication du statut.'; }
});
cmd('sudo', 'reglages', 'Gère les utilisateurs sudo. Ex : !sudo add @membre / remove @membre / list', ({ args, m }) => {
  if (!m.key.fromMe) return 'Réservé au propriétaire du bot.';
  const sub = (args[0] || '').toLowerCase();
  const targets = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  if (sub === 'add') { if (!targets.length) return 'Mentionne un membre.'; targets.forEach(t => sudoUsers.add(t)); return 'Ajouté(s) comme sudo.'; }
  if (sub === 'remove') { if (!targets.length) return 'Mentionne un membre.'; targets.forEach(t => sudoUsers.delete(t)); return 'Retiré(s) des sudo.'; }
  if (sub === 'list') {
    if (!sudoUsers.size) return 'Aucun utilisateur sudo.';
    const ids = [...sudoUsers];
    return { text: '🔑 Sudo :\n' + ids.map(tagOf).join('\n'), mentions: ids };
  }
  return 'Utilise : !sudo add/remove/list';
});
cmd('restart', 'reglages', 'Redémarre le bot (propriétaire uniquement).', async ({ sock, jid, m }) => {
  if (!m.key.fromMe) return 'Réservé au propriétaire du bot.';
  await sock.sendMessage(jid, { text: 'Redémarrage... relance-le depuis ton tableau de bord si besoin.' });
  setTimeout(() => process.exit(0), 500);
  return null;
});

// ---------- Commandes supplémentaires ----------
const T = args => args.join(' ');
const mentionsOf = m => m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
const quotedOf = m => m.message?.extendedTextMessage?.contextInfo?.participant;
const targetsOf = m => { const t = mentionsOf(m); if (t.length) return t; const q = quotedOf(m); return q ? [q] : []; };
const NOT_OWNER = 'Réservé au propriétaire du bot.';
const NEED_ADMIN = 'Impossible : le bot doit être admin du groupe.';
const DOWN = 'Service indisponible pour le moment.';
const N = (args, i) => parseFloat(String(args[i] ?? '').replace(',', '.'));
const fmt = n => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6));
const hashPct = s => parseInt(crypto.createHash('sha256').update(s).digest('hex').slice(0, 8), 16) % 101;
const today = () => new Date().toISOString().slice(0, 10);
const listCmd = (name, cat, help, arr, prefix = '') => cmd(name, cat, help, () => prefix + pick(arr));
const getJson = async url => { const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
const startedAt = Date.now();

const bannedUsers = new Set(), antipromoteSet = new Set(), antidemoteSet = new Set();
const forbidden = new Map(), rulesMap = new Map(), afkMap = new Map();
let autoreadOn = false, autoreactOn = false;

// ----- Texte -----
const textCmd = (name, help, fn) => cmd(name, 'outils', help, ({ args }) => { const t = T(args); return t ? fn(t) : 'Écris un texte après la commande.'; });
textCmd('majuscules', 'Met le texte en MAJUSCULES.', t => t.toUpperCase());
textCmd('minuscules', 'Met le texte en minuscules.', t => t.toLowerCase());
textCmd('inverser', 'Inverse le texte.', t => [...t].reverse().join(''));
textCmd('longueur', 'Compte les caractères.', t => `Longueur : ${[...t].length} caractère(s).`);
textCmd('mots', 'Compte les mots.', t => `Mots : ${t.split(/\s+/).filter(Boolean).length}`);
textCmd('palindrome', 'Teste si un texte est un palindrome.', t => {
  const s = norm(t).replace(/[^a-z0-9]/g, '');
  return s && s === [...s].reverse().join('') ? "✅ Oui, c'est un palindrome." : "❌ Non, ce n'est pas un palindrome.";
});
textCmd('base64', 'Encode en base64.', t => Buffer.from(t).toString('base64'));
textCmd('debase64', 'Décode du base64.', t => Buffer.from(t, 'base64').toString('utf8') || 'Base64 invalide.');
textCmd('hex', 'Texte vers hexadécimal.', t => Buffer.from(t).toString('hex'));
textCmd('binaire', 'Texte vers binaire.', t => [...Buffer.from(t)].map(b => b.toString(2).padStart(8, '0')).join(' '));
textCmd('debinaire', 'Binaire (octets séparés par des espaces) vers texte.', t => {
  const p = t.split(/\s+/);
  if (!p.every(x => /^[01]{8}$/.test(x))) return 'Donne des octets de 8 bits séparés par des espaces.';
  return Buffer.from(p.map(x => parseInt(x, 2))).toString('utf8');
});
const MORSE = { a: '.-', b: '-...', c: '-.-.', d: '-..', e: '.', f: '..-.', g: '--.', h: '....', i: '..', j: '.---', k: '-.-', l: '.-..', m: '--', n: '-.', o: '---', p: '.--.', q: '--.-', r: '.-.', s: '...', t: '-', u: '..-', v: '...-', w: '.--', x: '-..-', y: '-.--', z: '--..', 0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.' };
const UNMORSE = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));
textCmd('morse', 'Texte vers morse.', t => norm(t).split('').map(c => (c === ' ' ? '/' : MORSE[c] || '')).filter(Boolean).join(' '));
textCmd('demorse', 'Morse vers texte (lettres séparées par un espace, mots par /).', t => t.split(/\s+/).map(x => (x === '/' ? ' ' : UNMORSE[x] || '?')).join(''));
textCmd('rot13', 'Chiffrement ROT13.', t => t.replace(/[a-z]/gi, c => { const b = c <= 'Z' ? 65 : 97; return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b); }));
textCmd('leet', 'Écrit en langage leet.', t => t.replace(/[aeiost]/gi, c => ({ a: '4', e: '3', i: '1', o: '0', s: '5', t: '7' })[c.toLowerCase()]));
textCmd('mock', 'tExTe aLtErNé.', t => [...t].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join(''));
textCmd('espaces', 'Espace chaque lettre.', t => [...t].join(' '));
textCmd('voyelles', 'Compte les voyelles.', t => `Voyelles : ${(t.match(/[aeiouyàâäéèêëîïôöùûü]/gi) || []).length}`);
textCmd('sha256', 'Empreinte SHA-256.', t => crypto.createHash('sha256').update(t).digest('hex'));
textCmd('md5', 'Empreinte MD5.', t => crypto.createHash('md5').update(t).digest('hex'));
textCmd('capitaliser', 'Majuscule à chaque mot.', t => t.toLowerCase().replace(/(^|\s)\S/g, s => s.toUpperCase()));
cmd('uuid', 'outils', 'Génère un identifiant unique.', () => crypto.randomUUID());
textCmd('slug', 'Transforme un texte en slug. Ex : !slug Mon Titre', t => norm(t).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
cmd('repeter', 'outils', 'Répète un texte. Ex : !repeter 3 salut', ({ args }) => {
  const n = Math.min(20, parseInt(args[0]));
  const t = args.slice(1).join(' ');
  if (!n || n < 1 || !t) return 'Format : !repeter <nombre> <texte>';
  return Array(n).fill(t).join(' ').slice(0, 1000);
});
textCmd('clap', 'Ajoute des 👏 entre les mots.', t => t.split(/\s+/).join(' 👏 '));

// ----- Maths et conversions -----
cmd('pourcentage', 'outils', 'Calcule un pourcentage. Ex : !pourcentage 15 200', ({ args }) => {
  const p = N(args, 0), v = N(args, 1);
  if (Number.isNaN(p) || Number.isNaN(v)) return 'Format : !pourcentage <pourcent> <valeur>';
  return `${fmt(p)} % de ${fmt(v)} = ${fmt((p * v) / 100)}`;
});
const conv = (name, help, label, fn) => cmd(name, 'outils', help, ({ args }) => {
  const v = N(args, 0);
  if (Number.isNaN(v)) return `Format : !${name} <nombre>`;
  const r = fn(v);
  return Number.isFinite(r) ? label(v, r) : 'Calcul impossible.';
});
conv('carre', 'Carré d\'un nombre.', (v, r) => `${fmt(v)}² = ${fmt(r)}`, v => v * v);
conv('racine', 'Racine carrée.', (v, r) => `√${fmt(v)} = ${fmt(r)}`, v => Math.sqrt(v));
cmd('puissance', 'outils', 'Élève à une puissance. Ex : !puissance 2 10', ({ args }) => {
  const a = N(args, 0), b = N(args, 1), r = a ** b;
  return Number.isFinite(r) ? `${fmt(a)}^${fmt(b)} = ${fmt(r)}` : 'Format : !puissance <nombre> <exposant>';
});
cmd('factorielle', 'outils', 'Factorielle (0 à 50). Ex : !factorielle 10', ({ args }) => {
  const n = parseInt(args[0]);
  if (!(n >= 0 && n <= 50)) return 'Donne un entier entre 0 et 50.';
  let r = 1n; for (let i = 2n; i <= BigInt(n); i++) r *= i;
  return `${n}! = ${r}`;
});
cmd('premier', 'outils', 'Teste si un nombre est premier. Ex : !premier 97', ({ args }) => {
  const n = parseInt(args[0]);
  if (!(n >= 0 && n <= 1e12)) return 'Donne un entier entre 0 et 1 000 000 000 000.';
  if (n < 2) return `${n} n'est pas premier.`;
  for (let i = 2; i * i <= n; i++) if (n % i === 0) return `❌ ${n} n'est pas premier (divisible par ${i}).`;
  return `✅ ${n} est premier.`;
});
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
cmd('pgcd', 'outils', 'Plus grand commun diviseur. Ex : !pgcd 48 18', ({ args }) => {
  const a = parseInt(args[0]), b = parseInt(args[1]);
  return a > 0 && b > 0 ? `PGCD(${a}, ${b}) = ${gcd(a, b)}` : 'Format : !pgcd <a> <b> (entiers positifs)';
});
cmd('ppcm', 'outils', 'Plus petit commun multiple. Ex : !ppcm 4 6', ({ args }) => {
  const a = parseInt(args[0]), b = parseInt(args[1]);
  return a > 0 && b > 0 ? `PPCM(${a}, ${b}) = ${(a / gcd(a, b)) * b}` : 'Format : !ppcm <a> <b> (entiers positifs)';
});
cmd('fibonacci', 'outils', 'N-ième nombre de Fibonacci (0 à 90). Ex : !fibonacci 10', ({ args }) => {
  const n = parseInt(args[0]);
  if (!(n >= 0 && n <= 90)) return 'Donne un entier entre 0 et 90.';
  let a = 0n, b = 1n; for (let i = 0; i < n; i++) [a, b] = [b, a + b];
  return `F(${n}) = ${a}`;
});
cmd('tobin', 'outils', 'Décimal vers binaire. Ex : !tobin 42', ({ args }) => {
  const n = parseInt(args[0]);
  return n >= 0 ? `${n} = ${n.toString(2)} (binaire)` : 'Donne un entier positif.';
});
cmd('todec', 'outils', 'Binaire vers décimal. Ex : !todec 101010', ({ args }) =>
  /^[01]+$/.test(args[0] || '') ? `${args[0]} = ${parseInt(args[0], 2)} (décimal)` : 'Donne un nombre binaire (0 et 1).');
cmd('tohex', 'outils', 'Décimal vers hexadécimal. Ex : !tohex 255', ({ args }) => {
  const n = parseInt(args[0]);
  return n >= 0 ? `${n} = ${n.toString(16).toUpperCase()} (hexa)` : 'Donne un entier positif.';
});
conv('celsius', 'Convertit °C en °F.', (v, r) => `${fmt(v)} °C = ${fmt(r)} °F`, v => (v * 9) / 5 + 32);
conv('fahrenheit', 'Convertit °F en °C.', (v, r) => `${fmt(v)} °F = ${fmt(r)} °C`, v => ((v - 32) * 5) / 9);
conv('km2mi', 'Kilomètres en miles.', (v, r) => `${fmt(v)} km = ${fmt(r)} mi`, v => v * 0.621371);
conv('mi2km', 'Miles en kilomètres.', (v, r) => `${fmt(v)} mi = ${fmt(r)} km`, v => v * 1.609344);
conv('kg2lb', 'Kilos en livres.', (v, r) => `${fmt(v)} kg = ${fmt(r)} lb`, v => v * 2.204623);
conv('lb2kg', 'Livres en kilos.', (v, r) => `${fmt(v)} lb = ${fmt(r)} kg`, v => v * 0.453592);
cmd('imc', 'outils', 'Calcule l\'IMC. Ex : !imc 70 1.75 (kg, m ou cm)', ({ args }) => {
  const p = N(args, 0); let t = N(args, 1);
  if (!(p > 0 && t > 0)) return 'Format : !imc <poids en kg> <taille en m ou cm>';
  if (t > 3) t /= 100;
  const v = p / (t * t);
  const cat = v < 18.5 ? 'insuffisance pondérale' : v < 25 ? 'corpulence normale' : v < 30 ? 'surpoids' : 'obésité';
  return `IMC : ${v.toFixed(1)} (${cat}). Indication générale, pas un avis médical.`;
});
cmd('moyenne', 'outils', 'Moyenne de nombres. Ex : !moyenne 12 15 9', ({ args }) => {
  const n = args.map(a => parseFloat(a.replace(',', '.'))).filter(x => !Number.isNaN(x));
  return n.length ? `Moyenne : ${fmt(n.reduce((a, b) => a + b, 0) / n.length)} (sur ${n.length} valeur(s))` : 'Donne des nombres séparés par des espaces.';
});
cmd('romain', 'outils', 'Nombre (1-3999) en chiffres romains. Ex : !romain 2026', ({ args }) => {
  let n = parseInt(args[0]);
  if (!(n >= 1 && n <= 3999)) return 'Donne un entier entre 1 et 3999.';
  const t = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = ''; for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
  return s;
});
function parseDate(s) {
  const p = String(s || '').split(/[\/\-.]/).map(Number);
  if (p.length < 2 || p.some(Number.isNaN)) return null;
  const [d, mo, y] = p;
  const dt = new Date(Date.UTC(y || 2000, mo - 1, d));
  return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? { d, mo, y } : null;
}
cmd('age', 'outils', 'Calcule un âge. Ex : !age 25/03/2000', ({ args }) => {
  const b = parseDate(args[0]);
  if (!b || !b.y) return 'Format : !age JJ/MM/AAAA';
  const n = new Date();
  let y = n.getUTCFullYear() - b.y, mo = n.getUTCMonth() + 1 - b.mo, d = n.getUTCDate() - b.d;
  if (d < 0) { mo--; d += new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 0)).getUTCDate(); }
  if (mo < 0) { y--; mo += 12; }
  return y < 0 ? 'Cette date est dans le futur.' : `🎂 ${y} an(s), ${mo} mois et ${d} jour(s).`;
});
cmd('jours', 'outils', 'Jours restants avant une date. Ex : !jours 25/12', ({ args }) => {
  const t = parseDate(args[0]);
  if (!t) return 'Format : !jours JJ/MM ou JJ/MM/AAAA';
  const n = new Date(), t0 = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
  let target = Date.UTC(t.y || n.getUTCFullYear(), t.mo - 1, t.d);
  if (!t.y && target < t0) target = Date.UTC(n.getUTCFullYear() + 1, t.mo - 1, t.d);
  const diff = Math.round((target - t0) / 86400000);
  return diff === 0 ? "C'est aujourd'hui !" : diff > 0 ? `📆 Dans ${diff} jour(s).` : `📆 C'était il y a ${-diff} jour(s).`;
});
cmd('pourboire', 'outils', 'Calcule un pourboire. Ex : !pourboire 50 10', ({ args }) => {
  const a = N(args, 0), p = Number.isNaN(N(args, 1)) ? 10 : N(args, 1);
  if (!(a > 0)) return 'Format : !pourboire <montant> [pourcentage]';
  const tip = (a * p) / 100;
  return `Pourboire (${fmt(p)} %) : ${tip.toFixed(2)}\nTotal : ${(a + tip).toFixed(2)}`;
});
cmd('aleatoire', 'outils', 'Nombre aléatoire. Ex : !aleatoire 1 100', ({ args }) => {
  let a = Number.isNaN(N(args, 0)) ? 1 : Math.floor(N(args, 0));
  let b = Number.isNaN(N(args, 1)) ? 100 : Math.floor(N(args, 1));
  if (a > b) [a, b] = [b, a];
  return `🎲 ${a + rnd(b - a + 1)} (entre ${a} et ${b})`;
});
cmd('tva', 'outils', 'Calcule le TTC. Ex : !tva 100 20', ({ args }) => {
  const a = N(args, 0), r = Number.isNaN(N(args, 1)) ? 20 : N(args, 1);
  if (!(a >= 0)) return 'Format : !tva <montant HT> [taux]';
  return `HT : ${a.toFixed(2)}\nTVA (${fmt(r)} %) : ${((a * r) / 100).toFixed(2)}\nTTC : ${(a * (1 + r / 100)).toFixed(2)}`;
});
cmd('remise', 'outils', 'Calcule un prix remisé. Ex : !remise 80 25', ({ args }) => {
  const a = N(args, 0), p = N(args, 1);
  if (!(a >= 0) || Number.isNaN(p)) return 'Format : !remise <prix> <pourcentage>';
  return `Remise : ${((a * p) / 100).toFixed(2)}\nPrix final : ${(a * (1 - p / 100)).toFixed(2)}`;
});

// ----- Infos -----
cmd('date', 'outils', 'Date complète du jour (UTC).', () => '📅 ' + new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }));
cmd('timestamp', 'outils', 'Timestamp Unix actuel.', () => String(Math.floor(Date.now() / 1000)));
cmd('fuseau', 'outils', 'Heure dans un fuseau. Ex : !fuseau Africa/Conakry', ({ args }) => {
  const z = args[0] || 'UTC';
  try { return `🕒 ${z} : ` + new Date().toLocaleString('fr-FR', { timeZone: z }); }
  catch { return 'Fuseau inconnu. Exemples : Africa/Conakry, Europe/Paris, America/New_York'; }
});
const isoWeek = d => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
};
cmd('semaine', 'outils', 'Numéro de la semaine en cours.', () => `Semaine n°${isoWeek(new Date())} de l'année.`);
cmd('annee', 'outils', "Avancement de l'année en cours.", () => {
  const n = new Date(), y = n.getUTCFullYear();
  const start = Date.UTC(y, 0, 1), end = Date.UTC(y + 1, 0, 1);
  const day = Math.floor((n - start) / 86400000) + 1, total = Math.round((end - start) / 86400000);
  return `📆 Jour ${day}/${total} de ${y} (${((day / total) * 100).toFixed(1)} %). Il reste ${total - day} jour(s).`;
});
const dur = s => { s = Math.floor(s); const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), mi = Math.floor((s % 3600) / 60); return `${d}j ${h}h ${mi}m ${s % 60}s`; };
cmd('uptime', 'outils', 'Depuis combien de temps le bot tourne.', () => `⏳ ${dur((Date.now() - startedAt) / 1000)}`);
cmd('ram', 'outils', 'Mémoire utilisée par le bot.', () => {
  const mu = process.memoryUsage();
  return `🧠 Bot : ${(mu.rss / 1048576).toFixed(0)} Mo\nSystème : ${((os.totalmem() - os.freemem()) / 1073741824).toFixed(2)} / ${(os.totalmem() / 1073741824).toFixed(2)} Go`;
});
cmd('plateforme', 'outils', 'Infos sur la machine qui héberge le bot.', () => `🖥️ ${os.type()} ${os.release()} (${process.arch})\nNode.js ${process.version}\nCPU : ${os.cpus().length} cœur(s)`);
cmd('nbcommandes', 'outils', 'Nombre de commandes disponibles.', () => `📦 ${Object.values(commands).filter(c => !c.hidden).length} commandes disponibles.`);
cmd('botinfo', 'outils', 'Infos sur le bot.', () => `🤖 *${BOT_NAME}*\nCommandes : ${Object.values(commands).filter(c => !c.hidden).length}\nUptime : ${dur((Date.now() - startedAt) / 1000)}\nNode.js ${process.version}`);
cmd('chercher', 'outils', 'Cherche une commande. Ex : !chercher groupe', ({ args }) => {
  const q = norm(T(args));
  if (!q) return 'Donne un mot-clé. Ex : !chercher météo';
  const found = Object.entries(commands).filter(([n, c]) => !c.hidden && (n.includes(q) || norm(c.help).includes(q))).map(([n]) => PREFIX + n);
  return found.length ? found.slice(0, 30).join('  ') : 'Aucune commande trouvée.';
});
cmd('cmdcat', 'outils', 'Liste les commandes d\'une catégorie. Ex : !cmdcat fun', ({ args }) => {
  const c = norm(args[0] || '');
  if (!CATS[c]) return 'Catégories : ' + Object.keys(CATS).join(', ');
  return `*${CATS[c]}*\n` + Object.entries(commands).filter(([, x]) => x.cat === c && !x.hidden).map(([n]) => PREFIX + n).join('  ');
});
const signOf = (d, mo) => {
  const v = mo * 100 + d;
  return v >= 1222 || v < 120 ? 'Capricorne' : v < 219 ? 'Verseau' : v < 321 ? 'Poissons' : v < 420 ? 'Bélier' : v < 521 ? 'Taureau' : v < 621 ? 'Gémeaux' : v < 723 ? 'Cancer' : v < 823 ? 'Lion' : v < 923 ? 'Vierge' : v < 1023 ? 'Balance' : v < 1122 ? 'Scorpion' : 'Sagittaire';
};
cmd('signe', 'outils', 'Signe astrologique. Ex : !signe 15/08', ({ args }) => {
  const t = parseDate(args[0]);
  return t ? `♈ Ton signe : *${signOf(t.d, t.mo)}*` : 'Format : !signe JJ/MM';
});

// ----- Services en ligne gratuits -----
cmd('pokemon', 'outils', 'Infos sur un Pokémon. Ex : !pokemon pikachu', async ({ sock, jid, args, m }) => {
  const q = norm(args.join('-'));
  if (!q) return 'Donne un nom. Ex : !pokemon pikachu';
  try {
    const d = await getJson('https://pokeapi.co/api/v2/pokemon/' + encodeURIComponent(q));
    const img = d.sprites?.other?.['official-artwork']?.front_default || d.sprites?.front_default;
    const cap = `*${d.name}* (#${d.id})\nTypes : ${d.types.map(t => t.type.name).join(', ')}\nTaille : ${d.height / 10} m · Poids : ${d.weight / 10} kg`;
    if (!img) return cap;
    await sock.sendMessage(jid, { image: { url: img }, caption: cap }, { quoted: m });
    return null;
  } catch { return 'Pokémon introuvable.'; }
});
cmd('rickmorty', 'outils', 'Cherche un personnage de Rick et Morty. Ex : !rickmorty Rick', async ({ sock, jid, args, m }) => {
  const q = T(args);
  if (!q) return 'Donne un nom. Ex : !rickmorty Rick';
  try {
    const d = (await getJson('https://rickandmortyapi.com/api/character/?name=' + encodeURIComponent(q))).results?.[0];
    if (!d) return 'Personnage introuvable.';
    await sock.sendMessage(jid, { image: { url: d.image }, caption: `*${d.name}*\nStatut : ${d.status}\nEspèce : ${d.species}\nOrigine : ${d.origin?.name}` }, { quoted: m });
    return null;
  } catch { return 'Personnage introuvable.'; }
});
cmd('github', 'outils', 'Profil GitHub. Ex : !github torvalds', async ({ sock, jid, args, m }) => {
  const u = args[0];
  if (!u) return 'Donne un nom d\'utilisateur. Ex : !github torvalds';
  try {
    const d = await getJson('https://api.github.com/users/' + encodeURIComponent(u));
    await sock.sendMessage(jid, { image: { url: d.avatar_url }, caption: `*${d.name || d.login}* (@${d.login})\n${d.bio || ''}\nDépôts : ${d.public_repos} · Abonnés : ${d.followers}\n${d.html_url}` }, { quoted: m });
    return null;
  } catch { return 'Utilisateur introuvable.'; }
});
cmd('conseil', 'outils', 'Un conseil au hasard (en anglais).', async () => {
  try { const d = await getJson('https://api.adviceslip.com/advice'); return '💡 ' + d.slip.advice; }
  catch { return DOWN; }
});
cmd('cocktail', 'outils', 'Recette de cocktail. Ex : !cocktail mojito', async ({ sock, jid, args, m }) => {
  const q = T(args);
  if (!q) return 'Donne un nom. Ex : !cocktail mojito';
  try {
    const d = (await getJson('https://www.thecocktaildb.com/api/json/v1/1/search.php?s=' + encodeURIComponent(q))).drinks?.[0];
    if (!d) return 'Cocktail introuvable.';
    const ing = []; for (let i = 1; i <= 15; i++) if (d['strIngredient' + i]) ing.push(`${d['strMeasure' + i] || ''} ${d['strIngredient' + i]}`.trim());
    const cap = `🍹 *${d.strDrink}*\n${ing.join('\n')}\n\n${(d.strInstructionsFR || d.strInstructions || '').slice(0, 600)}`;
    await sock.sendMessage(jid, { image: { url: d.strDrinkThumb }, caption: cap }, { quoted: m });
    return null;
  } catch { return DOWN; }
});
cmd('recette', 'outils', 'Recette de cuisine. Ex : !recette chicken', async ({ sock, jid, args, m }) => {
  const q = T(args);
  if (!q) return 'Donne un plat (en anglais). Ex : !recette chicken';
  try {
    const d = (await getJson('https://www.themealdb.com/api/json/v1/1/search.php?s=' + encodeURIComponent(q))).meals?.[0];
    if (!d) return 'Recette introuvable.';
    const ing = []; for (let i = 1; i <= 20; i++) if (d['strIngredient' + i]) ing.push(`${d['strMeasure' + i] || ''} ${d['strIngredient' + i]}`.trim());
    await sock.sendMessage(jid, { image: { url: d.strMealThumb }, caption: `🍽️ *${d.strMeal}* (${d.strArea})\n${ing.join(', ')}\n\n${(d.strInstructions || '').slice(0, 700)}...` }, { quoted: m });
    return null;
  } catch { return DOWN; }
});
cmd('pays', 'outils', 'Infos sur un pays. Ex : !pays Guinée', async ({ args }) => {
  const q = T(args);
  if (!q) return 'Donne un pays. Ex : !pays Guinée';
  try {
    const d = (await getJson('https://restcountries.com/v3.1/translation/' + encodeURIComponent(q) + '?fields=name,capital,population,region,flag,languages,currencies'))[0];
    return `${d.flag} *${d.name.common}*\nCapitale : ${(d.capital || []).join(', ') || '?'}\nRégion : ${d.region}\nPopulation : ${d.population.toLocaleString('fr-FR')}\nLangues : ${Object.values(d.languages || {}).join(', ')}\nMonnaie : ${Object.values(d.currencies || {}).map(c => c.name).join(', ')}`;
  } catch { return 'Pays introuvable.'; }
});
cmd('ip', 'outils', 'Localise une adresse IP. Ex : !ip 8.8.8.8', async ({ args }) => {
  const ip = args[0];
  if (!ip) return 'Donne une adresse IP. Ex : !ip 8.8.8.8';
  try {
    const d = await getJson('https://ipwho.is/' + encodeURIComponent(ip));
    return d.success ? `🌍 ${d.ip}\n${d.city || '?'}, ${d.country}\nFournisseur : ${d.connection?.isp || '?'}` : 'Adresse IP invalide.';
  } catch { return DOWN; }
});
cmd('definition', 'outils', 'Définition d\'un mot. Ex : !definition soleil', async ({ args }) => {
  const w = args[0];
  if (!w) return 'Donne un mot. Ex : !definition soleil';
  try {
    const d = (await getJson('https://api.dictionaryapi.dev/api/v2/entries/fr/' + encodeURIComponent(w)))[0];
    const mean = d.meanings?.[0];
    return `📖 *${d.word}* (${mean?.partOfSpeech || '?'})\n${mean?.definitions?.[0]?.definition || 'Pas de définition.'}`;
  } catch { return 'Aucune définition trouvée.'; }
});
cmd('anime', 'outils', 'Infos sur un anime. Ex : !anime Naruto', async ({ sock, jid, args, m }) => {
  const q = T(args);
  if (!q) return 'Donne un titre. Ex : !anime Naruto';
  try {
    const d = (await getJson('https://api.jikan.moe/v4/anime?limit=1&q=' + encodeURIComponent(q))).data?.[0];
    if (!d) return 'Anime introuvable.';
    const cap = `🎌 *${d.title}*\nNote : ${d.score ?? '?'}/10 · Épisodes : ${d.episodes ?? '?'}\n${(d.synopsis || '').slice(0, 500)}`;
    await sock.sendMessage(jid, { image: { url: d.images.jpg.image_url }, caption: cap }, { quoted: m });
    return null;
  } catch { return DOWN; }
});
cmd('iss', 'outils', 'Position actuelle de la Station spatiale.', async () => {
  try {
    const d = await getJson('http://api.open-notify.org/iss-now.json');
    return `🛰️ ISS : latitude ${d.iss_position.latitude}, longitude ${d.iss_position.longitude}`;
  } catch { return DOWN; }
});
cmd('numfact', 'outils', 'Fait sur un nombre (en anglais). Ex : !numfact 42', async ({ args }) => {
  const n = parseInt(args[0]);
  if (Number.isNaN(n)) return 'Donne un nombre. Ex : !numfact 42';
  try { return '🔢 ' + await (await fetch('http://numbersapi.com/' + n)).text(); }
  catch { return DOWN; }
});

// ----- Fun -----
listCmd('excuse', 'fun', 'Une excuse bidon.', ["Mon chat a dormi sur mon clavier.", "Mon réveil a décidé de prendre sa journée.", "Le réseau était trop occupé à penser.", "J'étais en réunion avec mon canapé.", "Mon téléphone était en mode avion... à la maison.", "J'ai cru que c'était encore dimanche."], '🙈 ');
listCmd('proverbe', 'fun', 'Un proverbe.', ['Qui va doucement va sûrement.', "Petit à petit, l'oiseau fait son nid.", "L'union fait la force.", 'La nuit porte conseil.', 'Mieux vaut tard que jamais.', 'Pierre qui roule n\'amasse pas mousse.', 'À cœur vaillant rien d\'impossible.', 'Rira bien qui rira le dernier.'], '📜 ');
listCmd('compliment', 'fun', 'Un compliment.', ['Tu as un super sens de l\'humour.', 'Ta bonne humeur est contagieuse.', 'Tu fais vraiment la différence.', 'Tu es plus fort(e) que tu ne le crois.', 'Avec toi, tout devient plus facile.', 'Ton sourire illumine la pièce.'], '💐 ');
qaGameInit();
listCmd('jamais', 'fun', 'Je n\'ai jamais... (jeu de groupe).', ['Je n\'ai jamais raté un bus à cause d\'un message.', 'Je n\'ai jamais chanté sous la douche.', 'Je n\'ai jamais oublié un anniversaire.', 'Je n\'ai jamais dormi en cours ou au travail.', 'Je n\'ai jamais envoyé un message à la mauvaise personne.', 'Je n\'ai jamais fait semblant de rire à une blague.'], '🙋 ');
listCmd('action', 'fun', 'Un défi « action » à relever.', ['Imite un animal pendant 10 secondes.', 'Envoie un vocal en chantant.', 'Écris ton prochain message sans voyelle.', 'Fais 10 pompes et prouve-le.', 'Change ton statut pour « Je suis un génie » pendant une heure.', 'Raconte une blague au groupe.'], '🎯 ');
listCmd('verite', 'fun', 'Une question « vérité ».', ['Quelle est ta plus grande peur ?', 'Quel est ton plus beau souvenir ?', 'Quelle est la dernière chose que tu as cherchée sur internet ?', 'Quel talent cache-t-on en toi ?', 'Quel est ton plus gros fou rire ?', 'Quel métier rêvais-tu de faire enfant ?'], '🗝️ ');
listCmd('dilemme', 'fun', 'Tu préfères... ?', ['Tu préfères voler ou être invisible ?', 'Tu préfères toujours avoir chaud ou toujours avoir froid ?', 'Tu préfères voyager dans le passé ou dans le futur ?', 'Tu préfères ne plus jamais utiliser ton téléphone ou ne plus jamais regarder de vidéos ?', 'Tu préfères parler toutes les langues ou jouer de tous les instruments ?', 'Tu préfères vivre à la mer ou à la montagne ?'], '🤔 ');
const pairCmd = (name, help, emoji) => cmd(name, 'fun', help, ({ m, sender }) => {
  const t = mentionsOf(m);
  const a = t.length >= 2 ? t[0] : sender, b = t.length >= 2 ? t[1] : t[0];
  if (!b) return `Mentionne une personne. Ex : !${name} @membre`;
  return { text: `${emoji} ${tagOf(a)} + ${tagOf(b)} : ${hashPct([a, b].sort().join('|'))} %`, mentions: [a, b] };
});
pairCmd('couple', 'Compatibilité amoureuse (pour rire). Ex : !couple @membre', '💞');
pairCmd('amitie', 'Compatibilité d\'amitié (pour rire). Ex : !amitie @membre', '🤝');
const meter = (name, help, make) => cmd(name, 'fun', help, ({ m, sender }) => {
  const id = targetsOf(m)[0] || sender;
  return { text: make(tagOf(id), hashPct(name + id + today())), mentions: [id] };
});
meter('beaute', 'Score de beauté du jour (pour rire).', (t, p) => `✨ Beauté de ${t} aujourd'hui : ${p} %`);
meter('qi', 'QI du jour (pour rire).', (t, p) => `🧠 QI de ${t} : ${70 + Math.round(p * 0.9)} (pour rire)`);
meter('chance', 'Chance du jour (pour rire).', (t, p) => `🍀 Chance de ${t} aujourd'hui : ${p} %`);
cmd('rate', 'fun', 'Donne une note sur 10. Ex : !rate la pizza', ({ args }) => {
  const t = T(args);
  return t ? `⭐ ${t} : ${hashPct('rate' + norm(t)) % 11}/10` : 'Écris ce que je dois noter. Ex : !rate la pizza';
});
const act = (name, help, make) => cmd(name, 'fun', help, ({ m, sender }) => {
  const t = targetsOf(m)[0];
  if (!t) return `Mentionne quelqu'un. Ex : !${name} @membre`;
  return { text: make(tagOf(sender), tagOf(t)), mentions: [sender, t] };
});
act('calin', 'Fait un câlin. Ex : !calin @membre', (a, b) => `🤗 ${a} fait un gros câlin à ${b} !`);
act('gifle', 'Gifle pour rire. Ex : !gifle @membre', (a, b) => `👋 ${a} met une gifle (pour rire) à ${b} !`);
act('bisou', 'Fait un bisou. Ex : !bisou @membre', (a, b) => `😘 ${a} fait un bisou à ${b} !`);
listCmd('danse', 'fun', 'Une petite danse.', ['💃 ♪ ┏(・o･)┛ ♪ ┗(･o･)┓ ♪', '🕺 ᕕ( ᐛ )ᕗ', '♪ ┌(・。・)┘♪ └(・。・)┐♪', '(⌐■_■) ♪ ┏(°.°)┛ ┗(°.°)┓'], '');
cmd('coeur', 'fun', 'Entoure ton texte de cœurs. Ex : !coeur Je t\'aime', ({ args }) => {
  const t = T(args);
  return t ? `❤️🧡💛💚💙💜\n${t}\n💜💙💚💛🧡❤️` : '❤️🧡💛💚💙💜';
});
listCmd('emoji', 'fun', 'Un emoji au hasard.', ['😀', '😎', '🤩', '🥳', '🤖', '👻', '🦄', '🐉', '🌈', '🔥', '🍕', '⚡', '🚀', '🎸', '🍀']);
cmd('surnom', 'fun', 'Génère un surnom rigolo.', () => `🏷️ ${pick(['Le Grand', 'La Terrible', 'Le Mystérieux', 'La Rapide', 'Le Sage', 'La Joyeuse'])} ${pick(['Panda', 'Lion', 'Hibou', 'Renard', 'Dragon', 'Dauphin', 'Éléphant'])} ${pick(['Masqué', 'Volant', 'Cosmique', 'du Désert', 'des Nuages', 'Fantôme'])}`);
cmd('motdujour', 'fun', 'Un mot rare et sa définition.', () => {
  const [w, d] = pick([['Sérendipité', 'Faculté de faire une découverte heureuse par hasard.'], ['Ineffable', 'Qui ne peut pas être exprimé par des mots.'], ['Pérenne', 'Qui dure longtemps.'], ['Quintessence', 'Ce qu\'il y a de plus pur et de plus essentiel.'], ['Éphémère', 'Qui ne dure qu\'un court moment.'], ['Resplendir', 'Briller d\'un vif éclat.'], ['Magnanime', 'Qui a de la grandeur d\'âme, généreux.']]);
  return `📚 *${w}*\n${d}`;
});
listCmd('fait', 'fun', 'Un fait surprenant.', ['Les pieuvres ont trois cœurs.', 'Le miel est quasiment impérissable.', 'Une journée sur Vénus dure plus longtemps qu\'une année vénusienne.', 'Les bananes sont des baies, pas les fraises.', 'La tour Eiffel peut gagner une quinzaine de centimètres en été à cause de la dilatation.', 'Les requins existaient avant les arbres.', 'Le cœur d\'une crevette est situé dans sa tête.'], '🤯 ');
listCmd('histoire', 'fun', 'Une micro-histoire.', ['Un vieux phare s\'éteignit un soir. Le lendemain, tous les bateaux étaient rentrés : ils avaient appris à se guider tout seuls.', 'Une graine tomba dans le désert. Personne n\'y croyait. Dix ans plus tard, un arbre offrait de l\'ombre aux caravanes.', 'Un robot apprit à cuisiner. Son premier plat fut raté, le deuxième aussi. Le centième fit pleurer de joie tout le quartier.', 'Une petite étoile avait peur du noir. Puis elle comprit qu\'elle était justement là pour l\'éclairer.'], '📖 ');
cmd('horoscope', 'fun', 'Horoscope du jour pour rire. Ex : !horoscope lion', ({ args }) => {
  const signs = ['belier', 'taureau', 'gemeaux', 'cancer', 'lion', 'vierge', 'balance', 'scorpion', 'sagittaire', 'capricorne', 'verseau', 'poissons'];
  const s = norm(args[0] || '');
  if (!signs.includes(s)) return 'Donne ton signe. Ex : !horoscope lion\n' + signs.join(', ');
  const seed = hashPct(s + today());
  const pickS = (a, k) => a[(seed + k) % a.length];
  return `🔮 *${s.toUpperCase()}* (pour le fun)\n❤️ Amour : ${pickS(['Une belle surprise t\'attend.', 'Prends le temps d\'écouter.', 'Un message inattendu arrive.'], 1)}\n💼 Travail : ${pickS(['Garde le cap, ça paie.', 'Une idée neuve se présente.', 'Reste patient(e).'], 2)}\n🍀 Chance : ${seed} %`;
});
listCmd('defi', 'fun', 'Un petit défi du jour.', ['Bois un grand verre d\'eau maintenant.', 'Envoie un message gentil à quelqu\'un.', 'Range un objet qui traîne depuis des jours.', 'Apprends un mot nouveau aujourd\'hui.', 'Marche 10 minutes dehors.', 'Écris trois choses pour lesquelles tu es reconnaissant(e).'], '🏁 ');
const FLIP = { a: 'ɐ', b: 'q', c: 'ɔ', d: 'p', e: 'ǝ', f: 'ɟ', g: 'ƃ', h: 'ɥ', i: 'ᴉ', j: 'ɾ', k: 'ʞ', l: 'l', m: 'ɯ', n: 'u', o: 'o', p: 'd', q: 'b', r: 'ɹ', s: 's', t: 'ʇ', u: 'n', v: 'ʌ', w: 'ʍ', x: 'x', y: 'ʎ', z: 'z', '?': '¿', '!': '¡', '.': '˙' };
textCmd('upside', 'Écrit à l\'envers. Ex : !upside bonjour', t => [...t.toLowerCase()].map(c => FLIP[c] || c).reverse().join(''));
textCmd('petitcaps', 'Petites capitales. Ex : !petitcaps bonjour', t => t.replace(/[a-z]/gi, c => 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀsᴛᴜᴠᴡxʏᴢ'[c.toLowerCase().charCodeAt(0) - 97]));
textCmd('bulle', 'Lettres dans des bulles. Ex : !bulle bonjour', t => t.replace(/[a-z]/gi, c => (c >= 'a' ? String.fromCodePoint(0x24D0 + c.charCodeAt(0) - 97) : String.fromCodePoint(0x24B6 + c.charCodeAt(0) - 65))));

// ----- Jeux -----
function qaGameInit() {
  const qa = (name, cat, help, items) => cmd(name, cat, help, ({ jid, args }) => {
    const strip = s => norm(s).replace(/^(le|la|les|l') ?/, '');
    const key = name + ':' + jid;
    const g = games.get(key);
    const a = strip(args.join(' '));
    const ask = it => `❓ ${it.q}\nRéponds avec !${name} <réponse> (ou !${name} abandon).`;
    if (!g) { const it = pick(items); games.set(key, it); return ask(it); }
    if (!a) return ask(g);
    if (a === 'abandon') { games.delete(key); return `🏳️ Réponse : ${g.reveal}`; }
    if ([].concat(g.a).map(strip).includes(a)) { games.delete(key); return '✅ Bonne réponse !'; }
    return '❌ Raté, réessaie.';
  });
  qa('devinette', 'fun', 'Une devinette à résoudre.', [
    { q: "Je suis plein le matin et vide le soir, mais je ne te nourris pas. Qui suis-je ?", a: ['agenda', 'un agenda'], reveal: 'un agenda' },
    { q: 'Plus on en prend, plus on en laisse derrière soi. Qu\'est-ce que c\'est ?', a: ['pas', 'les pas', 'des pas'], reveal: 'les pas' },
    { q: 'Je parle sans bouche et j\'entends sans oreilles. Qui suis-je ?', a: ['echo', 'un echo', 'l\'echo'], reveal: "l'écho" },
    { q: 'Qu\'est-ce qui a des clés mais ne peut ouvrir aucune porte ?', a: ['piano', 'un piano', 'clavier', 'un clavier'], reveal: 'un piano' },
    { q: 'Qu\'est-ce qui monte et ne redescend jamais ?', a: ['age', 'l\'age'], reveal: "l'âge" },
    { q: 'Qu\'est-ce qui est à toi mais que les autres utilisent plus que toi ?', a: ['prenom', 'ton prenom', 'nom', 'ton nom'], reveal: 'ton prénom' }
  ]);
  qa('vraioufaux', 'fun', 'Vrai ou faux ? Réponds avec !vraioufaux vrai / faux.', [
    { q: 'Le Soleil est une étoile.', a: 'vrai', reveal: 'vrai' },
    { q: 'Les chauves-souris sont aveugles.', a: 'faux', reveal: 'faux' },
    { q: 'L\'eau bout à 100 °C au niveau de la mer.', a: 'vrai', reveal: 'vrai' },
    { q: 'Les humains n\'utilisent que 10 % de leur cerveau.', a: 'faux', reveal: 'faux' },
    { q: 'Les dauphins sont des mammifères.', a: 'vrai', reveal: 'vrai' },
    { q: 'Le Sahara est le plus grand désert du monde.', a: 'faux', reveal: 'faux (c\'est l\'Antarctique)' }
  ]);
  const CAPS = [['France', 'Paris'], ['Guinée', 'Conakry'], ['Sénégal', 'Dakar'], ['Mali', 'Bamako'], ["Côte d'Ivoire", 'Yamoussoukro'], ['Maroc', 'Rabat'], ['Égypte', 'Le Caire'], ['Italie', 'Rome'], ['Espagne', 'Madrid'], ['Allemagne', 'Berlin'], ['Japon', 'Tokyo'], ['Brésil', 'Brasilia'], ['Canada', 'Ottawa'], ['Nigeria', 'Abuja'], ['Ghana', 'Accra']];
  qa('capitale', 'jeux', 'Devine la capitale d\'un pays.', CAPS.map(([p, c]) => ({ q: `Quelle est la capitale de ce pays : ${p} ?`, a: c, reveal: c })));
  const FLAGS = [['🇫🇷', 'France'], ['🇬🇳', 'Guinée'], ['🇸🇳', 'Sénégal'], ['🇲🇱', 'Mali'], ['🇲🇦', 'Maroc'], ['🇮🇹', 'Italie'], ['🇪🇸', 'Espagne'], ['🇩🇪', 'Allemagne'], ['🇯🇵', 'Japon'], ['🇧🇷', 'Brésil'], ['🇨🇦', 'Canada'], ['🇳🇬', 'Nigeria'], ['🇬🇭', 'Ghana'], ['🇨🇮', "Côte d'Ivoire"]];
  qa('drapeau', 'jeux', 'Devine le pays à partir du drapeau.', FLAGS.map(([f, p]) => ({ q: `À quel pays appartient ce drapeau ${f} ?`, a: p, reveal: p })));
  qa('trivia', 'jeux', 'Question à choix multiples. Réponds avec la lettre.', [
    { q: 'Quelle planète est surnommée la planète rouge ?\nA) Vénus  B) Mars  C) Jupiter', a: ['b', 'mars'], reveal: 'B) Mars' },
    { q: 'Combien y a-t-il de continents (modèle courant) ?\nA) 5  B) 6  C) 7', a: ['c', '7'], reveal: 'C) 7' },
    { q: 'Quel gaz les plantes absorbent-elles ?\nA) Le dioxyde de carbone  B) L\'azote  C) L\'hélium', a: ['a', 'dioxyde de carbone'], reveal: 'A) Le dioxyde de carbone' },
    { q: 'Quel est le plus grand mammifère ?\nA) L\'éléphant  B) La baleine bleue  C) La girafe', a: ['b', 'baleine bleue', 'la baleine bleue'], reveal: 'B) La baleine bleue' },
    { q: 'Combien de minutes dans une heure et demie ?\nA) 80  B) 90  C) 100', a: ['b', '90'], reveal: 'B) 90' },
    { q: 'Quel est l\'océan qui borde la côte de la Guinée ?\nA) Pacifique  B) Indien  C) Atlantique', a: ['c', 'atlantique'], reveal: 'C) Atlantique' }
  ]);
}
const HANG_WORDS = ['guinee', 'conakry', 'ordinateur', 'telephone', 'montagne', 'riviere', 'bibliotheque', 'elephant', 'soleil', 'football', 'musique', 'voyage', 'jardin', 'chocolat'];
const hangRender = g => `🪢 ${[...g.word].map(c => (g.found.has(c) ? c : '_')).join(' ').toUpperCase()}\nErreurs : ${g.errors}/6${g.tried.size ? ' · Lettres : ' + [...g.tried].join(' ').toUpperCase() : ''}`;
cmd('pendu', 'jeux', 'Jeu du pendu. Ex : !pendu puis !pendu a', ({ jid, args }) => {
  const key = 'pendu:' + jid, l = norm(args[0] || '');
  let g = games.get(key);
  if (!g) { g = { word: pick(HANG_WORDS), found: new Set(), tried: new Set(), errors: 0 }; games.set(key, g); return hangRender(g) + '\nEnvoie !pendu <lettre> ou le mot entier.'; }
  if (!l) return hangRender(g) + '\nEnvoie !pendu <lettre> ou le mot entier.';
  if (l.length > 1) {
    if (l === g.word) { games.delete(key); return `🎉 Bravo ! Le mot était *${g.word}*.`; }
    g.errors++;
  } else {
    if (!/^[a-z]$/.test(l)) return 'Envoie une lettre de a à z.';
    if (g.tried.has(l)) return 'Lettre déjà essayée.\n' + hangRender(g);
    g.tried.add(l);
    if (g.word.includes(l)) g.found.add(l); else g.errors++;
  }
  if ([...g.word].every(c => g.found.has(c))) { games.delete(key); return `🎉 Bravo ! Le mot était *${g.word}*.`; }
  if (g.errors >= 6) { games.delete(key); return `💀 Perdu ! Le mot était *${g.word}*.`; }
  return hangRender(g);
});
cmd('lancer', 'jeux', 'Lance plusieurs dés. Ex : !lancer 3d6', ({ args }) => {
  const mt = /^(\d{1,2})d(\d{1,3})$/i.exec(args[0] || '2d6');
  if (!mt || +mt[1] < 1 || +mt[2] < 2) return 'Format : !lancer <nombre>d<faces>. Ex : !lancer 3d6';
  const r = Array.from({ length: +mt[1] }, () => 1 + rnd(+mt[2]));
  return `🎲 ${r.join(' + ')} = *${r.reduce((a, b) => a + b, 0)}*`;
});
cmd('loterie', 'jeux', 'Tire 6 numéros de loterie (1-49).', () => {
  const s = new Set(); while (s.size < 7) s.add(1 + rnd(49));
  const a = [...s]; const bonus = a.pop();
  return `🎟️ ${a.sort((x, y) => x - y).join(' - ')}\nNuméro chance : ${bonus}`;
});
cmd('slot', 'jeux', 'Machine à sous.', () => {
  const S = ['🍒', '🍋', '🍇', '🔔', '⭐', '7️⃣'];
  const r = [pick(S), pick(S), pick(S)];
  const res = r[0] === r[1] && r[1] === r[2] ? '🎉 JACKPOT !' : new Set(r).size === 2 ? '👍 Deux identiques !' : '😅 Perdu, retente ta chance.';
  return `🎰 ${r.join(' | ')}\n${res}`;
});
cmd('roulette', 'jeux', 'Roulette. Ex : !roulette rouge / noir / pair / impair / 17', ({ args }) => {
  const RED = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
  const n = rnd(37), color = n === 0 ? 'vert' : RED.includes(n) ? 'rouge' : 'noir';
  const bet = norm(args[0] || '');
  let res = '';
  if (bet) {
    const won = bet === color || (n > 0 && ((bet === 'pair' && n % 2 === 0) || (bet === 'impair' && n % 2 === 1))) || bet === String(n);
    res = won ? '\n🎉 Gagné !' : '\n❌ Perdu.';
  }
  return `🎡 ${n} (${color})${res}`;
});
const CARD_NAMES = { 1: 'As', 11: 'Valet', 12: 'Dame', 13: 'Roi' };
const cardName = n => CARD_NAMES[n] || String(n);
cmd('hautbas', 'jeux', 'Carte plus haute ou plus basse ? Ex : !hautbas puis !hautbas haut', ({ jid, args }) => {
  const key = 'hautbas:' + jid, a = norm(args[0] || '');
  let g = games.get(key);
  if (!g) { g = { card: 1 + rnd(13), streak: 0 }; games.set(key, g); return `🃏 Carte : *${cardName(g.card)}*\nLa suivante sera-t-elle plus haute ou plus basse ? !hautbas haut / bas`; }
  if (!['haut', 'bas'].includes(a)) return `🃏 Carte : *${cardName(g.card)}*\nRéponds avec !hautbas haut ou !hautbas bas`;
  const next = 1 + rnd(13);
  const ok = next === g.card ? null : (next > g.card) === (a === 'haut');
  if (ok === null) { return `🃏 ${cardName(next)} : égalité, on continue !`; }
  if (ok) { g.streak++; g.card = next; return `✅ ${cardName(next)} ! Série : ${g.streak}\nContinue avec !hautbas haut / bas`; }
  games.delete(key);
  return `❌ ${cardName(next)}. Fin de partie, série : ${g.streak}.`;
});
cmd('memoire', 'jeux', 'Mémorise une suite de chiffres. Ex : !memoire puis !memoire 12345', async ({ sock, jid, args, m }) => {
  const key = 'memoire:' + jid, g = games.get(key), a = (args[0] || '').trim();
  if (g && a) { games.delete(key); return a === g ? '🎉 Bravo, bonne mémoire !' : `❌ Raté, c'était ${g}.`; }
  const seq = Array.from({ length: 5 }, () => rnd(10)).join('');
  games.set(key, seq);
  const sent = await sock.sendMessage(jid, { text: `🧠 Mémorise : *${seq}*\n(le message disparaît dans 5 s)` }, { quoted: m });
  setTimeout(() => sock.sendMessage(jid, { delete: sent.key }).catch(() => {}), 5000);
  return 'Maintenant, envoie !memoire <la suite>.';
});

// ----- Groupe -----
cmd('antipromote', 'groupe', 'Annule les promotions admin faites par d\'autres. Ex : !antipromote on', antiMediaToggle(antipromoteSet, 'promotion'), { group: true, admin: true });
cmd('antidemote', 'groupe', 'Annule les rétrogradations faites par d\'autres. Ex : !antidemote on', antiMediaToggle(antidemoteSet, 'rétrogradation'), { group: true, admin: true });
cmd('approveall', 'groupe', "Accepte toutes les demandes d'adhésion en attente.", async ({ sock, jid }) => {
  try {
    const list = await sock.groupRequestParticipantsList(jid);
    if (!list.length) return 'Aucune demande en attente.';
    await sock.groupRequestParticipantsUpdate(jid, list.map(r => r.jid || r.phone_number), 'approve');
    return `${list.length} demande(s) acceptée(s) ✅`;
  } catch { return NEED_ADMIN; }
}, { group: true, admin: true });
const quotedKey = (m, jid) => {
  const c = m.message?.extendedTextMessage?.contextInfo;
  return c?.stanzaId ? { remoteJid: jid, id: c.stanzaId, participant: c.participant, fromMe: false } : null;
};
cmd('pin', 'groupe', 'Épingle le message auquel tu réponds. Ex : !pin 7j', async ({ sock, jid, m, args }) => {
  const key = quotedKey(m, jid);
  if (!key) return 'Réponds au message à épingler.';
  const t = { '24h': 86400, '7j': 604800, '30j': 2592000 }[(args[0] || '7j').toLowerCase()] || 604800;
  try { await sock.sendMessage(jid, { pin: key, type: 1, time: t }); return null; }
  catch { return "Impossible d'épingler (le bot doit être admin)."; }
}, { group: true, admin: true });
cmd('unpin', 'groupe', 'Désépingle le message auquel tu réponds.', async ({ sock, jid, m }) => {
  const key = quotedKey(m, jid);
  if (!key) return 'Réponds au message épinglé.';
  try { await sock.sendMessage(jid, { pin: key, type: 2 }); return null; }
  catch { return 'Impossible de désépingler.'; }
}, { group: true, admin: true });
const groupSetting = (name, help, setting, okMsg) => cmd(name, 'groupe', help, async ({ sock, jid }) => {
  try { await sock.groupSettingUpdate(jid, setting); return okMsg; }
  catch { return NEED_ADMIN; }
}, { group: true, admin: true });
groupSetting('fermer', 'Seuls les admins peuvent écrire.', 'announcement', '🔒 Groupe fermé : seuls les admins peuvent écrire.');
groupSetting('ouvrir', 'Tout le monde peut écrire.', 'not_announcement', '🔓 Groupe ouvert : tout le monde peut écrire.');
groupSetting('lock', 'Seuls les admins modifient les infos du groupe.', 'locked', '🔒 Infos du groupe verrouillées.');
groupSetting('unlock', 'Tout le monde peut modifier les infos du groupe.', 'unlocked', '🔓 Infos du groupe déverrouillées.');
cmd('setgname', 'groupe', 'Change le nom du groupe. Ex : !setgname Mon groupe', async ({ sock, jid, args }) => {
  const n = T(args);
  if (!n) return 'Écris le nouveau nom.';
  try { await sock.groupUpdateSubject(jid, n.slice(0, 100)); return 'Nom du groupe mis à jour ✅'; }
  catch { return NEED_ADMIN; }
}, { group: true, admin: true });
cmd('hidetag', 'groupe', 'Mentionne tout le monde sans afficher les noms. Ex : !hidetag Réunion à 18h', async ({ sock, jid, args }) => {
  const meta = await sock.groupMetadata(jid);
  return { text: T(args) || '📢', mentions: meta.participants.map(p => p.id) };
}, { group: true, admin: true });
cmd('membres', 'groupe', 'Nombre de membres du groupe.', async ({ sock, jid }) => {
  const meta = await sock.groupMetadata(jid);
  return `👥 ${meta.participants.length} membre(s), dont ${meta.participants.filter(p => p.admin).length} admin(s).`;
}, { group: true });
cmd('listmembres', 'groupe', 'Liste les membres (100 maximum).', async ({ sock, jid }) => {
  const meta = await sock.groupMetadata(jid);
  const ids = meta.participants.slice(0, 100).map(p => p.id);
  return { text: `👥 Membres (${ids.length}/${meta.participants.length}) :\n` + ids.map(tagOf).join('\n'), mentions: ids };
}, { group: true });
cmd('ephemere', 'groupe', 'Messages éphémères. Ex : !ephemere 24h / 7j / 90j / off', async ({ sock, jid, args }) => {
  const map = { off: 0, '24h': 86400, '7j': 604800, '90j': 7776000 };
  const k = (args[0] || '').toLowerCase();
  if (!(k in map)) return 'Utilise : !ephemere 24h, 7j, 90j ou off';
  try { await sock.groupToggleEphemeral(jid, map[k]); return k === 'off' ? 'Messages éphémères désactivés.' : `Messages éphémères activés (${k}) ✅`; }
  catch { return NEED_ADMIN; }
}, { group: true, admin: true });
cmd('warn', 'groupe', 'Avertit un membre (retiré au 3e). Ex : !warn @membre', async ({ sock, jid, m }) => {
  const t = targetsOf(m)[0];
  if (!t) return 'Mentionne le membre à avertir.';
  const k = jid + ':' + t, n = (warns.get(k) || 0) + 1;
  if (n >= 3) {
    warns.delete(k);
    try { await sock.groupParticipantsUpdate(jid, [t], 'remove'); } catch {}
    return { text: `${tagOf(t)} a reçu 3 avertissements et est retiré.`, mentions: [t] };
  }
  warns.set(k, n);
  return { text: `⚠️ ${tagOf(t)} : avertissement ${n}/3.`, mentions: [t] };
}, { group: true, admin: true });
cmd('unwarn', 'groupe', 'Retire un avertissement. Ex : !unwarn @membre', ({ jid, m }) => {
  const t = targetsOf(m)[0];
  if (!t) return 'Mentionne le membre concerné.';
  const k = jid + ':' + t, n = (warns.get(k) || 0) - 1;
  if (n <= 0) warns.delete(k); else warns.set(k, n);
  return { text: `✅ ${tagOf(t)} : ${Math.max(n, 0)}/3 avertissement(s).`, mentions: [t] };
}, { group: true, admin: true });
cmd('warnlist', 'groupe', 'Liste les avertissements du groupe.', ({ jid }) => {
  const list = [...warns.entries()].filter(([k]) => k.startsWith(jid + ':'));
  if (!list.length) return 'Aucun avertissement dans ce groupe.';
  const ids = list.map(([k]) => k.slice(jid.length + 1));
  return { text: '⚠️ Avertissements :\n' + list.map(([k, n]) => `${tagOf(k.slice(jid.length + 1))} : ${n}/3`).join('\n'), mentions: ids };
}, { group: true, admin: true });
cmd('resetwarns', 'groupe', 'Remet les avertissements à zéro (un membre ou tout le groupe).', ({ jid, m }) => {
  const t = targetsOf(m);
  if (t.length) t.forEach(x => warns.delete(jid + ':' + x));
  else for (const k of [...warns.keys()]) if (k.startsWith(jid + ':')) warns.delete(k);
  return 'Avertissements réinitialisés ✅';
}, { group: true, admin: true });
cmd('rules', 'groupe', 'Affiche les règles du groupe.', ({ jid }) => rulesMap.get(jid) ? `📋 *Règles du groupe*\n${rulesMap.get(jid)}` : 'Aucune règle définie. Un admin peut utiliser !setrules <texte>.', { group: true });
cmd('setrules', 'groupe', 'Définit les règles du groupe. Ex : !setrules 1. Respect', ({ jid, args }) => {
  const t = args.join(' ').trim();
  if (!t) return 'Écris les règles après la commande.';
  rulesMap.set(jid, t.slice(0, 1500)); return 'Règles enregistrées ✅';
}, { group: true, admin: true });
cmd('groupstats', 'groupe', 'Statistiques de commandes du groupe.', ({ jid }) => {
  const u = usageCount.get(jid);
  if (!u || !u.size) return 'Aucune activité enregistrée.';
  return `📊 ${[...u.values()].reduce((a, b) => a + b, 0)} commande(s) par ${u.size} membre(s) depuis le démarrage du bot.`;
}, { group: true });
cmd('invite', 'groupe', 'Envoie le lien du groupe à un numéro. Ex : !invite 224620000000', async ({ sock, jid, args }) => {
  const num = (args[0] || '').replace(/\D/g, '');
  if (num.length < 8) return 'Donne un numéro avec indicatif, sans + ni espaces.';
  try {
    const code = await sock.groupInviteCode(jid);
    await sock.sendMessage(num + '@s.whatsapp.net', { text: 'Tu es invité(e) à rejoindre un groupe :\nhttps://chat.whatsapp.com/' + code });
    return 'Invitation envoyée ✅';
  } catch { return NEED_ADMIN; }
}, { group: true, admin: true });
cmd('addmember', 'groupe', 'Ajoute un numéro au groupe. Ex : !addmember 224620000000', async ({ sock, jid, args }) => {
  const num = (args[0] || '').replace(/\D/g, '');
  if (num.length < 8) return 'Donne un numéro avec indicatif, sans + ni espaces.';
  try { await sock.groupParticipantsUpdate(jid, [num + '@s.whatsapp.net'], 'add'); return 'Ajout demandé ✅'; }
  catch { return NEED_ADMIN; }
}, { group: true, admin: true });
cmd('tagmembres', 'groupe', 'Mentionne uniquement les non-admins.', async ({ sock, jid, args }) => {
  const meta = await sock.groupMetadata(jid);
  const ids = meta.participants.filter(p => !p.admin).map(p => p.id);
  if (!ids.length) return 'Aucun membre simple.';
  return { text: (T(args) || 'Appel aux membres !') + '\n' + ids.map(tagOf).join(' '), mentions: ids };
}, { group: true, admin: true });
cmd('motinterdit', 'groupe', 'Mots interdits (supprimés pour les non-admins). Ex : !motinterdit add mot / remove mot / list', ({ jid, args }) => {
  const sub = (args[0] || '').toLowerCase(), w = norm(args.slice(1).join(' '));
  const set = forbidden.get(jid) || new Set(); forbidden.set(jid, set);
  if (sub === 'add' && w) { set.add(w); return `Mot interdit ajouté : ${w}`; }
  if (sub === 'remove' && w) { set.delete(w); return `Mot retiré : ${w}`; }
  if (sub === 'list') return set.size ? '🚫 ' + [...set].join(', ') : 'Aucun mot interdit.';
  return 'Utilise : !motinterdit add <mot> / remove <mot> / list';
}, { group: true, admin: true });
cmd('report', 'groupe', 'Signale un problème aux admins. Ex : !report spam dans le groupe', async ({ sock, jid, args, sender }) => {
  const meta = await sock.groupMetadata(jid);
  const admins = meta.participants.filter(p => p.admin).map(p => p.id);
  if (!admins.length) return 'Aucun admin à prévenir.';
  return { text: `🚨 Signalement de ${tagOf(sender)} : ${T(args) || '(sans détail)'}\n${admins.map(tagOf).join(' ')}`, mentions: [sender, ...admins] };
}, { group: true });
cmd('afk', 'groupe', 'Signale ton absence. Ex : !afk je dors / !afk off', ({ sender, args }) => {
  if ((args[0] || '').toLowerCase() === 'off') { afkMap.delete(sender); return 'Statut absent retiré.'; }
  afkMap.set(sender, { reason: T(args).slice(0, 100), since: Date.now() });
  return '💤 Tu es marqué(e) absent(e). Je préviendrai ceux qui te mentionnent.';
});

// ----- Réglages -----
cmd('setstatus', 'reglages', 'Change la bio du bot. Ex : !setstatus Disponible', async ({ sock, args, m }) => {
  if (!m.key.fromMe) return NOT_OWNER;
  const t = T(args);
  if (!t) return 'Écris le texte de la bio.';
  try { await sock.updateProfileStatus(t.slice(0, 139)); return 'Bio mise à jour ✅'; }
  catch { return 'Échec de la mise à jour.'; }
});
cmd('ban', 'reglages', 'Interdit à un utilisateur d\'utiliser le bot. Ex : !ban @membre', ({ m }) => {
  if (!m.key.fromMe) return NOT_OWNER;
  const t = targetsOf(m);
  if (!t.length) return 'Mentionne un utilisateur.';
  t.forEach(x => bannedUsers.add(x)); return 'Utilisateur banni du bot.';
});
cmd('unban', 'reglages', 'Autorise de nouveau un utilisateur. Ex : !unban @membre', ({ m }) => {
  if (!m.key.fromMe) return NOT_OWNER;
  const t = targetsOf(m);
  if (!t.length) return 'Mentionne un utilisateur.';
  t.forEach(x => bannedUsers.delete(x)); return 'Utilisateur débanni.';
});
const globalToggle = (name, help, get, set, label) => cmd(name, 'reglages', help, ({ args, m }) => {
  if (!m.key.fromMe) return NOT_OWNER;
  const v = (args[0] || '').toLowerCase();
  if (v === 'on') { set(true); return `${label} activé ✅`; }
  if (v === 'off') { set(false); return `${label} désactivé.`; }
  return `${label} : ${get() ? 'activé' : 'désactivé'}. Utilise on ou off.`;
});
globalToggle('autoread', 'Marque les messages reçus comme lus. Ex : !autoread on', () => autoreadOn, v => { autoreadOn = v; }, 'Lecture automatique');
globalToggle('autoreact', 'Réagit aux commandes avec un emoji. Ex : !autoreact on', () => autoreactOn, v => { autoreactOn = v; }, 'Réaction automatique');
cmd('settings', 'reglages', 'Affiche les réglages actifs dans ce chat.', ({ jid }) => {
  const on = s => (s.has(jid) ? '✅' : '❌');
  return [
    `⚙️ *Réglages*`,
    `Anti-lien ${on(antilink)} · Anti-suppression ${on(antidelete)} · Anti-spam ${on(antispamSet)} · Anti-tag ${on(antitagSet)}`,
    `Anti-image ${on(antiImage)} · Anti-vidéo ${on(antiVideo)} · Anti-sticker ${on(antiSticker)} · Anti-audio ${on(antiAudio)}`,
    `Anti-promotion ${on(antipromoteSet)} · Anti-rétrogradation ${on(antidemoteSet)}`,
    `Bienvenue ${on(welcomeSet)} · Au revoir ${on(goodbyeSet)} · Auto-suppression ${on(autodeleteSet)}`,
    `Mode privé ${on(privateChats)} · Sans préfixe ${on(noPrefixSet)}`,
    `Anti-appel ${anticallOn ? '✅' : '❌'} · Toujours en ligne ${alwaysOnlineTimer ? '✅' : '❌'} · Lecture auto ${autoreadOn ? '✅' : '❌'} · Réaction auto ${autoreactOn ? '✅' : '❌'}`
  ].join('\n');
});

// ---------- Traitement des messages ----------
const LINK = /(https?:\/\/|www\.|chat\.whatsapp\.com)/i;

async function handle(sock, m) {
  const jid = m.key.remoteJid;
  if (!jid || jid === 'status@broadcast') return;
  const isGroup = jid.endsWith('@g.us');
  const me = (sock.user?.id || '').split(':')[0].split('@')[0] + '@s.whatsapp.net';
  const sender = m.key.fromMe ? me : (m.key.participant || jid);

  // Déroule les messages éphémères / vue unique pour retrouver le vrai contenu
  m.message = normalizeMessageContent(m.message) || m.message;
  if (autoreadOn && !m.key.fromMe) sock.readMessages([m.key]).catch(() => {});

  // Anti-suppression : quelqu'un vient de supprimer un message pour tout le monde
  if (m.message.protocolMessage?.type === proto.Message.ProtocolMessage.Type.REVOKE && antidelete.has(jid)) {
    const delKey = jid + ':' + m.message.protocolMessage.key.id;
    const cached = msgCache.get(delKey);
    if (cached) {
      await sock.sendMessage(jid, { text: `🗑️ Message supprimé par ${tagOf(cached.sender)} :\n${cached.text}`, mentions: [cached.sender] });
    }
    return;
  }

  // Anti-médias : supprime certains types de contenu envoyés par des non-admins
  if (isGroup && !m.key.fromMe) {
    const mediaChecks = [[m.message.imageMessage, antiImage], [m.message.videoMessage, antiVideo], [m.message.stickerMessage, antiSticker], [m.message.audioMessage, antiAudio]];
    for (const [present, set] of mediaChecks) {
      if (present && set.has(jid)) {
        try {
          const meta = await sock.groupMetadata(jid);
          if (!isAdminIn(meta, sender)) { await sock.sendMessage(jid, { delete: m.key }); return; }
        } catch {}
      }
    }
  }

  // Membre muet : supprime ses messages (le bot doit être admin)
  if (isGroup && !m.key.fromMe && muted.has(jid + ':' + sender)) {
    try { await sock.sendMessage(jid, { delete: m.key }); } catch {}
    return;
  }

  const text = (m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || m.message.videoMessage?.caption || '').trim();
  if (text) {
    msgCache.set(jid + ':' + m.key.id, { text, sender });
    if (msgCache.size > 500) msgCache.delete(msgCache.keys().next().value);
  }
  if (!text) return;

  const px = prefixes.get(jid) || PREFIX;
  const firstWord = text.split(/\s+/)[0]?.toLowerCase() || '';
  const isCommandAttempt = text.startsWith(px) || (noPrefixSet.has(jid) && !!commands[firstWord]);
  // AFK : retire le statut quand la personne écrit, prévient quand on la mentionne
  if (afkMap.has(sender) && !(isCommandAttempt && norm(text.slice(px.length)).startsWith('afk'))) {
    const a = afkMap.get(sender); afkMap.delete(sender);
    await sock.sendMessage(jid, { text: `👋 Bon retour ${tagOf(sender)} ! Absent(e) depuis ${Math.max(1, Math.round((Date.now() - a.since) / 60000))} min.`, mentions: [sender] });
  }
  for (const u of (m.message.extendedTextMessage?.contextInfo?.mentionedJid || [])) {
    const a = afkMap.get(u);
    if (a && u !== sender) await sock.sendMessage(jid, { text: `💤 ${tagOf(u)} est absent(e)${a.reason ? ' : ' + a.reason : ''}.`, mentions: [u] }, { quoted: m });
  }
  if (m.key.fromMe && !isCommandAttempt) return;

  // Anti-lien : supprime le message, avertit, retire au 3e avertissement
  if (isGroup && !m.key.fromMe && antilink.has(jid) && LINK.test(text)) {
    const meta = await sock.groupMetadata(jid);
    if (!isAdminIn(meta, sender)) {
      try { await sock.sendMessage(jid, { delete: m.key }); } catch {}
      const k = jid + ':' + sender;
      const n = (warns.get(k) || 0) + 1; warns.set(k, n);
      const tag = tagOf(sender);
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

  // Mots interdits
  if (isGroup && !m.key.fromMe && forbidden.get(jid)?.size) {
    const nt = norm(text);
    if ([...forbidden.get(jid)].some(w => nt.includes(w))) {
      const meta = await sock.groupMetadata(jid);
      if (!isAdminIn(meta, sender)) {
        try { await sock.sendMessage(jid, { delete: m.key }); } catch {}
        await sock.sendMessage(jid, { text: `⚠️ ${tagOf(sender)}, ce mot est interdit dans ce groupe.`, mentions: [sender] });
        return;
      }
    }
  }

  // Anti-spam : trop de messages en peu de temps
  if (isGroup && !m.key.fromMe && antispamSet.has(jid)) {
    const fk = jid + ':' + sender;
    const now0 = Date.now();
    let f = floodTrack.get(fk);
    if (!f || now0 - f.start > 8000) f = { n: 0, start: now0 };
    f.n++; floodTrack.set(fk, f);
    if (f.n > 6) {
      try { await sock.sendMessage(jid, { delete: m.key }); } catch {}
      if (f.n === 7) await sock.sendMessage(jid, { text: `⚠️ ${tagOf(sender)}, ralentis un peu (anti-spam).`, mentions: [sender] });
      return;
    }
  }

  // Anti-tag : mentions en masse par un non-admin
  if (isGroup && !m.key.fromMe && antitagSet.has(jid)) {
    const mentions = m.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (mentions.length > 5) {
      const meta = await sock.groupMetadata(jid);
      if (!isAdminIn(meta, sender)) { try { await sock.sendMessage(jid, { delete: m.key }); } catch {} return; }
    }
  }

  // Mode privé : seul le propriétaire peut utiliser les commandes ici
  if (!m.key.fromMe && privateChats.has(jid) && isCommandAttempt) return;

  if (!isCommandAttempt) {
    // Répondeur automatique (hors commandes)
    if (!m.key.fromMe && awayMsg.has(jid)) {
      const last = awayCooldown.get(jid + ':' + sender) || 0;
      if (Date.now() - last > 3600000) {
        awayCooldown.set(jid + ':' + sender, Date.now());
        await sock.sendMessage(jid, { text: awayMsg.get(jid) }, { quoted: m });
      }
    }
    return;
  }

  const raw = text.startsWith(px) ? text.slice(px.length) : text;
  const [name, ...args] = raw.split(/\s+/);
  const c = commands[name.toLowerCase()];
  if (!c) return;
  if (bannedUsers.has(sender) && !m.key.fromMe) return;
  const now = Date.now();
  if (now - (lastCmd.get(sender) || 0) < 1500) return; // anti-spam commandes
  lastCmd.set(sender, now);
  if (autoreactOn) sock.sendMessage(jid, { react: { text: pick(['✅', '⚡', '🔥', '👍']), key: m.key } }).catch(() => {});

  const ctx = { sock, m, jid, sender, args, isGroup };
  let reply;
  try {
    if (c.group && !isGroup) reply = 'Cette commande marche seulement dans un groupe.';
    else if (c.admin) {
      const meta = await sock.groupMetadata(jid);
      const isAdmin = isAdminIn(meta, sender);
      reply = (isAdmin || sudoUsers.has(sender) || m.key.fromMe) ? await c.run(ctx) : 'Commande réservée aux admins du groupe.';
    } else reply = await c.run(ctx);
  } catch (e) {
    console.error('Erreur commande :', e?.message);
    reply = 'Une erreur est survenue.';
  }

  const uc = usageCount.get(jid) || new Map();
  uc.set(sender, (uc.get(sender) || 0) + 1);
  usageCount.set(jid, uc);

  if (reply) {
    const sent = await sock.sendMessage(jid, typeof reply === 'string' ? { text: reply } : reply, { quoted: m });
    if (sent?.key) {
      rememberSent(jid, sent.key);
      if (autodeleteSet.has(jid)) setTimeout(() => sock.sendMessage(jid, { delete: sent.key }).catch(() => {}), 30000);
    }
  }
}

// ---------- Connexion WhatsApp ----------
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version, auth: state, logger, printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'), markOnlineOnConnect: false
  });
  currentSock = sock;
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

  // Anti-appel : rejette les appels entrants quand !anticall on
  sock.ev.on('call', async calls => {
    if (!anticallOn) return;
    for (const call of calls) {
      if (call.status !== 'offer') continue;
      try {
        await sock.rejectCall(call.id, call.from);
        const last = callWarned.get(call.from) || 0;
        if (Date.now() - last > 60000) {
          callWarned.set(call.from, Date.now());
          await sock.sendMessage(call.chatId || call.from, { text: '📵 Les appels ne sont pas acceptés. Envoie un message écrit, merci.' });
        }
      } catch (e) { console.error('Erreur anti-appel :', e?.message); }
    }
  });

  // Messages de bienvenue / au revoir
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    try {
      if (action !== 'add' && action !== 'remove') return;
      const set = action === 'add' ? welcomeSet : goodbyeSet;
      if (!set.has(id)) return;
      const ids = participants.map(p => (typeof p === 'string' ? p : p.id || p.phoneNumber)).filter(Boolean);
      if (!ids.length) return;
      const meta = await sock.groupMetadata(id).catch(() => null);
      const list = ids.map(tagOf).join(' ');
      const text = action === 'add'
        ? `👋 Bienvenue ${list}${meta ? ' dans *' + meta.subject + '*' : ''} !`
        : `👋 ${list} a quitté le groupe. À bientôt !`;
      await sock.sendMessage(id, { text, mentions: ids });
    } catch (e) { console.error('Erreur bienvenue/au revoir :', e?.message); }
  });

  // Anti-promotion / anti-rétrogradation
  sock.ev.on('group-participants.update', async ({ id, participants, action, author }) => {
    try {
      if (action !== 'promote' && action !== 'demote') return;
      if (!(action === 'promote' ? antipromoteSet : antidemoteSet).has(id)) return;
      const meId = (sock.user?.id || '').split(':')[0].split('@')[0];
      if (!author || author.split('@')[0].split(':')[0] === meId || sudoUsers.has(author)) return;
      const ids = participants.map(p => (typeof p === 'string' ? p : p.id)).filter(Boolean);
      await sock.groupParticipantsUpdate(id, ids, action === 'promote' ? 'demote' : 'promote');
    } catch (e) { console.error('Erreur anti-promotion :', e?.message); }
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
