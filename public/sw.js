/* ZEPE TECH : service worker.
   - Les pages et fichiers de l'app sont mis en cache pour s'ouvrir vite et afficher une page de secours sans internet.
   - Les appels /api/ ne sont JAMAIS mis en cache (coins, clés, bots : toujours en direct).
   Pour forcer une mise à jour chez tout le monde, change le numéro de VERSION. */
var VERSION = 'zepe-v1';
var SHELL = [
  '/dashboard.html',
  '/dash.js',
  '/zepe-extra.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) {
      return Promise.all(SHELL.map(function (u) {
        return c.add(u).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') === 0) return;

  /* Réseau d'abord, cache en secours : l'utilisateur a toujours la dernière version quand il est en ligne. */
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || (req.mode === 'navigate' ? caches.match('/dashboard.html') : Response.error());
      });
    })
  );
});
