// Service worker de Retro Football Wear: permite instalar la app y abrirla sin conexión.
const CACHE = 'rfw-v1';
const CORE = [
  './', 'index.html', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'fotos/camiseta-retro-plana.jpg', 'fotos/camiseta-retro-maniqui.jpg',
  'fotos/chaqueta-celeste-frente.jpg', 'fotos/chaqueta-celeste-completa.jpg', 'fotos/chaqueta-joluvi.jpg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || /paypal\.com/.test(req.url)) return;
  // Páginas: primero la red (para tener siempre la última versión) y, sin conexión, la copia guardada.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { caches.open(CACHE).then(c => c.put('index.html', r.clone())); return r; })
      .catch(() => caches.match('index.html')));
    return;
  }
  // Resto (estilos, fotos, iconos): copia guardada al instante y se actualiza en segundo plano.
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(r => { if (r.ok || r.type === 'opaque') caches.open(CACHE).then(c => c.put(req, r.clone())); return r; }).catch(() => hit);
    return hit || net;
  }));
});

// Al pulsar una notificación del sistema se abre (o enfoca) la app.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => 'focus' in c);
    return open ? open.focus() : self.clients.openWindow('./');
  }));
});
