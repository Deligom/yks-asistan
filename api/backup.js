// api/backup.js — YKS Asistan Firebase Tam Yedekleme
// Vercel Serverless Function
//
// Gerekli env değişkenleri (.env.local veya Vercel Dashboard > Settings > Environment Variables):
//   BACKUP_SECRET       → İndirme şifresi (örn. "YazdiginSifre")
//   FIREBASE_PROJECT_ID → Firebase proje ID'si (örn. "yks-asistan-10a95")
//   FIREBASE_CLIENT_EMAIL → Service account e-postası
//   FIREBASE_PRIVATE_KEY  → Service account private key (\n karakterleri korunmalı)
//
// Kullanım: https://yks-asistan.vercel.app/api/backup?secret=YazdiginSifre

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Firebase Admin'i bir kez başlat
function getDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // Vercel env'de \n string olarak gelir, gerçek newline'a çevir
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  return getFirestore();
}

// Tek bir koleksiyonu tamamen çek (pagination dahil)
async function fetchCollection(db, collectionPath) {
  const result = {};
  let lastDoc = null;

  while (true) {
    let query = db.collection(collectionPath).limit(500);
    if (lastDoc) query = query.startAfter(lastDoc);

    const snap = await query.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      result[doc.id] = { _id: doc.id, ...doc.data() };
    }

    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < 500) break;
  }

  return result;
}

// Bir koleksiyonun her dokümanının altındaki alt koleksiyonu çek
// Örn: chats/{chatId}/messages
async function fetchWithSubcollection(db, parentCollection, subCollectionName) {
  const result = {};
  let lastDoc = null;

  while (true) {
    let query = db.collection(parentCollection).limit(500);
    if (lastDoc) query = query.startAfter(lastDoc);

    const snap = await query.get();
    if (snap.empty) break;

    // Her doküman için alt koleksiyonu paralel çek
    await Promise.all(snap.docs.map(async (doc) => {
      const docData = { _id: doc.id, ...doc.data() };

      // Alt koleksiyonu çek
      const subSnap = await db
        .collection(parentCollection)
        .doc(doc.id)
        .collection(subCollectionName)
        .orderBy('createdAt', 'asc')
        .get();

      const subDocs = {};
      subSnap.forEach(sub => {
        subDocs[sub.id] = { _id: sub.id, ...sub.data() };
      });

      docData[`_${subCollectionName}`] = subDocs;
      result[doc.id] = docData;
    }));

    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < 500) break;
  }

  return result;
}

export default async function handler(req, res) {
  // Yalnızca GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Şifre kontrolü
  const { secret } = req.query;
  if (!secret || secret !== process.env.BACKUP_SECRET) {
    return res.status(401).json({ error: 'Yetkisiz erişim' });
  }

  try {
    const db = getDb();

    console.log('[backup] Başlatılıyor...');

    // Tüm koleksiyonları paralel çek
    const [users, chats, friends, groups, inbox, leaderboard, ai_sessions] = await Promise.all([
      fetchCollection(db, 'users'),
      fetchWithSubcollection(db, 'chats', 'messages'),   // ← Alt koleksiyon dahil
      fetchCollection(db, 'friends'),
      fetchWithSubcollection(db, 'groups', 'members'),   // ← Grup üyeleri dahil
      fetchCollection(db, 'inbox'),
      fetchCollection(db, 'leaderboard'),
      fetchCollection(db, 'ai_sessions'),
    ]);

    const backup = {
      exportedAt: new Date().toISOString(),
      projectId: process.env.FIREBASE_PROJECT_ID,
      collections: {
        users,
        chats,
        friends,
        groups,
        inbox,
        leaderboard,
        ai_sessions,
      },
    };

    const json = JSON.stringify(backup);
    const date = new Date().toISOString().slice(0, 10);
    const filename = `yks-backup-${date}.json`;

    console.log(`[backup] Tamamlandı. Boyut: ${(json.length / 1024).toFixed(1)} KB`);

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(json);

  } catch (err) {
    console.error('[backup] Hata:', err);
    return res.status(500).json({
      error: 'Yedekleme başarısız',
      detail: err.message,
    });
  }
}
