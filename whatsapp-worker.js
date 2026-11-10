// workers/whatsapp-worker.js
// Lancé par server.js : node whatsapp-worker.js <numéro> <dossier-de-session>
// Écrit des lignes JSON lues par le serveur :
//   {"type":"pairing","code":"ZEPECODE"}  et  {"type":"status","status":"online"}
//
// Dépendances système (Termux) pour les médias : ffmpeg, libwebp (webpmux), yt-dlp (playaudio/playvideo)
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, downloadMediaMessage } from '@whiskeysockets/baileys';

const [phone, sessionDir] = process.argv.slice(2);
if (!phone || !sessionDir) { console.error('Usage: node whatsapp-worker.js <numéro> <session>'); process.exit(1); }

const PAIRING_CODE = 'ZEPECODE';
const BOT_NAME = 'ZEPE MD';
const OWNERS = ['224610888616']; // numéros des propriétaires (sans +) ; ajoute-en ici si besoin
const STICKER_PACK = 'ZEPE MD';
const STICKER_AUTHOR = 'ZEPE MD';

const START = Date.now();
const execFileP = promisify(execFile);
const send = obj => console.log(JSON.stringify(obj));
const noop = () => {};
const logger = { level: 'silent', trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child() { return logger; } };
const rnd = n => Math.floor(Math.random() * n);
const pick = a => a[rnd(a.length)];
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const num = j => String(j || '').split('@')[0].split(':')[0];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = s => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const shuffle = a => a.map(v => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(x => x[1]);

// ---------- Réglages persistants (fichier JSON dans le dossier de session) ----------
const DB_FILE = path.join(sessionDir, 'zepe-settings.json');
const saved = (() => { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; } })();
const db = {
  prefix: '!', noprefix: false, mode: 'public', menuImage: '', banned: [], users: [], groups: {},
  ...saved,
  global: { autovustatut: false, autowrite: false, autorecord: false, autoreact: false, autoreactstatus: false, anticall: false, antidelete: false, cmdreact: false, ...(saved.global || {}) }
};
const save = () => { try { fs.mkdirSync(sessionDir, { recursive: true }); fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch {} };
const users = new Set(db.users);
const flag = (jid, k) => !!db.groups[jid]?.[k];
const setFlag = (jid, k, v) => { (db.groups[jid] ||= {})[k] = v; save(); };

// État en mémoire (remis à zéro quand le bot redémarre)
const games = new Map();
const warns = new Map();
const lastCmd = new Map();
const spam = new Map();
const msgStore = new Map();

// ---------- Polices ----------
const shift = (s, U, L, D) => [...s].map(ch => {
  const c = ch.codePointAt(0);
  if (c >= 65 && c <= 90) return String.fromCodePoint(U + c - 65);
  if (c >= 97 && c <= 122) return String.fromCodePoint(L + c - 97);
  if (D && c >= 48 && c <= 57) return String.fromCodePoint(D + c - 48);
  return ch;
}).join('');
const bi = s => shift(s, 0x1D63C, 0x1D656); // gras italique (sans-serif)
const SC = { a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ғ', g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ', k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ', s: '𝙨', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: '𝙭', y: 'ʏ', z: 'ᴢ' };
const sc = s => [...String(s).toLowerCase()].map(ch => SC[ch] || ch).join('');
const FANCY = [
  s => shift(s, 0x1D400, 0x1D41A, 0x1D7CE),
  s => shift(s, 0x1D434, 0x1D44E).replace(/\u{1D455}/gu, 'ℎ'),
  s => shift(s, 0x1D468, 0x1D482),
  s => shift(s, 0x1D4D0, 0x1D4EA),
  s => shift(s, 0x1D670, 0x1D68A, 0x1D7F6),
  s => shift(s, 0x24B6, 0x24D0),
  sc
];

// ---------- Réseau et fichiers ----------
const UA = { 'user-agent': 'Mozilla/5.0 ZEPE-MD' };
async function http(url, opts = {}) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: UA, ...opts });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r;
}
const getJSON = async url => { const r = await http(url); return r ? r.json() : null; };
const getText = async url => { const r = await http(url); return r ? (await r.text()).trim() : null; };

async function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zepe-'));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const ffmpeg = (buf, outExt, args) => withTmp(async dir => {
  const i = path.join(dir, 'in.bin'), o = path.join(dir, 'out.' + outExt);
  fs.writeFileSync(i, buf);
  await execFileP('ffmpeg', ['-y', '-i', i, ...args, o], { timeout: 90000 });
  return fs.readFileSync(o);
});
const exifBuffer = (pack, author) => {
  const json = Buffer.from(JSON.stringify({ 'sticker-pack-id': crypto.randomUUID(), 'sticker-pack-name': pack, 'sticker-pack-publisher': author, emojis: ['🤖'] }), 'utf8');
  const head = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
  const exif = Buffer.concat([head, json]);
  exif.writeUIntLE(json.length, 14, 4);
  return exif;
};
// Ajoute le nom du pack avec webpmux (libwebp). Sans webpmux, le sticker part sans nom de pack.
const withExif = (webp, pack, author) => withTmp(async dir => {
  try {
    const i = path.join(dir, 'in.webp'), e = path.join(dir, 'm.exif'), o = path.join(dir, 'out.webp');
    fs.writeFileSync(i, webp); fs.writeFileSync(e, exifBuffer(pack, author));
    await execFileP('webpmux', ['-set', 'exif', e, i, '-o', o], { timeout: 30000 });
    return fs.readFileSync(o);
  } catch { return webp; }
});
const STICKER_VF = 'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000';
const toSticker = (buf, isVideo) => ffmpeg(buf, 'webp', [
  ...(isVideo ? ['-t', '8'] : []),
  '-vf', STICKER_VF + (isVideo ? ',fps=15' : ''),
  '-c:v', 'libwebp', '-q:v', '50', '-loop', '0', '-an'
]);

// ---------- Messages ----------
const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage'];
const unwrap = msg => {
  let x = msg;
  for (let i = 0; i < 5 && x; i++) {
    const w = WRAPPERS.find(k => x[k]?.message);
    if (!w) break;
    x = x[w].message;
  }
  return x;
};
const typeOf = msg => Object.keys(msg || {}).find(k => k !== 'messageContextInfo' && k !== 'senderKeyDistributionMessage');
const ctxInfo = content => content?.[typeOf(content)]?.contextInfo;
const getText2 = c => (c?.conversation || c?.extendedTextMessage?.text || c?.imageMessage?.caption || c?.videoMessage?.caption || c?.documentMessage?.caption || '').trim();
const isStatusMention = msg => [msg, unwrap(msg)].some(x => Object.keys(x || {}).some(k => /statusMention/i.test(k)));

