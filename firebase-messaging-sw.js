// ═══════════════════════════════════════════════════
//  YKS Asistan — Service Worker
//  1) Asset Caching  (index.html + ikonlar hızlı açılış)
//  2) Firebase Cloud Messaging  (push bildirimleri)
// ═══════════════════════════════════════════════════

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

// ── Cache adı: büyük güncelleme yapınca v2, v3... yap ──
const CACHE_NAME = 'yks-cache-v1';

const PRECACHE_URLS = [
  '/yks-asistan/',
  '/yks-asistan/index.html',
  '/yks-asistan/manifest.json',
  '/yks-asistan/icon-192.png',
  '/yks-asistan/icon-512.png',
];

// ── INSTALL: dosyaları indir ve sakla ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE_URLS).catch(err => {
        console.warn('[SW] Precache kısmen başarısız:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: eski cache'leri temizle ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: önce cache'e bak ──
self.addEventListener('fetch', event => {
  const url = event.request.url;
  if (event.request.method !== 'GET') return;

  // Firebase API isteklerini cache'leme
  if (
    url.includes('firestore.googleapis.com') ||
    url.includes('identitytoolkit.googleapis.com') ||
    url.includes('securetoken.googleapis.com') ||
    url.includes('fcm.googleapis.com')
  ) return;

  // index.html: Cache-first + arka planda güncelle
  if (url.includes('/yks-asistan/index.html') || url.endsWith('/yks-asistan/')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(event.request);
        const fetchPromise = fetch(event.request).then(response => {
          if (response && response.status === 200) cache.put(event.request, response.clone());
          return response;
        }).catch(() => null);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Diğer yerel dosyalar (ikonlar, manifest): Cache-first
  if (url.includes('/yks-asistan/')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        return cached || fetch(event.request).then(response => {
          if (response && response.status === 200)
            caches.open(CACHE_NAME).then(c => c.put(event.request, response.clone()));
          return response;
        });
      })
    );
    return;
  }
});

// ═══════════════════════════════════════════════════
//  Firebase Cloud Messaging
// ═══════════════════════════════════════════════════

firebase.initializeApp({
  apiKey: "AIzaSyCiR2N88sbxK8-5L-5GJ4Z5kD0fFX562ns",
  authDomain: "yks-asistan-10a95.firebaseapp.com",
  projectId: "yks-asistan-10a95",
  messagingSenderId: "184667221267",
  appId: "1:184667221267:web:05f9168c38e517e3857ee6"
});

const messaging = firebase.messaging();

// Bildirime tıklanınca uygulamayı aç (orijinalden değişmedi)
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'close') return;
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
