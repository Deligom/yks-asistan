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
  // notification alanı yok, sadece data var — tek bildirim biz gösteriyoruz
  const title = payload.data?.title || 'YKS Asistan';
  const body = payload.data?.body || 'Yeni mesajın var';

  self.registration.showNotification(title, {
    body,
    icon: 'https://deligom.github.io/yks-asistan/icon-192.png',
    badge: 'https://deligom.github.io/yks-asistan/icon-192.png',
    vibrate: [200, 100, 200],
    tag: 'yks-msg',
    renotify: true
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes('deligom.github.io') && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('https://deligom.github.io/yks-asistan/');
      }
    })
  );
});
