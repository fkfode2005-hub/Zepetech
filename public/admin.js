const $ = id => document.getElementById(id);

async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { location.href = '/'; throw new Error('Session expirée'); }
  if (r.status === 403 && path === '/admin/users') { location.href = '/dashboard.html'; throw new Error('Accès refusé'); }
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
const STATUS = { stopped: 'Arrêté', starting: 'Démarrage…', pairing: 'Jumelage', online: 'En ligne' };
const ROLE = { owner: 'Propriétaire', admin: 'Admin', user: 'Utilisateur' };

function coinsAction(u) {
  const v = prompt(`Combien de coins pour ${u.name} ? (nombre négatif pour en retirer)`);
  if (v === null || v.trim() === '') return;
  act(() => api(`/admin/users/${u.id}/coins`, 'POST', { amount: v }));
}

function botRow(b) {
  return el('div', { class: 'bot' },
    el('div', { class: 'row' },
      el('div', {}, el('strong', {}, b.label), el('p', { class: 'mut' }, '+' + b.phone)),
      el('span', { class: 'pill ' + b.status }, STATUS[b.status] || b.status)),
    el('div', { class: 'acts' },
      el('button', { class: 'line', onclick: () => act(() => api(`/admin/bots/${b.id}/stop`, 'POST')) }, 'Arrêter'),
      el('button', { class: 'danger', onclick: () => { if (confirm('Supprimer ce bot ?')) act(() => api(`/admin/bots/${b.id}`, 'DELETE')); } }, 'Supprimer')));
}

function userCard(u) {
  return el('div', { class: 'card' },
    el('div', { class: 'row' },
      el('div', {}, el('strong', {}, u.name), el('p', { class: 'mut' }, u.email)),
      el('span', { class: 'pill ' + u.role }, ROLE[u.role] || u.role)),
    el('p', { class: 'mut', style: 'margin-top:8px' }, `${u.coins} coins · ${u.slots} slot(s) · ${u.bots.length} bot(s)`),
    el('div', { class: 'acts' }, el('button', { class: 'gold', onclick: () => coinsAction(u) }, 'Donner ou retirer des coins')),
    ...u.bots.map(botRow));
}

async function load() {
  const { users } = await api('/admin/users');
  $('count').textContent = `${users.length} compte(s)`;
  $('list').replaceChildren(...users.map(userCard));
}

$('back').onclick = () => { location.href = '/dashboard.html'; };
load().catch(e => toast(e.message));
