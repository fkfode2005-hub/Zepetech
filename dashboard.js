const el = s => document.querySelector(s);
let bots = [];
async function api(url, options = {}) {
  const r = await fetch(url, { ...options, headers: { 'Content-Type':'application/json', ...(options.headers || {}) } });
  const d = await r.json();
  if (r.status === 401) { location.href = '/'; throw new Error('Connecte-toi.'); }
  if (!r.ok) throw new Error(d.error || 'Erreur.');
  return d;
}
async function init() {
  const { user } = await api('/api/me');
  if (!user) { location.href = '/'; return; }
  el('#welcome').textContent = 'Salut, ' + user.name;
  await refresh();
}
async function refresh() {
  const data = await api('/api/bots'); bots = data.bots;
  const online = bots.filter(b => b.status === 'online').length;
  el('#overall').textContent = online ? '● ' + online + ' bot(s) en ligne' : '● Aucun bot en ligne';
  el('#botCount').textContent = String(bots.length);
  el('#onlineCount').textContent = String(online);
  renderBots();
}
function renderBots() {
  const root = el('#bots');
  if (!bots.length) { root.innerHTML = '<p class="small">Aucun bot pour le moment. Crée ton premier bot ci-dessus.</p>'; return; }
  root.replaceChildren();
  for (const bot of bots) {
    const card = document.createElement('article'); card.className = 'botcard';
    const head = document.createElement('div'); head.className = 'botcardhead';
    const name = document.createElement('strong'); name.textContent = bot.label + ' · +' + bot.phone;
    const status = document.createElement('span'); status.className = 'tag'; status.textContent = bot.status;
    head.append(name,status); card.append(head);
    const actions = document.createElement('div'); actions.className = 'botactions';
    const start = document.createElement('button'); start.className='primary'; start.textContent='Démarrer / obtenir le code';
    start.onclick = async () => { start.disabled=true; try { await api(`/api/bots/${bot.id}/start`,{method:'POST',body:'{}'}); await poll(bot.id, card); } catch(e) { alert(e.message); } finally { start.disabled=false; } };
    const stop = document.createElement('button'); stop.className='ghost'; stop.textContent='Arrêter';
    stop.onclick = async () => { try { await api(`/api/bots/${bot.id}/stop`,{method:'POST',body:'{}'}); await refresh(); } catch(e){alert(e.message);} };
    const stat = document.createElement('button'); stat.className='ghost'; stat.textContent='Actualiser le code'; stat.onclick=()=>poll(bot.id,card);
    actions.append(start,stat,stop); card.append(actions);
    const code = document.createElement('div'); code.className='paircode'; code.setAttribute('aria-live','polite'); card.append(code);
    const instructions = document.createElement('p'); instructions.className='small'; instructions.textContent='Sur ton téléphone : WhatsApp → Appareils connectés → Connecter un appareil → Connecter avec un numéro de téléphone.'; card.append(instructions);
    root.append(card);
  }
}
async function poll(id, card) {
  const codeEl = card.querySelector('.paircode');
  codeEl.textContent = 'Connexion…';
  for (let i=0;i<20;i++) {
    await new Promise(r=>setTimeout(r,1500));
    try {
      const d = await api(`/api/bots/${id}/status`);
      codeEl.textContent = d.pairingCode || (d.status==='online'?'Connecté ✓':d.status);
      if (d.pairingCode || ['online','stopped','logged_out','error','disconnected'].includes(d.status)) { await refresh(); return; }
    } catch(e) { codeEl.textContent = e.message; return; }
  }
  codeEl.textContent = 'Code non reçu. Vérifie le numéro et consulte les journaux serveur.';
}
el('#botForm').onsubmit = async e => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.currentTarget));
  try { await api('/api/bots',{method:'POST',body:JSON.stringify(data)}); e.currentTarget.reset(); e.currentTarget.elements.label.value='Mon bot'; await refresh(); }
  catch(err) { alert(err.message); }
};
el('#refresh').onclick = () => refresh().catch(e=>alert(e.message));
el('#logout').onclick = async () => { await api('/api/logout',{method:'POST',body:'{}'}); location.href='/'; };
init().catch(e=>{ if(e.message!=='Connecte-toi.') alert(e.message); });
