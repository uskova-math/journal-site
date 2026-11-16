// Service worker журнала: только показывает уведомления. Страницы не кэширует.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (err) { m = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(m.title || 'Журнал', {
    body: m.body || '',
    icon: '/static/icon-192.png',
    badge: '/static/icon-192.png',
    tag: m.tag || undefined,
    renotify: !!m.tag,
    data: { url: m.url || '/t/' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/t/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.indexOf('/t/') >= 0 && 'focus' in c) { c.postMessage({ type: 'refresh' }); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
