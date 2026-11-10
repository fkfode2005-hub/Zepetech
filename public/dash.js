const $ = id => document.getElementById(id);
let cfg = { slotPrice: 100, dailyMax: 15 };

async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { location.href = '/'; throw new Error('Session expirée'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Erreur');
  return d;
}
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3200);
}
async function act(fn) {
  try { const d = await fn(); if (d && d.message) toast(d.message); await load(); }
  catch (e) { toast(e.message); }
}
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}
const LABELS = { stopped: 'Arrêté', starting: 'Démarrage…', pairing: 'Jumelage', online: 'En ligne' };

function botCard(b) {
  const running = b.status !== 'stopped';
  const kids = [
    el('div', { class: 'row' },
      el('div', {}, el('strong', {}, b.label), el('div', { class: 'mut' }, '+' + b.phone)),
      el('span', { class: 'pill ' + b.status }, LABELS[b.status] || b.status))
  ];
  if (b.pairingCode) {
    kids.push(el('div', { class: 'code' },
      el('b', {}, b.pairingCode),
      el('span', { class: 'mut' }, 'Dans WhatsApp : Appareils connectés → Connecter avec un numéro, puis saisis ce code.')));
  }
  kids.push(el('div', { class: 'acts' },
    running
      ? el('button', { class: 'line', onclick: () => act(() => api(`/bots/${b.id}/stop`, 'POST')) }, 'Arrêter')
      : el('button', { class: 'gold', onclick: () => act(() => api(`/bots/${b.id}/start`, 'POST')) }, 'Démarrer'),
    el('button', { class: 'danger', onclick: () => { if (confirm('Supprimer ce bot ?')) act(() => api(`/bots/${b.id}`, 'DELETE')); } }, 'Supprimer')));
  return el('div', { class: 'bot' }, ...kids);
}

async function load() {
  const o = await api('/overview');
  cfg = o.config;
  const u = o.user;
  $('name').textContent = u.name;
  $('avatar').textContent = u.name.trim().charAt(0).toUpperCase();
  $('email').textContent = u.email;
  $('since').textContent = 'Membre depuis le ' + new Date(u.createdAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  $('coins').textContent = u.coins;
  $('claims').textContent = `${u.claimsToday}/${cfg.dailyMax} aujourd'hui`;
  const on = o.bots.filter(b => b.status === 'online').length;
  const used = o.bots.filter(b => b.status !== 'stopped').length;
  $('sOn').textContent = on;
  $('sOff').textContent = o.bots.length - on;
  $('sSlots').textContent = Math.max(0, u.slots - used);
  $('botCount').textContent = `(${o.bots.length})`;
  $('slotInfo').textContent = u.slots
    ? `${u.slots} slot(s) au total, ${used} utilisé(s). Un slot permet de faire tourner un bot en même temps.`
    : `Aucun slot. Un slot coûte ${cfg.slotPrice} coins et permet de faire tourner un bot.`;
  $('buySlot').textContent = `Acheter (${cfg.slotPrice})`;
  const list = $('botList');
  list.replaceChildren(...(o.bots.length ? o.bots.map(botCard) : [el('p', { class: 'mut' }, 'Aucun bot. Touche « Ajouter un bot » pour commencer.')]));
}

$('claim').onclick = () => act(() => api('/coins/claim', 'POST'));
$('buySlot').onclick = () => act(() => api('/slots/buy', 'POST'));
$('showAdd').onclick = () => $('addBox').classList.toggle('hidden');
$('showTransfer').onclick = () => $('transferBox').classList.toggle('hidden');
$('createBot').onclick = () => act(async () => {
  const d = await api('/bots', 'POST', { label: $('label').value, phone: $('phone').value });
  $('phone').value = ''; $('addBox').classList.add('hidden');
  return { ...d, message: 'Bot créé. Touche Démarrer pour obtenir le code de jumelage.' };
});
$('sendCoins').onclick = () => act(async () => {
  const d = await api('/coins/transfer', 'POST', { email: $('tmail').value, amount: $('tamount').value });
  $('tmail').value = ''; $('tamount').value = ''; $('transferBox').classList.add('hidden');
  return d;
});
$('logout').onclick = async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/'; };

load().catch(e => toast(e.message));
setInterval(() => load().catch(() => {}), 5000);
