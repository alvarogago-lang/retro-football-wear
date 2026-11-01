// La Prima Mery se ha mudado a https://laprimamery.github.io/.
// Este service worker sustituye al de la app antigua: borra la copia guardada y se da de baja,
// para que la dirección antigua cargue siempre la página que reenvía a la nueva.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
    .then(() => self.registration.unregister())
    .then(() => self.clients.matchAll({ type: 'window' }))
    .then((list) => list.forEach((c) => c.navigate(c.url))));
});
