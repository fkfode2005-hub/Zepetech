// workers/menu.js - Générateur de menu professionnel pour ZEPE MD (module ES)
import os from 'node:os';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━';
const BOTTOM = '┗━━━━━━━━━━━━━━━━━━';
const MAX_LENGTH = 3500; // au-delà, le menu est découpé en plusieurs messages

// Ordre et noms affichés des catégories (clés = celles du registre de commandes)
export const LABELS = {
  outils: 'Outils',
  fun: 'Divertissement',
  jeux: 'Jeux',
  groupe: 'Groupe',
  reglages: 'Paramètres',
};

function formatUptime(ms) {
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (d) parts.push(`${d}j`);
  if (d || h) parts.push(`${h}h`);
  parts.push(`${String(m).padStart(2, '0')}m`);
  if (!d) parts.push(`${String(s).padStart(2, '0')}s`);
  return parts.join(' ');
}

const toGb = bytes => (bytes / 1024 ** 3).toFixed(1);
const pad = label => label.padEnd(13, ' ');

function buildHeader({ botName, owner, prefix, language, startedAt, total }) {
  const usedRam = os.totalmem() - os.freemem();
  return [
    botName.toUpperCase(),
    'Assistant WhatsApp',
    SEP,
    '',
    'INFORMATIONS',
    `${pad('Propriétaire')}: ${owner}`,
    `${pad('Préfixe')}: ${prefix || 'aucun'}`,
    `${pad('Langue')}: ${language}`,
    `${pad('Commandes')}: ${total}`,
    `${pad('Uptime')}: ${formatUptime(Date.now() - startedAt)}`,
    `${pad('Mémoire')}: ${toGb(usedRam)} / ${toGb(os.totalmem())} Go`,
    `${pad('Système')}: ${os.platform()} ${os.arch()}`,
    `${pad('Node.js')}: ${process.version}`,
    '',
    SEP,
  ].join('\n');
}

// Un bloc par catégorie (plusieurs blocs si la catégorie est très longue)
function buildCategoryBlocks(title, names, prefix) {
  const blocks = [];
  let current = [`┏━━ ${title.toUpperCase()} (${names.length})`];
  let length = current[0].length;
  for (const name of names) {
    const line = `┃ ${prefix}${name}`;
    if (length + line.length + BOTTOM.length > MAX_LENGTH) {
      current.push(BOTTOM);
      blocks.push(current.join('\n'));
      current = [`┏━━ ${title.toUpperCase()} (suite)`];
      length = current[0].length;
    }
    current.push(line);
    length += line.length + 1;
  }
  current.push(BOTTOM);
  blocks.push(current.join('\n'));
  return blocks;
}

/**
 * Construit le menu sous forme de tableau de messages.
 * @param {object} o
 * @param {object} o.commands   registre de commandes { nom: { cat, hidden } }
 * @param {string} [o.only]     clé d'une catégorie pour n'afficher que celle-ci
 */
export function buildMenu({ commands, botName = 'ZEPE MD', owner = '', prefix = '', language = 'Français', startedAt = Date.now(), only = null }) {
  const visible = Object.entries(commands).filter(([, c]) => !c.hidden);
  const total = visible.length;

  const keys = only && LABELS[only] ? [only] : Object.keys(LABELS);
  const blocks = [];
  for (const key of keys) {
    const names = visible.filter(([, c]) => c.cat === key).map(([n]) => n).sort((a, b) => a.localeCompare(b, 'fr'));
    if (names.length) blocks.push(...buildCategoryBlocks(LABELS[key], names, prefix));
  }

  const footer = [SEP, `Détails : ${prefix}aide <commande>`, `Catégorie : ${prefix}menu <nom>`, 'Zepe Tech Empire'].join('\n');

  const messages = [];
  let current = buildHeader({ botName, owner, prefix, language, startedAt, total });
  for (const block of blocks) {
    if (current.length + block.length + 2 > MAX_LENGTH) {
      messages.push(current);
      current = block;
    } else {
      current += '\n\n' + block;
    }
  }
  current += '\n\n' + footer;
  messages.push(current);
  return messages;
}
