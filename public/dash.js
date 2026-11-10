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

function show(v) {
  document.querySelectorAll('[data-v]').forEach(s => s.classList.toggle('hidden', !s.dataset.v.split(' ').includes(v)));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.go === v));
  scrollTo(0, 0);
}
const toggle = id => $(id).classList.toggle('off');

function botCard(b) {
  const running = b.status !== 'stopped';
  const kids = [el('div', { class: 'row' },
    el('div', {}, el('strong', {}, b.label), el('div', { class: 'mut' }, '+' + b.phone)),
    el('span', { class: 'pill ' + b.status }, LABELS[b.status] || b.status))];
  if (b.pairingCode) {
    kids.push(el('div', { class: 'code' }, el('b', {}, b.pairingCode),
      el('span', { class: 'mut' }, 'Dans WhatsApp : Appareils connectés, Connecter avec un numéro, puis saisis ce code.')));
  }
  kids.push(el('div', { class: 'acts' },
    running
      ? el('button', { class: 'line', onclick: () => act(() => api(`/bots/${b.id}/stop`, 'POST')) }, 'Arrêter')
      : el('button', { class: 'g', onclick: () => act(() => api(`/bots/${b.id}/start`, 'POST')) }, 'Démarrer'),
    el('button', { class: 'danger', onclick: () => { if (confirm('Supprimer ce bot ?')) act(() => api(`/bots/${b.id}`, 'DELETE')); } }, 'Supprimer')));
  return el('div', { class: 'bot' }, ...kids);
}

async function load() {
  const o = await api('/overview');
  cfg = o.config;
  const u = o.user;
  const initial = u.name.trim().charAt(0).toUpperCase();
  $('hav').textContent = initial;
  $('avatar').firstChild.textContent = initial;
  $('name').textContent = u.name;
  $('email').textContent = u.email;
  $('since').textContent = 'Membre depuis le ' + new Date(u.createdAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const lvl = Math.floor(u.xp / 1000) + 1, into = u.xp % 1000;
  $('lvl').textContent = 'Niveau ' + lvl;
  $('xp').textContent = `${into}/1000 XP`;
  $('xpbar').style.width = into / 10 + '%';
  $('coins').textContent = u.coins;
  $('claims').textContent = `${u.claimsToday}/${cfg.dailyMax} aujourd'hui`;

  const on = o.bots.filter(b => b.status === 'online').length;
  $('sOn').textContent = on;
  $('sOff').textContent = o.bots.length - on;
  $('sSlots').textContent = u.slots;
  $('botCount').textContent = o.bots.length;
  $('slotCount').textContent = u.slots;
  $('firstBot').classList.toggle('off', o.bots.length > 0);
  $('needSlot').classList.toggle('off', u.slots > 0);
  const used = o.bots.filter(b => b.status !== 'stopped').length;
  $('slotInfo').textContent = u.slots
    ? `${used} slot(s) utilisé(s) sur ${u.slots}. Un slot fait tourner un bot.`
    : `Aucun slot actif. Un slot coûte ${cfg.slotPrice} coins.`;
  $('buySlot').textContent = `Acheter (${cfg.slotPrice})`;
  $('statsText').textContent = `${o.bots.length} bot(s), ${u.slots} slot(s), ${u.coins} coins, niveau ${lvl}.`;
  $('setInfo').textContent = `${u.name} · ${u.email}`;
  const links = $('setLinks');
  links.replaceChildren(...(u.role !== 'user' ? [el('a', { href: '/admin.html' }, el('button', { class: 'g full', style: 'margin-bottom:10px' }, 'Administration'))] : []));
  $('botList').replaceChildren(...(o.bots.length ? o.bots.map(botCard) : [el('p', { class: 'mut' }, 'Aucun bot pour le moment.')]));
}

document.querySelectorAll('nav button').forEach(b => { b.onclick = () => show(b.dataset.go); });
document.querySelectorAll('[data-soon]').forEach(b => { b.onclick = () => toast('Bientôt disponible.'); });
$('claim').onclick = () => act(() => api('/coins/claim', 'POST'));
$('buySlot').onclick = () => act(() => api('/slots/buy', 'POST'));
$('needBuy').onclick = () => act(() => api('/slots/buy', 'POST'));
for (const id of ['showAdd', 'firstAdd', 'addTop']) $(id).onclick = () => { $('addBox').classList.remove('off'); $('addBox').scrollIntoView({ behavior: 'smooth' }); };
$('showHelp').onclick = () => toggle('helpBox');
$('showTransfer').onclick = () => toggle('transferBox');
$('createBot').onclick = () => act(async () => {
  const d = await api('/bots', 'POST', { label: $('label').value, phone: $('phone').value });
  $('phone').value = ''; $('addBox').classList.add('off');
  return { ...d, message: 'Bot créé. Touche Démarrer pour obtenir le code de jumelage.' };
});
$('sendCoins').onclick = () => act(async () => {
  const d = await api('/coins/transfer', 'POST', { email: $('tmail').value, amount: $('tamount').value });
  $('tmail').value = ''; $('tamount').value = ''; $('transferBox').classList.add('off');
  return d;
});
$('logout').onclick = async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/'; };

show('home');
load().catch(e => toast(e.message));
setInterval(() => load().catch(() => {}), 5000);
