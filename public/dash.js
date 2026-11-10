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

let currentView = 'home';
function show(v) {
  currentView = v;
  if (v === 'messages') loadChat();
  if (v === 'dm') dmHome();
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
  state = { u, bots: o.bots };
  wizardUpdate(o.bots);
  const unread = o.dmUnread || 0;
  $('dmBadge').textContent = unread;
  $('dmBadge').classList.toggle('off', !unread);
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
let state = null;
const wiz = { id: null, timer: null };
const step = n => {
  ['w1', 'w2', 'w3'].forEach((id, i) => $(id).classList.toggle('off', i + 1 !== n));
  ['s1', 's2', 's3'].forEach((id, i) => $(id).classList.toggle('on', i + 1 <= n));
};
function wizardUpdate(bots) {
  if (!wiz.id) return;
  const b = bots.find(x => x.id === wiz.id);
  if (!b) return;
  if (b.status === 'online') { step(3); clearInterval(wiz.timer); wiz.timer = null; }
  else if (b.pairingCode) { $('wcode').textContent = b.pairingCode; step(2); }
}
$('deployBtn').onclick = async () => {
  const btn = $('deployBtn'); btn.disabled = true;
  try {
    if (!state) throw new Error('Chargement en cours, réessaie.');
    const free = state.u.slots - state.bots.filter(b => b.status !== 'stopped').length;
    if (free < 1) {
      if (state.u.coins < cfg.slotPrice) throw new Error(`Il te faut un slot (${cfg.slotPrice} coins).`);
      if (!confirm(`Acheter un slot pour ${cfg.slotPrice} coins ?`)) return;
      await api('/slots/buy', 'POST');
    }
    const d = await api('/bots', 'POST', { phone: $('phone').value });
    wiz.id = d.bot.id;
    await api(`/bots/${wiz.id}/start`, 'POST');
    toast('Déploiement en cours…');
    $('wcode').textContent = '…'; step(2);
    clearInterval(wiz.timer);
    wiz.timer = setInterval(() => load().catch(() => {}), 2000);
    await load();
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; }
};
$('wdone').onclick = () => {
  wiz.id = null; $('phone').value = ''; step(1);
  $('addBox').classList.add('off'); load();
};
$('sendCoins').onclick = () => act(async () => {
  const d = await api('/coins/transfer', 'POST', { email: $('tmail').value, amount: $('tamount').value });
  $('tmail').value = ''; $('tamount').value = ''; $('transferBox').classList.add('off');
  return d;
});
$('logout').onclick = async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/'; };

// ---------- Messages ----------
const ROLE_LABEL = { owner: 'Propriétaire', admin: 'Admin' };
function renderChat(list) {
  const box = $('chatList');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const me = state && state.u;
  box.replaceChildren(...(list.length ? list.map(m => {
    const mine = me && m.userId === me.id;
    const canDel = me && me.role !== 'user' && (me.role === 'owner' || m.role === 'user');
    const meta = el('div', { class: 'cmeta' }, mine ? 'Moi' : m.name);
    if (ROLE_LABEL[m.role]) meta.append(el('span', { class: 'rl' }, ROLE_LABEL[m.role]));
    meta.append(el('span', { class: 't2' }, new Date(m.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })));
    if (canDel) meta.append(el('button', { class: 'del', type: 'button', 'aria-label': 'Supprimer le message', onclick: () => act(() => api(`/admin/messages/${m.id}`, 'DELETE')).then(loadChat) }, '✕'));
    return el('div', { class: 'cm' + (mine ? ' me' : '') }, meta, el('p', {}, m.text));
  }) : [el('p', { class: 'mut' }, 'Aucun message pour le moment. Lance la discussion !')]));
  if (nearBottom) box.scrollTop = box.scrollHeight;
}
async function loadChat() {
  try { renderChat((await api('/messages')).messages); } catch {}
}
$('chatForm').onsubmit = async e => {
  e.preventDefault();
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;
  try { await api('/messages', 'POST', { text }); input.value = ''; await loadChat(); $('chatList').scrollTop = $('chatList').scrollHeight; }
  catch (err) { toast(err.message); }
};
setInterval(() => { if (currentView === 'messages') loadChat(); }, 4000);

