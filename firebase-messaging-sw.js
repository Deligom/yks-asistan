importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCiR2N88sbxK8-5L-5GJ4Z5kD0fFX562ns",
  authDomain: "yks-asistan-10a95.firebaseapp.com",
  projectId: "yks-asistan-10a95",
  messagingSenderId: "184667221267",
  appId: "1:184667221267:web:05f9168c38e517e3857ee6"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  console.log('[SW] Arka plan mesajı:', payload);
  const { title, body, icon } = payload.notification || {};
  self.registration.showNotification(title || 'YKS Asistan', {
    body: body || 'Yeni bir bildirim var',
    icon: icon || '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    data: payload.data || {},
    actions: [
      { action: 'open', title: 'Aç' },
      { action: 'close', title: 'Kapat' }
    ]
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'close') return;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});
