const CACHE = 'eth-v3';

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first só para GET do próprio app; APIs externas e POST passam direto
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req))
  );
});

self.addEventListener('push', e => {
  // Sempre exibe algo: push sem notificação faz o navegador mostrar aviso genérico
  // e, repetido, pode revogar a subscription
  let d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch { d = { body: e.data ? e.data.text() : '' }; }

  const title = d.title || 'ETH Monitor';
  e.waitUntil(Promise.all([
    self.registration.showNotification(title, {
      body: d.body || '',
      vibrate: [200, 100, 200],
      tag: d.tag || 'eth-alert',
      renotify: true,
      data: d
    }),
    // Avisa o app (se aberto) para marcar o alerta como disparado
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(list => list.forEach(c => c.postMessage({ type: 'triggered', ...d })))
  ]));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow(self.registration.scope);
    })
  );
});
