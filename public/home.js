// Compteurs de la page d'accueil (bots en ligne, bots créés, comptes)
fetch('/api/stats')
  .then(r => r.json())
  .then(d => {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('stOnline', d.online);
    set('stBots', d.bots);
    set('stUsers', d.users);
  })
  .catch(() => {});