// Trouve un média dans le message ou dans le message cité (en réponse)
function pickMedia(sock, m, types, preferQuoted = true) {
  const c = unwrap(m.message); const t = typeOf(c);
  const own = types.includes(t) ? { key: m.key, message: m.message, type: t, content: c[t] } : null;
  const ci = c?.[t]?.contextInfo;
  let q = null;
  if (ci?.quotedMessage) {
    const qc = unwrap(ci.quotedMessage); const qt = typeOf(qc);
    if (types.includes(qt)) q = { key: { remoteJid: m.key.remoteJid, id: ci.stanzaId, participant: ci.participant }, message: ci.quotedMessage, type: qt, content: qc[qt] };
  }
  const p = preferQuoted ? (q || own) : (own || q);
  if (!p) return null;
  p.get = () => downloadMediaMessage(p, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
  return p;
}
const targetsOf = m => {
  const ci = ctxInfo(unwrap(m.message));
  const s = new Set(ci?.mentionedJid || []);
  if (ci?.participant && ci?.quotedMessage) s.add(ci.participant);
  return [...s];
};

// ---------- Droits ----------
const idsOfPart = p => [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).map(num);
const adminIn = (meta, ids) => { const n = ids.filter(Boolean).map(num); return meta.participants.some(p => p.admin && idsOfPart(p).some(x => n.includes(x))); };
const meOf = sock => num(sock.user?.id) + '@s.whatsapp.net';
const meIds = sock => [sock.user?.id, sock.user?.lid].filter(Boolean);
const botIsAdmin = (meta, sock) => adminIn(meta, meIds(sock));

// ---------- Registre de commandes ----------
const commands = Object.create(null);
const CATS = {
  admin: '👑 Admin', infos: 'ℹ️ Infos', anti: '🛡️ Anti', auto: '🤖 Auto', moderation: '⚖️ Modération',
  reglages: '⚙️ Réglages', outils: '🔧 Outils', aide: '📚 Aide', jeux: '🎮 Jeux', medias: '🎥 Médias',
  social: '👋 Social', tags: '🏷️ Tags', extra: '🛠️ Outils'
};
const cmd = (name, cat, help, run, opts = {}) => { commands[name] = { cat, help, run, ...opts }; };
const alias = (name, of) => { commands[name] = { ...commands[of], hidden: true }; };
const onoff = args => { const v = norm(args[0] || ''); return v === 'on' ? true : v === 'off' ? false : null; };

const toggleGroup = (name, cat, label, help) => cmd(name, cat, help, ({ jid, args }) => {
  const v = onoff(args);
  if (v === null) return `${label} : ${flag(jid, name) ? 'activé' : 'désactivé'}. Utilise ${db.prefix}${name} on ou off.`;
  setFlag(jid, name, v);
  return `${label} ${v ? 'activé ✅ (le bot doit être admin pour agir).' : 'désactivé.'}`;
}, { group: true, admin: true });
const toggleGlobal = (name, cat, label, help) => cmd(name, cat, help, ({ args }) => {
  const v = onoff(args);
  if (v === null) return `${label} : ${db.global[name] ? 'activé' : 'désactivé'}. Utilise ${db.prefix}${name} on ou off.`;
  db.global[name] = v; save();
  return `${label} ${v ? 'activé ✅' : 'désactivé.'}`;
}, { owner: true });

// ---------- Contenus ----------
const JOKES = [
  'Pourquoi les plongeurs plongent-ils toujours en arrière ? Parce que sinon ils tombent dans le bateau.',
  'Quel est le comble pour un électricien ? De ne pas être au courant.',
  "Pourquoi l'ordinateur est-il allé chez le médecin ? Il avait un virus.",
  "Pourquoi les poissons n'aiment pas jouer au tennis ? Ils ont peur du filet.",
  'Que dit un escargot sur le dos d\'une tortue ? Youpiii !',
  'Que fait un crocodile qui surveille une pharmacie ? Il garde-Nil.'
];
const QUOTES = [
  "Un petit pas chaque jour vaut mieux qu'un grand saut un jour.",
  'Ce que tu répètes devient ce que tu es.',
  'Commence là où tu es, avec ce que tu as.',
  'La patience ouvre plus de portes que la force.',
  "Tes erreurs d'aujourd'hui sont les leçons de demain."
];
const MINDSET = [
  'Tu ne contrôles pas tout, mais tu contrôles ta réaction.',
  'La discipline bat la motivation quand la motivation disparaît.',
  "Compare-toi à celui que tu étais hier, pas à celui des autres.",
  "L'échec est une information, pas une identité.",
  'Ce qui est difficile aujourd’hui sera ton point fort demain.'
];
const ADVICE = [
  "Dors suffisamment : presque tout va mieux avec du repos.",
  "Écris tes tâches du jour avant de commencer, tu avanceras plus vite.",
  "Bois de l'eau avant de reprendre ton téléphone.",
  "Demande de l'aide tôt, ça évite de perdre des heures.",
  'Fais une sauvegarde avant de modifier quelque chose d’important.'
];
const EXCUSES = [
  "Mon réseau était coupé, je n'ai rien reçu.",
  "Mon téléphone était en charge de l'autre côté de la maison.",
  "J'ai vu ton message mais j'ai cru y avoir répondu.",
  "Il y avait une coupure de courant dans le quartier.",
  "Mon réveil a sonné, mais dans un autre fuseau horaire."
];
const SIGNS = ['bélier', 'taureau', 'gémeaux', 'cancer', 'lion', 'vierge', 'balance', 'scorpion', 'sagittaire', 'capricorne', 'verseau', 'poissons'];
const HORO = [
  "Journée calme : avance sur ce que tu repoussais depuis longtemps.",
  "Une bonne nouvelle arrive par une personne inattendue.",
  "Prends ton temps avant de décider, la réponse viendra ce soir.",
  "Ton énergie est haute : c'est le moment de commencer un projet.",
  "Évite les discussions inutiles, concentre-toi sur l'essentiel.",
  "Une petite dépense pourrait t'éviter un gros souci : sois prévoyant."
];
const QUIZ = [
  ['Quelle est la capitale de la Guinée ?', 'conakry'],
  ['Quelle est la capitale du Sénégal ?', 'dakar'],
  ['Quelle est la capitale de la France ?', 'paris'],
  ['Quel est le plus grand océan du monde ?', 'pacifique'],
  ['Quelle planète est la plus proche du Soleil ?', 'mercure'],
  ['Combien de côtés a un hexagone ?', '6'],
  ["Quelle est la formule chimique de l'eau ?", 'h2o'],
  ['Quel est le plus grand désert chaud du monde ?', 'sahara']
];
const WORDS = ['ordinateur', 'telephone', 'bonjour', 'amitie', 'voyage', 'musique', 'football', 'soleil', 'montagne', 'internet', 'bibliotheque', 'chocolat', 'jardin', 'riviere', 'guitare'];
const CARDS_V = ['As', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'Valet', 'Dame', 'Roi'];
const CARDS_S = ['♠️ pique', '♥️ cœur', '♦️ carreau', '♣️ trèfle'];
const EMOJIS = ['❤️', '🔥', '👍', '😂', '😍', '👏', '🙏', '✨'];

// =====================================================================
// COMMANDES
// =====================================================================

// ---------- Admin ----------
cmd('kick', 'admin', 'Retire un membre. Ex : !kick @membre (ou en réponse)', async ({ sock, jid, m }) => {
  const targets = targetsOf(m);
  if (!targets.length) return 'Mentionne le membre à retirer (ou réponds à son message).';
  const meta = await sock.groupMetadata(jid);
  const ok = targets.filter(t => !adminIn(meta, [t]) && !OWNERS.includes(num(t)) && !meIds(sock).map(num).includes(num(t)));
  if (!ok.length) return 'Je ne retire pas les admins, les propriétaires ni le bot.';
  try { await sock.groupParticipantsUpdate(jid, ok, 'remove'); return 'Membre retiré.'; }
  catch { return 'Impossible : le bot doit être admin du groupe.'; }
}, { group: true, admin: true });
cmd('promote', 'admin', 'Passe un membre admin. Ex : !promote @membre', async ({ sock, jid, m }) => {
  const t = targetsOf(m);
  if (!t.length) return 'Mentionne le membre (ou réponds à son message).';
  try { await sock.groupParticipantsUpdate(jid, t, 'promote'); return 'Membre promu admin ✅'; }
  catch { return 'Impossible : le bot doit être admin du groupe.'; }
}, { group: true, admin: true });
cmd('demote', 'admin', 'Retire le statut admin. Ex : !demote @membre', async ({ sock, jid, m }) => {
  const t = targetsOf(m);
  if (!t.length) return 'Mentionne l\'admin (ou réponds à son message).';
  try { await sock.groupParticipantsUpdate(jid, t, 'demote'); return 'Statut admin retiré.'; }
  catch { return 'Impossible : le bot doit être admin du groupe.'; }
}, { group: true, admin: true });
cmd('mute', 'admin', 'Ferme le groupe (seuls les admins écrivent).', async ({ sock, jid }) => {
  try { await sock.groupSettingUpdate(jid, 'announcement'); return 'Groupe fermé 🔒'; }
  catch { return 'Impossible : le bot doit être admin du groupe.'; }
}, { group: true, admin: true });
cmd('unmute', 'admin', 'Rouvre le groupe à tous.', async ({ sock, jid }) => {
  try { await sock.groupSettingUpdate(jid, 'not_announcement'); return 'Groupe ouvert 🔓'; }
  catch { return 'Impossible : le bot doit être admin du groupe.'; }
}, { group: true, admin: true });
cmd('admincheck', 'admin', 'Vérifie si toi et le bot êtes admins.', async ({ sock, jid, ids }) => {
  const meta = await sock.groupMetadata(jid);
  return `Toi : ${adminIn(meta, ids) ? 'admin ✅' : 'pas admin ❌'}\nBot : ${botIsAdmin(meta, sock) ? 'admin ✅' : 'pas admin ❌'}`;
}, { group: true });

// ---------- Infos ----------
cmd('grouplink', 'infos', "Donne le lien d'invitation du groupe.", async ({ sock, jid }) => {
  try { return 'https://chat.whatsapp.com/' + await sock.groupInviteCode(jid); }
  catch { return 'Impossible : le bot doit être admin du groupe.'; }
}, { group: true });
cmd('groupinfo', 'infos', 'Infos sur le groupe.', async ({ sock, jid }) => {
  const meta = await sock.groupMetadata(jid);
  return `*${meta.subject}*\nMembres : ${meta.participants.length}\nAdmins : ${meta.participants.filter(p => p.admin).length}${meta.desc ? '\n\n' + meta.desc : ''}`;
}, { group: true });
alias('infogroupe', 'groupinfo');

// ---------- Anti ----------
toggleGroup('antilink', 'anti', 'Anti-lien', "Supprime les liens (admins exemptés). Ex : !antilink on");
alias('antilien', 'antilink');
toggleGroup('antispam', 'anti', 'Anti-spam', 'Supprime les rafales de messages.');
toggleGroup('antiimage', 'anti', 'Anti-image', 'Supprime les images des non-admins.');
toggleGroup('antivideo', 'anti', 'Anti-vidéo', 'Supprime les vidéos des non-admins.');
toggleGroup('antiaudio', 'anti', 'Anti-audio', 'Supprime les audios et notes vocales des non-admins.');
toggleGroup('antisticker', 'anti', 'Anti-sticker', 'Supprime les stickers des non-admins.');
toggleGroup('antitag', 'anti', 'Anti-tag', 'Supprime les messages qui mentionnent 5 personnes ou plus.');
toggleGroup('antitransfer', 'anti', 'Anti-transfert', 'Supprime les messages transférés.');
toggleGroup('antibot', 'anti', 'Anti-bot', 'Supprime les messages venant d\'autres bots.');
toggleGroup('antistatut', 'anti', 'Anti-statut', 'Supprime les statuts qui mentionnent le groupe.');
alias('antistatus', 'antistatut');
toggleGroup('antipromote', 'anti', 'Anti-promotion', 'Annule les promotions admin faites par un non-propriétaire.');
toggleGroup('antidemote', 'anti', 'Anti-rétrogradation', 'Remet admin ceux qu\'un non-propriétaire a rétrogradés.');
toggleGroup('antipurge', 'anti', 'Anti-purge', 'Tente de réajouter les membres quand un non-propriétaire en retire 3 ou plus d\'un coup.');
cmd('antiforbidden', 'anti', 'Mots interdits. Ex : !antiforbidden on | add mot | del mot | list', ({ jid, args }) => {
  const g = (db.groups[jid] ||= {});
  const sub = norm(args[0] || '');
  const w = norm(args.slice(1).join(' '));
  if (sub === 'on' || sub === 'off') { g.antiforbidden = sub === 'on'; save(); return `Mots interdits ${g.antiforbidden ? 'activé ✅' : 'désactivé.'}`; }
  if (sub === 'add' && w) { g.words = [...new Set([...(g.words || []), w])]; save(); return `Ajouté : ${w}`; }
  if ((sub === 'del' || sub === 'remove') && w) { g.words = (g.words || []).filter(x => x !== w); save(); return `Retiré : ${w}`; }
  if (sub === 'list') return (g.words || []).length ? 'Mots interdits :\n' + g.words.join(', ') : 'Aucun mot interdit.';
  return `Mots interdits : ${g.antiforbidden ? 'activé' : 'désactivé'}. Utilise on, off, add, del ou list.`;
}, { group: true, admin: true });
toggleGlobal('anticall', 'anti', 'Anti-appel', 'Refuse automatiquement les appels (propriétaire). Ex : !anticall on');
toggleGlobal('antidelete', 'anti', 'Anti-suppression', 'Renvoie les messages supprimés (propriétaire).');

// ---------- Auto ----------
toggleGlobal('autovustatut', 'auto', 'Vue auto des statuts', 'Voit automatiquement les statuts (propriétaire).');
toggleGlobal('autowrite', 'auto', 'Écriture auto', "Affiche « écrit… » avant de répondre (propriétaire).");
toggleGlobal('autorecord', 'auto', 'Enregistrement auto', "Affiche « enregistre un audio… » (propriétaire).");
toggleGlobal('autoreact', 'auto', 'Réaction auto', 'Réagit à une partie des messages (propriétaire).');
toggleGlobal('autoreactstatus', 'auto', 'Réaction auto aux statuts', 'Réagit aux statuts (propriétaire).');

// ---------- Modération ----------
const banTarget = (m, args) => {
  const t = targetsOf(m);
  if (t.length) return num(t[0]);
  const n = (args[0] || '').replace(/\D/g, '');
  return n.length >= 6 ? n : null;
};
cmd('ban', 'moderation', "Interdit un utilisateur d'utiliser le bot. Ex : !ban @membre ou !ban 22462...", ({ m, args }) => {
  const n = banTarget(m, args);
  if (!n) return 'Mentionne la personne, réponds à son message ou donne son numéro.';
  if (OWNERS.includes(n)) return 'Impossible de bannir un propriétaire.';
  if (!db.banned.includes(n)) { db.banned.push(n); save(); }
  return `${n} est banni du bot.`;
}, { owner: true });
cmd('unban', 'moderation', 'Autorise de nouveau un utilisateur.', ({ m, args }) => {
  const n = banTarget(m, args);
  if (!n) return 'Mentionne la personne, réponds à son message ou donne son numéro.';
  db.banned = db.banned.filter(x => x !== n); save();
  return `${n} peut de nouveau utiliser le bot.`;
}, { owner: true });
cmd('banlist', 'moderation', 'Liste des bannis.', () => db.banned.length ? 'Bannis :\n' + db.banned.join('\n') : 'Aucun utilisateur banni.', { owner: true });

// ---------- Réglages ----------
cmd('cmdreact', 'reglages', 'Réagit aux commandes reçues. Ex : !cmdreact on', ({ args }) => {
  const v = onoff(args);
  if (v === null) return `Réaction aux commandes : ${db.global.cmdreact ? 'activée' : 'désactivée'}. Utilise on ou off.`;
  db.global.cmdreact = v; save(); return `Réaction aux commandes ${v ? 'activée ✅' : 'désactivée.'}`;
}, { owner: true });
cmd('setmenuimage', 'reglages', "Définit l'image du menu : réponds à une image, ou donne un lien, ou « off ".replace(' ', ' ') + '».', async ({ sock, m, args }) => {
  if (norm(args[0]) === 'off') { db.menuImage = ''; save(); return "Image du menu retirée."; }
  if (/^https?:\/\//i.test(args[0] || '')) { db.menuImage = args[0]; save(); return 'Image du menu définie ✅'; }
  const t = pickMedia(sock, m, ['imageMessage']);
  if (!t) return "Réponds à une image (ou envoie un lien, ou « off »).";
  const file = path.join(sessionDir, 'menu-image.jpg');
  fs.writeFileSync(file, await t.get());
  db.menuImage = file; save();
  return 'Image du menu définie ✅';
}, { owner: true });
cmd('prefix', 'reglages', 'Affiche ou change le préfixe. Ex : !prefix ou !prefix .', ({ args }) => {
  const p = args[0];
  if (!p) return `Préfixe actuel : ${db.prefix}\nMode sans préfixe : ${db.noprefix ? 'activé' : 'désactivé'}`;
  if (p.length > 3) return 'Le préfixe doit faire 3 caractères maximum.';
  db.prefix = p; save();
  return `Préfixe changé : ${p}`;
}, { owner: true });
alias('setprefix', 'prefix');
cmd('noprefix', 'reglages', 'Mode sans préfixe. Ex : !noprefix on | off | status', ({ args }) => {
  const v = norm(args[0] || 'status');
  if (v === 'on') { db.noprefix = true; save(); return 'Mode sans préfixe activé ✅ (les commandes marchent sans symbole).'; }
  if (v === 'off') { db.noprefix = false; save(); return 'Mode sans préfixe désactivé.'; }
  return `Mode sans préfixe : ${db.noprefix ? 'activé' : 'désactivé'}.`;
}, { owner: true });
const setPicture = async (sock, m, target) => {
  const t = pickMedia(sock, m, ['imageMessage']);
  if (!t) return 'Réponds à une image (ou envoie-la avec la commande en légende).';
  try { await sock.updateProfilePicture(target, await t.get()); return 'Photo mise à jour ✅'; }
  catch { return 'Échec : pour un groupe, le bot doit être admin ; vérifie aussi que `jimp` ou `sharp` est installé.'; }
};
cmd('setpp', 'reglages', 'Change la photo du bot (en réponse à une image).', ({ sock, m }) => setPicture(sock, m, meOf(sock)), { owner: true });
cmd('setgpp', 'reglages', 'Change la photo du groupe (en réponse à une image).', ({ sock, m, jid }) => setPicture(sock, m, jid), { group: true, admin: true });
cmd('setgdesc', 'reglages', 'Change la description du groupe. Ex : !setgdesc Bienvenue', async ({ sock, jid, args }) => {
  if (!args.length) return 'Écris la nouvelle description après la commande.';
  try { await sock.groupUpdateDescription(jid, args.join(' ')); return 'Description mise à jour ✅'; }
  catch { return 'Impossible : le bot doit être admin du groupe.'; }
}, { group: true, admin: true });
cmd('sendstory', 'reglages', 'Publie un statut : texte, ou image/vidéo en réponse. Ex : !sendstory Bonjour', async ({ sock, m, args }) => {
  const all = await sock.groupFetchAllParticipating();
  const list = new Set([meOf(sock)]);
  for (const g of Object.values(all)) for (const p of g.participants) { const id = p.phoneNumber || p.id; if (String(id).endsWith('@s.whatsapp.net')) list.add(id); }
  const opts = { statusJidList: [...list] };
  const t = pickMedia(sock, m, ['imageMessage', 'videoMessage']);
  const caption = args.join(' ');
  if (t) {
    const buf = await t.get();
    await sock.sendMessage('status@broadcast', t.type === 'imageMessage' ? { image: buf, caption } : { video: buf, caption }, opts);
  } else if (caption) await sock.sendMessage('status@broadcast', { text: caption, backgroundColor: '#075e54', font: 2 }, opts);
  else return 'Écris un texte ou réponds à une image/vidéo.';
  return 'Statut publié ✅';
}, { owner: true });
cmd('setprivate', 'reglages', 'Mode privé : seul le propriétaire utilise le bot.', () => { db.mode = 'private'; save(); return 'Mode privé activé 🔒'; }, { owner: true });
cmd('setpublic', 'reglages', 'Mode public : tout le monde utilise le bot.', () => { db.mode = 'public'; save(); return 'Mode public activé 🔓'; }, { owner: true });
cmd('chatjid', 'reglages', "Affiche l'identifiant de la discussion.", ({ jid }) => jid);
cmd('vcfgroupe', 'reglages', 'Exporte les membres du groupe en fichier contacts (.vcf).', async ({ sock, jid }) => {
  const meta = await sock.groupMetadata(jid);
  let i = 0;
  const cards = meta.participants.map(p => {
    const id = [p.phoneNumber, p.id].find(x => String(x || '').endsWith('@s.whatsapp.net'));
    if (!id) return null;
    i++;
    return `BEGIN:VCARD\nVERSION:3.0\nFN:Membre ${i}\nTEL;type=CELL;waid=${num(id)}:+${num(id)}\nEND:VCARD`;
  }).filter(Boolean);
  if (!cards.length) return 'Aucun numéro lisible dans ce groupe.';
  return { document: Buffer.from(cards.join('\n')), mimetype: 'text/vcard', fileName: `${meta.subject}.vcf` };
}, { group: true, admin: true });

// ---------- Outils ----------
cmd('fancy', 'outils', 'Écrit un texte dans plusieurs polices. Ex : !fancy Bonjour', ({ args }) => {
  const t = args.join(' ');
  return t ? FANCY.map(f => f(t)).join('\n\n') : 'Écris un texte après la commande.';
});
cmd('calc', 'outils', 'Calcule une expression. Ex : !calc (12+8)*3', ({ args }) => {
  const e = args.join(' ').replace(/,/g, '.').replace(/x/gi, '*');
  if (!e || e.length > 60 || e.includes('**') || !/^[0-9+\-*/().%\s]+$/.test(e)) return 'Écris un calcul simple. Ex : !calc (12+8)*3';
  try {
    const r = Function('"use strict";return (' + e + ')')();
    return Number.isFinite(r) ? `${e} = ${r}` : 'Calcul impossible.';
  } catch { return 'Calcul invalide.'; }
});
cmd('meteo', 'outils', 'Météo d\'une ville. Ex : !meteo Conakry', async ({ args }) => {
  if (!args.length) return 'Donne une ville. Ex : !meteo Conakry';
  const fmt = encodeURIComponent('%l : %c %C, %t (ressenti %f), humidité %h, vent %w');
  const t = await getText(`https://wttr.in/${encodeURIComponent(args.join(' '))}?format=${fmt}&lang=fr&m`);
  return t && !t.startsWith('<') ? t : 'Ville introuvable.';
});
cmd('wikipedia', 'outils', 'Résumé Wikipédia. Ex : !wikipedia Conakry', async ({ args }) => {
  const q = args.join(' ');
  if (!q) return 'Donne un sujet. Ex : !wikipedia Conakry';
  const s = await getJSON(`https://fr.wikipedia.org/w/api.php?action=opensearch&limit=1&format=json&search=${encodeURIComponent(q)}`);
  const title = s?.[1]?.[0];
  if (!title) return 'Aucun article trouvé.';
  const d = await getJSON(`https://fr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
  if (!d?.extract) return 'Aucun article trouvé.';
  return `*${d.title}*\n\n${d.extract.slice(0, 900)}\n\n${d.content_urls?.mobile?.page || ''}`;
});
cmd('shorturl', 'outils', 'Raccourcit un lien. Ex : !shorturl https://exemple.com/long', async ({ args }) => {
  if (!/^https?:\/\//i.test(args[0] || '')) return 'Donne un lien complet. Ex : !shorturl https://exemple.com';
  const t = await getText('https://is.gd/create.php?format=simple&url=' + encodeURIComponent(args[0]));
  return t || 'Impossible de raccourcir ce lien.';
});
cmd('qrcode', 'outils', 'Crée un QR code. Ex : !qrcode https://exemple.com', ({ args }) => {
  const t = args.join(' ');
  return t ? { image: { url: 'https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=' + encodeURIComponent(t) }, caption: 'Ton QR code' } : 'Écris le texte ou le lien à encoder.';
});
cmd('dictionnaire', 'outils', 'Définition d\'un mot. Ex : !dictionnaire soleil', async ({ args }) => {
  if (!args[0]) return 'Donne un mot. Ex : !dictionnaire soleil';
  const d = await getJSON('https://api.dictionaryapi.dev/api/v2/entries/fr/' + encodeURIComponent(args[0]));
  const e = Array.isArray(d) ? d[0] : null;
  if (!e) return 'Mot introuvable.';
  const lines = [`*${e.word}*`];
  for (const mean of (e.meanings || []).slice(0, 3)) lines.push(`_${mean.partOfSpeech}_ : ${mean.definitions?.[0]?.definition || ''}`);
  return lines.join('\n');
});
cmd('currency', 'outils', 'Convertit une devise. Ex : !currency 100 usd gnf', async ({ args }) => {
  const a = [...args];
  const amount = Number.isNaN(parseFloat(a[0])) ? 1 : parseFloat(a.shift());
  const from = (a[0] || 'usd').toUpperCase(), to = (a[1] || 'eur').toUpperCase();
  const d = await getJSON('https://open.er-api.com/v6/latest/' + from);
  const rate = d?.rates?.[to];
  if (!rate) return 'Devise inconnue. Ex : !currency 100 usd gnf';
  return `${amount} ${from} = ${(amount * rate).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} ${to}`;
});
cmd('reminder', 'outils', 'Rappel. Ex : !reminder 10m appeler Mamadou (s, m ou h)', ({ sock, jid, sender, args }) => {
  const x = /^(\d+)(s|m|h)$/i.exec(args[0] || '');
  if (!x || args.length < 2) return 'Ex : !reminder 10m appeler Mamadou (unités : s, m, h)';
  const ms = parseInt(x[1]) * { s: 1000, m: 60000, h: 3600000 }[x[2].toLowerCase()];
  if (ms < 1000 || ms > 86400000) return 'Durée entre 1 seconde et 24 heures.';
  const text = args.slice(1).join(' ');
  setTimeout(() => sock.sendMessage(jid, { text: `⏰ @${num(sender)} rappel : ${text}`, mentions: [sender] }).catch(noop), ms);
  return `D'accord, je te rappelle dans ${x[1]}${x[2]} (perdu si le bot redémarre).`;
});
cmd('broadcast', 'outils', 'Envoie un message à tous les groupes du bot. Ex : !broadcast Annonce', async ({ sock, args }) => {
  const text = args.join(' ');
  if (!text) return 'Écris le message à diffuser.';
  const groups = Object.keys(await sock.groupFetchAllParticipating());
  let ok = 0;
  for (const g of groups) { try { await sock.sendMessage(g, { text: `📢 *Annonce*\n\n${text}` }); ok++; } catch {} await sleep(1500); }
  return `Message envoyé à ${ok}/${groups.length} groupes.`;
}, { owner: true });
cmd('heure', 'outils', "Affiche la date et l'heure (UTC).", () => new Date().toLocaleString('fr-FR', { timeZone: 'UTC' }) + ' (UTC)');
cmd('mdp', 'outils', 'Génère un mot de passe. Ex : !mdp 16', ({ args }) => {
  const n = Math.min(32, Math.max(8, parseInt(args[0]) || 12));
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*?';
  return 'Ton mot de passe :\n' + Array.from(crypto.randomBytes(n), b => chars[b % chars.length]).join('');
});
cmd('choisir', 'outils', 'Choisit au hasard. Ex : !choisir pizza, riz, pâtes', ({ args }) => {
  const opts = args.join(' ').split(/,| ou /).map(s => s.trim()).filter(Boolean);
  return opts.length < 2 ? 'Donne au moins 2 choix séparés par des virgules.' : 'Je choisis : ' + pick(opts);
});

// ---------- Aide ----------
const fmtUp = () => {
  const s = Math.floor((Date.now() - START) / 1000);
  return `${Math.floor(s / 86400)}ᴊ ${Math.floor(s % 86400 / 3600)}ʜ ${Math.floor(s % 3600 / 60)}ᴍ ${s % 60}𝙨`;
};
cmd('ping', 'aide', 'Vérifie que le bot répond.', ({ m }) => {
  const ts = Number(m.messageTimestamp?.toNumber?.() ?? m.messageTimestamp ?? 0);
  const ms = Math.max(0, Date.now() - ts * 1000);
  return `Pong ! Le bot est en ligne ✅ (${ms} ms)`;
});
cmd('alive', 'aide', 'Indique que le bot est actif.', () => `🤖 ${BOT_NAME} est actif.\n⏳ Uptime : ${fmtUp()}`);
cmd('owner', 'aide', 'Contact du propriétaire.', () => ({
  contacts: { displayName: 'Propriétaire', contacts: [{ vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:Propriétaire ${BOT_NAME}\nTEL;type=CELL;waid=${OWNERS[0]}:+${OWNERS[0]}\nEND:VCARD` }] }
}));
cmd('info', 'aide', 'Infos sur le bot.', () => {
  const gb = n => (n / 1024 ** 3).toFixed(2);
  return `*${BOT_NAME}*\nPropriétaire : ${OWNERS[0]}\nPréfixe : ${db.prefix}\nMode : ${db.mode}\nCommandes : ${Object.values(commands).filter(c => !c.hidden).length}\nUptime : ${fmtUp()}\nRAM : ${gb(os.totalmem() - os.freemem())} / ${gb(os.totalmem())} GB\nNode.js : ${process.version}`;
});
function menuText() {
  const P = db.prefix;
  const gb = n => (n / 1024 ** 3).toFixed(2);
  const count = Object.values(commands).filter(c => !c.hidden).length;
  const L = [
    `🤖 *${sc(BOT_NAME)}* 🤖`,
    '᛭ ─── ❖ ── ✦ ── ❖ ─── ᛭',
    `👑 ${sc('propriétaire')} : ${OWNERS[0]}`,
    `⌨️ ${sc('préfixe')} : ${P}`,
    `🌐 ${sc('langue')} : ${sc('français')} 🇫🇷`,
    `📦 ${sc('commandes')} : ${count} ${sc('chargées')}`,
    `⏳ ${sc('uptime bot')} : ${fmtUp()}`,
    `🧠 ${sc('ram')} : ${gb(os.totalmem() - os.freemem())} ɢʙ / ${gb(os.totalmem())} ɢʙ`,
    `⚙️ ${sc('cpu')} : ${os.cpus().length} ${sc('cœurs')}`,
    `🟢 ${sc('node.js')} : ${sc(process.version)}`,
    '᛭ ─── ❖ ── ✦ ── ❖ ─── ᛭', '',
    bi("n'essaie jamais de réussir si tu n'es pas prêt à échouer"), ''
  ];
  for (const [cat, title] of Object.entries(CATS)) {
    const names = Object.entries(commands).filter(([, c]) => c.cat === cat && !c.hidden).map(([n]) => n);
    if (!names.length) continue;
    const [icon, ...rest] = title.split(' ');
    L.push(`╭✨ *${bi('Catégorie')} :* ${icon} ${bi(rest.join(' '))}`);
    for (const n of names) L.push(`│   ✦ ${P}${bi(n)}`);
    L.push('╰───────────────────────────💎', '');
  }
  L.push(bi("Parfois, tout ce qu'il faut, c'est faire le premier pas"), '', `> ${bi('POWERED BY ' + BOT_NAME)}`);
  return L.join('\n');
}
cmd('menu', 'aide', 'Affiche toutes les commandes.', async ({ sock, jid, m }) => {
  const img = db.menuImage;
  try {
    if (/^https?:\/\//i.test(img)) await sock.sendMessage(jid, { image: { url: img } }, { quoted: m });
    else if (img && fs.existsSync(img)) await sock.sendMessage(jid, { image: fs.readFileSync(img) }, { quoted: m });
  } catch {}
  return menuText();
});
cmd('aide', 'aide', 'Explique une commande. Ex : !aide calc', ({ args }) => {
  const n = (args[0] || '').replace(db.prefix, '').toLowerCase();
  const c = commands[n];
  return c ? `${db.prefix}${n} : ${c.help.replaceAll('!', db.prefix)}` : `Commande inconnue. Tape ${db.prefix}menu.`;
});

// ---------- Jeux : contenus ----------
cmd('mindset', 'jeux', 'Une pensée pour garder le bon état d\'esprit.', () => pick(MINDSET));
cmd('motivation', 'jeux', 'Un petit message pour avancer.', () => pick(QUOTES));
cmd('blague', 'jeux', 'Raconte une blague.', () => pick(JOKES));
cmd('excuse', 'jeux', 'Une excuse toute prête.', () => pick(EXCUSES));
cmd('conseil', 'jeux', 'Un conseil du jour.', () => pick(ADVICE));
cmd('citation', 'jeux', 'Une citation inspirante.', () => '« ' + pick(QUOTES) + ' »');
cmd('horoscope', 'jeux', 'Horoscope du jour. Ex : !horoscope lion', ({ args }) => {
  const s = norm(args[0] || '');
  const sign = SIGNS.find(x => norm(x) === s);
  if (!sign) return 'Choisis un signe : ' + SIGNS.join(', ');
  const day = new Date().toISOString().slice(0, 10);
  return `🔮 *${sign}* — ${HORO[hash(sign + day) % HORO.length]}`;
});

// ---------- Jeux : questions ----------
cmd('quiz', 'jeux', 'Pose une question. Réponds avec !rep <réponse>.', ({ jid }) => {
  const q = pick(QUIZ); games.set('quiz:' + jid, { answers: [norm(q[1])] });
  return '❓ ' + q[0] + '\nRéponds avec !rep <ta réponse>';
});
const openQuiz = cat => async ({ jid }) => {
  const d = await getJSON(`https://opentdb.com/api.php?amount=1&type=multiple${cat ? '&category=' + cat : ''}&encode=url3986`);
  const r = d?.results?.[0];
  if (!r) return 'Pas de question pour le moment, réessaie dans quelques secondes.';
  const dec = decodeURIComponent;
  const correct = dec(r.correct_answer);
  const opts = shuffle([...r.incorrect_answers.map(dec), correct]);
  const L = ['A', 'B', 'C', 'D'];
  games.set('open:' + jid, { answers: [norm(correct), norm(L[opts.indexOf(correct)])] });
  return `❓ ${dec(r.question)}\n\n${opts.map((o, i) => `${L[i]}. ${o}`).join('\n')}\n\n(en anglais) Réponds avec !rep <lettre>`;
};
cmd('quiz_anime', 'jeux', "Quiz sur les animes (en anglais). Réponds avec !rep <lettre>.", openQuiz(31));
cmd('trivia', 'jeux', 'Question culture générale (en anglais). Réponds avec !rep <lettre>.', openQuiz(null));
cmd('anagramme', 'jeux', 'Remets le mot dans l\'ordre. Réponds avec !rep <mot>.', ({ jid }) => {
  const w = pick(WORDS);
  let s = w;
  for (let i = 0; i < 20 && s === w; i++) s = shuffle([...w]).join('');
  games.set('ana:' + jid, { answers: [w] });
  return `🔤 Anagramme : *${s}*\nRéponds avec !rep <mot>`;
});
cmd('math', 'jeux', 'Calcul mental. Réponds avec !rep <résultat>.', ({ jid }) => {
  const a = 2 + rnd(30), b = 2 + rnd(20), op = pick(['+', '-', 'x']);
  const r = op === '+' ? a + b : op === '-' ? a - b : a * b;
  games.set('math:' + jid, { answers: [String(r)] });
  return `🧮 ${a} ${op} ${b} = ?\nRéponds avec !rep <résultat>`;
});
cmd('rep', 'jeux', 'Répond au quiz, trivia, anagramme ou calcul en cours.', ({ jid, args }) => {
  const key = ['quiz', 'open', 'ana', 'math'].map(p => p + ':' + jid).find(k => games.has(k));
  if (!key) return 'Aucune question en cours. Lance !quiz, !math ou !anagramme.';
  const a = norm(args.join(' '));
  if (a && games.get(key).answers.includes(a)) { games.delete(key); return '✅ Bonne réponse !'; }
  return '❌ Raté, essaie encore.';
});
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

const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const win = (b, p) => LINES.some(l => l.every(i => b[i] === p));
const show = b => [0, 3, 6].map(i => [0, 1, 2].map(j => (b[i + j] === 'X' ? '❌' : b[i + j] === 'O' ? '⭕' : `${i + j + 1}️⃣`)).join('')).join('\n');
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

// ---------- Jeux : images et API ----------
const apiImage = (name, help, fetcher) => cmd(name, 'jeux', help, async ctx => {
  const r = await fetcher(ctx);
  return r ? { image: { url: r.url }, caption: r.caption || '' } : 'Rien trouvé.';
});
apiImage('meme', 'Un mmème au hasard.', async () => { const d = await getJSON('https://meme-api.com/gimme'); return d && { url: d.url, caption: d.title }; });
apiImage('dogpic', 'Photo de chien.', async () => { const d = await getJSON('https://dog.ceo/api/breeds/image/random'); return d && { url: d.message, caption: '🐶' }; });
apiImage('neko', 'Image neko (anime).', async () => { const d = await getJSON('https://nekos.best/api/v2/neko'); return d?.results?.[0] && { url: d.results[0].url, caption: '😺' }; });
apiImage('avatar', 'Avatar généré. Ex : !avatar zepe', ({ args }) => ({ url: `https://api.dicebear.com/9.x/adventurer/png?size=512&seed=${encodeURIComponent(args.join(' ') || String(rnd(99999)))}`, caption: 'Ton avatar' }));
apiImage('unsplash', 'Photo sur un thème. Ex : !unsplash montagne', ({ args }) => ({ url: `https://loremflickr.com/900/600/${encodeURIComponent(norm(args[0] || 'nature'))}?lock=${rnd(9999)}`, caption: args[0] || 'nature' }));
apiImage('xkcd', 'Une bande dessinée xkcd.', async () => {
  const last = await getJSON('https://xkcd.com/info.0.json');
  const d = last && await getJSON(`https://xkcd.com/${1 + rnd(last.num)}/info.0.json`);
  return d && { url: d.img, caption: `*${d.title}*\n${d.alt}` };
});
apiImage('github', 'Profil GitHub. Ex : !github torvalds', async ({ args }) => {
  if (!args[0]) return null;
  const u = await getJSON('https://api.github.com/users/' + encodeURIComponent(args[0]));
  return u && { url: u.avatar_url, caption: `*${u.name || u.login}* (@${u.login})\n${u.bio || ''}\nDépôts : ${u.public_repos} | Abonnés : ${u.followers}\n${u.html_url}` };
});
apiImage('pokemon', 'Fiche Pokémon. Ex : !pokemon pikachu', async ({ args }) => {
  const p = await getJSON('https://pokeapi.co/api/v2/pokemon/' + encodeURIComponent(norm(args[0] || String(1 + rnd(1000)))));
  return p && { url: p.sprites?.other?.['official-artwork']?.front_default || p.sprites?.front_default, caption: `*${p.name}* (#${p.id})\nTypes : ${p.types.map(t => t.type.name).join(', ')}\nTaille : ${p.height / 10} m | Poids : ${p.weight / 10} kg` };
});
apiImage('rickandmorty', 'Personnage de Rick et Morty. Ex : !rickandmorty rick', async ({ args }) => {
  const d = args.length ? (await getJSON('https://rickandmortyapi.com/api/character/?name=' + encodeURIComponent(args.join(' ')))) ?.results?.[0] : await getJSON(`https://rickandmortyapi.com/api/character/${1 + rnd(826)}`);
  return d && { url: d.image, caption: `*${d.name}*\nStatut : ${d.status} | Espèce : ${d.species}` };
});
apiImage('ghibli', 'Un film du studio Ghibli.', async () => {
  const f = pick(await getJSON('https://ghibliapi.vercel.app/films') || []);
  return f && { url: f.image || f.movie_banner, caption: `*${f.title}* (${f.release_date})\nRéalisateur : ${f.director}\n${(f.description || '').slice(0, 400)}` };
});
apiImage('digimon', 'Fiche Digimon. Ex : !digimon agumon', async ({ args }) => {
  const list = args.length ? await getJSON('https://digimon-api.vercel.app/api/digimon/name/' + encodeURIComponent(args[0])) : await getJSON('https://digimon-api.vercel.app/api/digimon');
  const d = Array.isArray(list) ? (args.length ? list[0] : pick(list)) : null;
  return d && { url: d.img, caption: `*${d.name}*\nNiveau : ${d.level}` };
});
apiImage('disney', 'Personnage Disney. Ex : !disney mickey', async ({ args }) => {
  const d = await getJSON(args.length ? 'https://api.disneyapi.dev/character?name=' + encodeURIComponent(args.join(' ')) : `https://api.disneyapi.dev/character?page=${1 + rnd(100)}`);
  const c = Array.isArray(d?.data) ? (args.length ? d.data[0] : pick(d.data)) : d?.data;
  return c?.imageUrl && { url: c.imageUrl, caption: `*${c.name}*\n${(c.films || []).slice(0, 3).join(', ')}` };
});
cmd('catfact', 'jeux', 'Un fait sur les chats (en anglais).', async () => (await getJSON('https://catfact.ninja/fact'))?.fact || 'Rien trouvé.');
cmd('chucknorris', 'jeux', 'Une blague Chuck Norris (en anglais).', async () => (await getJSON('https://api.chucknorris.io/jokes/random'))?.value || 'Rien trouvé.');
cmd('carte', 'jeux', 'Tire une carte.', () => `🃏 ${pick(CARDS_V)} de ${pick(CARDS_S)}`);
cmd('couple', 'jeux', 'Compatibilité entre deux personnes. Ex : !couple @a @b (ou au hasard)', async ({ sock, jid, m, isGroup }) => {
  let t = targetsOf(m);
  if (t.length < 2 && isGroup) t = shuffle((await sock.groupMetadata(jid)).participants.map(p => p.id)).slice(0, 2);
  if (t.length < 2) return 'Mentionne deux personnes. Ex : !couple @a @b';
  const pct = hash([num(t[0]), num(t[1])].sort().join('+')) % 101;
  return { text: `💞 @${num(t[0])} + @${num(t[1])}\nCompatibilité : *${pct}%*`, mentions: t.slice(0, 2) };
});
cmd('pileouface', 'jeux', 'Lance une pièce.', () => pick(['Pile 🪙', 'Face 🪙']));
cmd('de', 'jeux', 'Lance un dé. Ex : !de 20', ({ args }) => {
  const n = Math.min(1000, Math.max(2, parseInt(args[0]) || 6));
  return `🎲 D${n} : ${1 + rnd(n)}`;
});
cmd('8ball', 'jeux', 'Pose une question. Ex : !8ball Vais-je réussir ?', ({ args }) =>
  args.length ? pick(['Oui, sans aucun doute.', 'Probablement.', 'Redemande plus tard.', 'Peu probable.', 'Non.', 'Tout indique que oui.']) : 'Pose une question après la commande.');
cmd('pfc', 'jeux', 'Pierre, feuille, ciseaux. Ex : !pfc pierre', ({ args }) => {
  const opts = ['pierre', 'feuille', 'ciseaux'];
  let you = norm(args[0] || ''); if (you === 'papier') you = 'feuille';
  if (!opts.includes(you)) return 'Choisis : pierre, feuille ou ciseaux.';
  const bot = pick(opts);
  const wins = { pierre: 'ciseaux', feuille: 'pierre', ciseaux: 'feuille' };
  const res = you === bot ? 'Égalité.' : wins[you] === bot ? 'Tu gagnes ! 🎉' : 'Je gagne ! 🤖';
  return `Toi : ${you}\nMoi : ${bot}\n${res}`;
});

// ---------- Médias ----------
cmd('tosticker', 'medias', 'Image ou vidéo → sticker (en réponse ou en légende). Ex : !tosticker pack|auteur', async ({ sock, jid, m, args }) => {
  const t = pickMedia(sock, m, ['imageMessage', 'videoMessage']);
  if (!t) return 'Réponds à une image ou une vidéo (ou envoie-la avec la commande en légende).';
  const [pack, author] = args.join(' ').split('|').map(s => s.trim());
  const webp = await toSticker(await t.get(), t.type === 'videoMessage');
  await sock.sendMessage(jid, { sticker: await withExif(webp, pack || STICKER_PACK, author || STICKER_AUTHOR) }, { quoted: m });
});
cmd('takesticker', 'medias', 'Change le nom du pack d\'un sticker. Ex : !takesticker pack|auteur (en réponse)', async ({ sock, jid, m, args }) => {
  const t = pickMedia(sock, m, ['stickerMessage']);
  if (!t) return 'Réponds à un sticker.';
  const [pack, author] = args.join(' ').split('|').map(s => s.trim());
  await sock.sendMessage(jid, { sticker: await withExif(await t.get(), pack || STICKER_PACK, author || STICKER_AUTHOR) }, { quoted: m });
});
cmd('toimage', 'medias', 'Sticker → image (en réponse).', async ({ sock, jid, m }) => {
  const t = pickMedia(sock, m, ['stickerMessage']);
  if (!t) return 'Réponds à un sticker.';
  await sock.sendMessage(jid, { image: await ffmpeg(await t.get(), 'png', []) }, { quoted: m });
});
cmd('tovideo', 'medias', 'Sticker animé → vidéo (en réponse).', async ({ sock, jid, m }) => {
  const t = pickMedia(sock, m, ['stickerMessage']);
  if (!t) return 'Réponds à un sticker animé.';
  const mp4 = await ffmpeg(await t.get(), 'mp4', ['-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-movflags', 'faststart']);
  await sock.sendMessage(jid, { video: mp4, gifPlayback: true }, { quoted: m });
});
cmd('tomp3', 'medias', 'Vidéo ou audio → MP3 (en réponse).', async ({ sock, jid, m }) => {
  const t = pickMedia(sock, m, ['videoMessage', 'audioMessage']);
  if (!t) return 'Réponds à une vidéo ou un audio.';
  await sock.sendMessage(jid, { audio: await ffmpeg(await t.get(), 'mp3', ['-vn', '-b:a', '128k']), mimetype: 'audio/mpeg' }, { quoted: m });
});
const needUrl = a => /^https?:\/\//i.test(a || '');
cmd('sendimage', 'medias', 'Envoie une image depuis un lien. Ex : !sendimage https://…', ({ args }) => needUrl(args[0]) ? { image: { url: args[0] }, caption: args.slice(1).join(' ') } : 'Donne un lien. Ex : !sendimage https://…');
cmd('sendvideo', 'medias', 'Envoie une vidéo depuis un lien.', ({ args }) => needUrl(args[0]) ? { video: { url: args[0] }, caption: args.slice(1).join(' ') } : 'Donne un lien. Ex : !sendvideo https://…');
cmd('sendaudio', 'medias', 'Envoie un audio depuis un lien.', ({ args }) => needUrl(args[0]) ? { audio: { url: args[0] }, mimetype: 'audio/mpeg' } : 'Donne un lien. Ex : !sendaudio https://…');
cmd('senddocument', 'medias', 'Envoie un fichier depuis un lien. Ex : !senddocument https://… nom.pdf', ({ args }) => {
  if (!needUrl(args[0])) return 'Donne un lien. Ex : !senddocument https://… nom.pdf';
  const name = args[1] || decodeURIComponent(args[0].split('?')[0].split('/').pop() || 'fichier');
  return { document: { url: args[0] }, mimetype: 'application/octet-stream', fileName: name };
});
cmd('sendsticker', 'medias', 'Envoie un sticker depuis un lien d\'image.', async ({ args }) => {
  if (!needUrl(args[0])) return 'Donne un lien d\'image. Ex : !sendsticker https://…';
  const r = await http(args[0]);
  if (!r) return 'Lien introuvable.';
  const webp = await toSticker(Buffer.from(await r.arrayBuffer()), false);
  return { sticker: await withExif(webp, STICKER_PACK, STICKER_AUTHOR) };
});
const ytdlp = (kind, q) => withTmp(async dir => {
  const src = /^https?:\/\//i.test(q) ? q : 'ytsearch1:' + q;
  const args = kind === 'audio'
    ? ['-x', '--audio-format', 'mp3', '-f', 'bestaudio']
    : ['-f', 'best[height<=480][ext=mp4]/best[height<=480]/best'];
  await execFileP('yt-dlp', ['--no-playlist', '--max-filesize', '45M', ...args, '-o', path.join(dir, 'f.%(ext)s'), src], { timeout: 180000 });
  const f = fs.readdirSync(dir)[0];
  return f ? fs.readFileSync(path.join(dir, f)) : null;
});
const play = kind => async ({ args }) => {
  const q = args.join(' ');
  if (!q) return `Donne un titre ou un lien. Ex : !play${kind} despacito`;
  let buf;
  try { buf = await ytdlp(kind, q); }
  catch (e) { return e?.code === 'ENOENT' ? 'yt-dlp n\'est pas installé sur ce serveur.' : 'Téléchargement impossible (fichier trop lourd ou introuvable).'; }
  if (!buf) return 'Rien trouvé.';
  return kind === 'audio' ? { audio: buf, mimetype: 'audio/mpeg' } : { video: buf, caption: q };
};
cmd('playaudio', 'medias', 'Télécharge l\'audio d\'une vidéo YouTube. Ex : !playaudio titre', play('audio'));
cmd('playvideo', 'medias', 'Télécharge une vidéo YouTube. Ex : !playvideo titre', play('video'));
cmd('url', 'medias', 'Héberge une image/vidéo/audio et donne un lien (en réponse).', async ({ sock, m }) => {
  const t = pickMedia(sock, m, ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage']);
  if (!t) return 'Réponds à un média.';
  const mime = t.content.mimetype || 'application/octet-stream';
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', new Blob([await t.get()], { type: mime }), 'file.' + (mime.split('/')[1] || 'bin').split(';')[0]);
  const r = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
  const link = (await r.text()).trim();
  return /^https?:\/\//.test(link) ? link : 'Envoi impossible.';
});

// ---------- Social ----------
const msgCmd = (name, label, defMsg) => cmd(name, 'social', `${label}. Ex : !${name} on | off | set <message> (@user, @group)`, ({ jid, args }) => {
  const g = (db.groups[jid] ||= {});
  const sub = norm(args[0] || '');
  if (sub === 'on' || sub === 'off') { g[name] = sub === 'on'; save(); return `${label} ${g[name] ? 'activé ✅' : 'désactivé.'}`; }
  if (sub === 'set' && args.length > 1) { g[name + 'Msg'] = args.slice(1).join(' '); save(); return 'Message enregistré ✅'; }
  return `${label} : ${g[name] ? 'activé' : 'désactivé'}.\nMessage : ${g[name + 'Msg'] || defMsg}\nUtilise on, off ou set <message>.`;
}, { group: true, admin: true });
const WELCOME = 'Bienvenue @user dans *@group* 🎉';
const GOODBYE = 'Au revoir @user 👋';
msgCmd('welcome', 'Message de bienvenue', WELCOME);
msgCmd('goodbye', "Message d'au revoir", GOODBYE);
cmd('leave', 'social', 'Le bot quitte le groupe.', async ({ sock, jid }) => { await sock.sendMessage(jid, { text: 'Au revoir 👋' }); await sock.groupLeave(jid); }, { group: true, admin: true });

// ---------- Tags ----------
cmd('tagall', 'tags', 'Mentionne tout le monde (admins).', async ({ sock, jid, args }) => {
  const meta = await sock.groupMetadata(jid);
  const ids = meta.participants.map(p => p.id);
  return { text: (args.join(' ') || 'Appel à tous !') + '\n' + ids.map(id => '@' + num(id)).join(' '), mentions: ids };
}, { group: true, admin: true });
cmd('tagadmin', 'tags', 'Mentionne les admins.', async ({ sock, jid, args }) => {
  const meta = await sock.groupMetadata(jid);
  const ids = meta.participants.filter(p => p.admin).map(p => p.id);
  return { text: (args.join(' ') || 'Appel aux admins !') + '\n' + ids.map(id => '@' + num(id)).join(' '), mentions: ids };
}, { group: true });

// ---------- Outils (vues) ----------
cmd('vues', 'extra', "Nombre d'utilisateurs uniques du bot.", () => `👥 Utilisateurs uniques : ${users.size}`);
cmd('yeah', 'extra', 'Récupère un média « vue unique » (en réponse).', async ({ sock, jid, m }) => {
  const t = pickMedia(sock, m, ['imageMessage', 'videoMessage', 'audioMessage']);
  if (!t) return 'Réponds à un média « vue unique ».';
  const buf = await t.get();
  const caption = t.content.caption || '';
  if (t.type === 'imageMessage') await sock.sendMessage(jid, { image: buf, caption }, { quoted: m });
  else if (t.type === 'videoMessage') await sock.sendMessage(jid, { video: buf, caption }, { quoted: m });
  else await sock.sendMessage(jid, { audio: buf, mimetype: t.content.mimetype || 'audio/mp4', ptt: !!t.content.ptt }, { quoted: m });
});

// =====================================================================
// TRAITEMENT DES MESSAGES
// =====================================================================
const LINK = /(https?:\/\/|www\.|chat\.whatsapp\.com)/i;
const ANTI_KEYS = ['antilink', 'antispam', 'antiimage', 'antivideo', 'antiaudio', 'antisticker', 'antitag', 'antitransfer', 'antibot', 'antistatut', 'antiforbidden'];

function violation(g, jid, sender, text, type, m) {
  const ci = ctxInfo(unwrap(m.message));
  if (g.antilink && LINK.test(text)) return 'les liens sont interdits dans ce groupe.';
  if (g.antiimage && type === 'imageMessage') return 'les images sont interdites dans ce groupe.';
  if (g.antivideo && type === 'videoMessage') return 'les vidéos sont interdites dans ce groupe.';
  if (g.antiaudio && type === 'audioMessage') return 'les audios sont interdits dans ce groupe.';
  if (g.antisticker && type === 'stickerMessage') return 'les stickers sont interdits dans ce groupe.';
  if (g.antitag && (ci?.mentionedJid?.length || 0) >= 5) return 'les mentions en masse sont interdites.';
  if (g.antitransfer && ci?.isForwarded) return 'les messages transférés sont interdits.';
  if (g.antibot && /^BAE5/.test(m.key.id || '')) return 'les bots sont interdits ici.';
  if (g.antistatut && isStatusMention(m.message)) return 'les statuts qui mentionnent le groupe sont interdits ici.';
  if (g.antiforbidden && g.words?.length) { const t = norm(text); if (g.words.some(w => t.includes(w))) return 'ce mot est interdit dans ce groupe.'; }
  if (g.antispam) {
    const now = Date.now(), k = jid + ':' + sender;
    const arr = (spam.get(k) || []).filter(t => now - t < 8000); arr.push(now); spam.set(k, arr);
    if (arr.length >= 6) { spam.delete(k); return 'arrête de spammer.'; }
  }
  return null;
}

// Supprime le message, avertit, retire au 3e avertissement
async function sanction(sock, m, jid, sender, reason) {
  try { await sock.sendMessage(jid, { delete: m.key }); } catch {}
  const k = jid + ':' + sender;
  const n = (warns.get(k) || 0) + 1; warns.set(k, n);
  const tag = '@' + num(sender);
  if (n >= 3) {
    warns.delete(k);
    await sock.sendMessage(jid, { text: `${tag} a reçu 3 avertissements et est retiré.`, mentions: [sender] });
    try { await sock.groupParticipantsUpdate(jid, [sender], 'remove'); } catch {}
  } else {
    await sock.sendMessage(jid, { text: `⚠️ ${tag}, ${reason} Avertissement ${n}/3.`, mentions: [sender] });
  }
}

async function handle(sock, m) {
  const jid = m.key.remoteJid;
  if (!jid || jid === 'status@broadcast') return;
  const isGroup = jid.endsWith('@g.us');
  const me = meOf(sock);
  const sender = m.key.fromMe ? me : (m.key.participant || jid);
  const ids = [sender, m.key.participantAlt, m.key.participantPn, m.key.remoteJidAlt].filter(Boolean);
  const isOwner = !!m.key.fromMe || ids.some(i => OWNERS.includes(num(i)));
  const content = unwrap(m.message);
  const type = typeOf(content);
  const text = getText2(content);

  if (!m.key.fromMe && db.global.autowrite) sock.sendPresenceUpdate('composing', jid).catch(noop);
  else if (!m.key.fromMe && db.global.autorecord) sock.sendPresenceUpdate('recording', jid).catch(noop);
  if (!m.key.fromMe && db.global.autoreact && Math.random() < 0.4) sock.sendMessage(jid, { react: { text: pick(EMOJIS), key: m.key } }).catch(noop);

  // Règles anti-... (admins et propriétaires exemptés)
  const g = db.groups[jid];
  if (isGroup && !m.key.fromMe && !isOwner && g && ANTI_KEYS.some(k => g[k])) {
    const meta = await sock.groupMetadata(jid);
    if (!adminIn(meta, ids)) {
      const why = violation(g, jid, sender, text, type, m);
      if (why) { await sanction(sock, m, jid, sender, why); return; }
    }
  }

  if (!text) return;
  const P = db.prefix;
  const usedPrefix = text.startsWith(P);
  if (m.key.fromMe && !usedPrefix) return;
  if (!usedPrefix && !db.noprefix) return;
  const [name, ...args] = (usedPrefix ? text.slice(P.length) : text).trim().split(/\s+/);
  const c = commands[(name || '').toLowerCase()];
  if (!c) return;
  if (db.banned.some(b => ids.some(i => num(i) === b)) && !isOwner) return;
  if (db.mode === 'private' && !isOwner) return;
  const now = Date.now();
  if (now - (lastCmd.get(sender) || 0) < 1500) return; // anti-spam
  lastCmd.set(sender, now);

  const uid = num(ids.find(i => i.endsWith('@s.whatsapp.net')) || sender);
  if (!users.has(uid)) { users.add(uid); db.users = [...users]; save(); }
  if (db.global.cmdreact) sock.sendMessage(jid, { react: { text: '⚡', key: m.key } }).catch(noop);

  const ctx = { sock, m, jid, sender, ids, args, isGroup, isOwner };
  let reply;
  try {
    if (c.owner && !isOwner) reply = 'Commande réservée au propriétaire du bot.';
    else if (c.group && !isGroup) reply = 'Cette commande marche seulement dans un groupe.';
    else if (c.admin && !isOwner) {
      const meta = await sock.groupMetadata(jid);
      reply = adminIn(meta, ids) ? await c.run(ctx) : 'Commande réservée aux admins du groupe.';
    } else reply = await c.run(ctx);
  } catch (e) {
    console.error('Erreur commande :', name, e?.message);
    reply = 'Une erreur est survenue. Réessaie dans un instant.';
  }
  if (reply) await sock.sendMessage(jid, typeof reply === 'string' ? { text: reply } : reply, { quoted: m });
}

// Arrivées, départs, promotions, rétrogradations
async function onParticipants(sock, { id, participants, action, author }) {
  const g = db.groups[id];
  if (!g) return;
  const list = (participants || []).map(p => (typeof p === 'string' ? p : p.id));
  const own = [...meIds(sock).map(num), ...OWNERS];
  const trusted = !author || own.includes(num(author));
  if (action === 'add' && g.welcome) {
    const meta = await sock.groupMetadata(id);
    for (const u of list) await sock.sendMessage(id, { text: (g.welcomeMsg || WELCOME).replaceAll('@user', '@' + num(u)).replaceAll('@group', meta.subject), mentions: [u] });
  } else if (action === 'remove' && g.goodbye) {
    const meta = await sock.groupMetadata(id);
    for (const u of list) await sock.sendMessage(id, { text: (g.goodbyeMsg || GOODBYE).replaceAll('@user', '@' + num(u)).replaceAll('@group', meta.subject), mentions: [u] });
  }
  if (trusted) return;
  const tag = '@' + num(author);
  if (action === 'promote' && g.antipromote) {
    try { await sock.groupParticipantsUpdate(id, list, 'demote'); await sock.sendMessage(id, { text: `⚠️ ${tag}, les promotions sont bloquées dans ce groupe.`, mentions: [author] }); } catch {}
  } else if (action === 'demote' && g.antidemote) {
    try { await sock.groupParticipantsUpdate(id, list, 'promote'); await sock.sendMessage(id, { text: `⚠️ ${tag}, les rétrogradations sont bloquées dans ce groupe.`, mentions: [author] }); } catch {}
  } else if (action === 'remove' && g.antipurge && list.length >= 3) {
    try { await sock.groupParticipantsUpdate(id, list, 'add'); await sock.sendMessage(id, { text: `⚠️ ${tag}, les retraits en masse sont bloqués dans ce groupe.`, mentions: [author] }); } catch {}
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
      sock.ev.removeAllListeners();
      setTimeout(start, 3000);
    }
  });

  sock.ev.on('group-participants.update', ev => onParticipants(sock, ev).catch(e => console.error('Erreur groupe :', e?.message)));

  sock.ev.on('call', async calls => {
    if (!db.global.anticall) return;
    for (const c of calls || []) {
      if (c.status !== 'offer') continue;
      try {
        await sock.rejectCall(c.id, c.from);
        await sock.sendMessage(c.from, { text: "📵 Les appels ne sont pas acceptés, envoie un message." });
      } catch {}
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      if (!m.message) continue;
      const ts = Number(m.messageTimestamp?.toNumber?.() ?? m.messageTimestamp ?? 0);
      if (Date.now() / 1000 - ts > 60) continue; // ignore les vieux messages
      try {
        // Statuts : vue et réaction automatiques
        if (m.key.remoteJid === 'status@broadcast') {
          if (m.key.fromMe) continue;
          if (db.global.autovustatut) await sock.readMessages([m.key]);
          if (db.global.autoreactstatus) {
            const who = m.key.participant || m.participant;
            await sock.sendMessage('status@broadcast', { react: { key: m.key, text: pick(EMOJIS) } }, { statusJidList: [who, meOf(sock)].filter(Boolean) });
          }
          continue;
        }
        // Anti-suppression : renvoie le message supprimé
        const pm = m.message.protocolMessage;
        if (pm) {
          if ((pm.type === 0 || pm.type === 'REVOKE') && db.global.antidelete && pm.key?.id) {
            const orig = msgStore.get(pm.key.id);
            if (orig && !orig.key.fromMe) {
              const who = orig.key.participant || orig.key.remoteJid;
              await sock.sendMessage(m.key.remoteJid, { text: `🗑 Message supprimé par @${num(who)} :`, mentions: [who] });
              await sock.sendMessage(m.key.remoteJid, { forward: orig });
            }
          }
          continue;
        }
        if (m.key.id) {
          msgStore.set(m.key.id, m);
          if (msgStore.size > 400) msgStore.delete(msgStore.keys().next().value);
        }
        await handle(sock, m);
      } catch (e) { console.error('Erreur message :', e?.message); }
    }
  });
}

process.on('SIGTERM', () => process.exit(0));
start().catch(e => { console.error(e); process.exit(1); });