// ---------- Messages privés ----------
const dm = { withId: null, members: [] };
const timeOf = ts => new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const dmShow = open => { $('dmHome').classList.toggle('off', open); $('dmThreadCard').classList.toggle('off', !open); };
function dmHome() { dm.withId = null; dmShow(false); $('dmPicker').classList.add('off'); loadConvs(); }

async function loadConvs() {
  try {
    const { conversations } = await api('/dm');
    $('dmConvs').replaceChildren(...(conversations.length ? conversations.map(c =>
      el('button', { class: 'conv', type: 'button', onclick: () => openThread(c.userId) },
        el('span', { class: 'cav' }, c.name.charAt(0).toUpperCase()),
        el('span', { class: 'cinfo' }, el('strong', {}, c.name), el('small', {}, (c.last.mine ? 'Toi : ' : '') + c.last.text)),
        c.unread ? el('span', { class: 'badge' }, String(c.unread)) : '')
    ) : [el('p', { class: 'mut', style: 'margin-top:12px' }, "Aucune discussion. Touche « Nouveau » pour écrire à quelqu'un.")]));
  } catch {}
}
function renderMembers() {
  const q = $('dmSearch').value.trim().toLowerCase();
  const list = dm.members.filter(m => m.name.toLowerCase().includes(q)).slice(0, 30);
  $('dmMembers').replaceChildren(...(list.length ? list.map(m =>
    el('button', { class: 'conv', type: 'button', onclick: () => openThread(m.id) },
      el('span', { class: 'cav' }, m.name.charAt(0).toUpperCase()),
      el('span', { class: 'cinfo' }, el('strong', {}, m.name), ROLE_LABEL[m.role] ? el('small', {}, ROLE_LABEL[m.role]) : ''))
  ) : [el('p', { class: 'mut', style: 'margin-top:12px' }, 'Aucun membre trouvé.')]));
}
async function openPicker() {
  const p = $('dmPicker');
  p.classList.toggle('off');
  if (p.classList.contains('off')) return;
  try { dm.members = (await api('/members')).members; } catch (e) { toast(e.message); }
  renderMembers();
  $('dmSearch').focus();
}
async function openThread(id) {
  dm.withId = id; dmShow(true); $('dmList').replaceChildren();
  await loadThread(true);
  $('dmInput').focus();
}
async function loadThread(scroll) {
  if (!dm.withId) return;
  try {
    const d = await api('/dm/' + dm.withId);
    $('dmWith').textContent = d.with.name;
    const box = $('dmList');
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.replaceChildren(...(d.messages.length ? d.messages.map(m =>
      el('div', { class: 'cm' + (m.mine ? ' me' : '') }, el('p', {}, m.text), el('div', { class: 'cmeta' }, el('span', { class: 't2' }, timeOf(m.at))))
    ) : [el('p', { class: 'mut' }, 'Aucun message. Dis bonjour !')]));
    if (scroll || near) box.scrollTop = box.scrollHeight;
  } catch (e) { if (/introuvable/i.test(e.message)) dmHome(); }
}
$('dmForm').onsubmit = async e => {
  e.preventDefault();
  const text = $('dmInput').value.trim();
  if (!text || !dm.withId) return;
  try { await api('/dm/' + dm.withId, 'POST', { text }); $('dmInput').value = ''; await loadThread(true); }
  catch (err) { toast(err.message); }
};
$('dmNew').onclick = openPicker;
$('dmSearch').oninput = renderMembers;
$('dmBack').onclick = dmHome;
$('dmBtn').onclick = () => show('dm');
setInterval(() => { if (currentView === 'dm') (dm.withId ? loadThread() : loadConvs()); }, 4000);

show('home');
load().catch(e => toast(e.message));
setInterval(() => load().catch(() => {}), 5000);
