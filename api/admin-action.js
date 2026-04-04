const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      type: "service_account",
      project_id: process.env.FIREBASE_PROJECT_ID || "yks-asistan-10a95",
      private_key: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, '\n'),
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
    })
  });
}

const BACKUP_SECRET = process.env.YKS_ADMIN_KEY || process.env.BACKUP_SECRET || 'yks-backup-2026';

// ── Yardımcılar ──────────────────────────────────────────────────────────────

function ok(res, data)  { return res.status(200).json({ success: true,  ...data }); }
function err(res, msg, code = 400) { return res.status(code).json({ success: false, error: msg }); }

// ── Aksiyonlar ───────────────────────────────────────────────────────────────

/**
 * KART BAN
 * global_cards/{cardId} → { hidden: true, bannedAt, bannedReason }
 * reports koleksiyonundaki ilgili kayıt → { status: 'resolved', resolvedAt }
 */
async function banCard(db, cardId, reason) {
  if (!cardId) throw new Error('cardId gerekli');

  const cardRef = db.collection('global_cards').doc(cardId);
  const cardSnap = await cardRef.get();
  if (!cardSnap.exists) throw new Error('Kart bulunamadı: ' + cardId);

  const now = admin.firestore.FieldValue.serverTimestamp();

  // Kartı gizle
  await cardRef.update({
    hidden:       true,
    bannedAt:     now,
    bannedReason: reason || 'Admin kararı',
  });

  // Bu karta ait tüm şikayetleri çözüldü işaretle
  const reportsSnap = await db.collection('reports')
    .where('cardId', '==', cardId)
    .get();

  const batch = db.batch();
  reportsSnap.forEach(d => {
    batch.update(d.ref, { status: 'resolved', resolvedAt: now });
  });
  await batch.commit();

  return {
    cardId,
    resolvedReports: reportsSnap.size,
    message: `Kart gizlendi, ${reportsSnap.size} şikayet çözüldü.`,
  };
}

/**
 * KART BAN KALDIR
 * global_cards/{cardId} → { hidden: false }
 */
async function unbanCard(db, cardId) {
  if (!cardId) throw new Error('cardId gerekli');

  const cardRef = db.collection('global_cards').doc(cardId);
  const cardSnap = await cardRef.get();
  if (!cardSnap.exists) throw new Error('Kart bulunamadı: ' + cardId);

  await cardRef.update({
    hidden:       false,
    bannedAt:     admin.firestore.FieldValue.delete(),
    bannedReason: admin.firestore.FieldValue.delete(),
  });

  return { cardId, message: 'Kart yasağı kaldırıldı.' };
}

/**
 * HESAP BAN (süreli veya kalıcı)
 * users/{userCode} → { banned: true, banUntil: timestamp | null, banReason }
 * Firebase Auth → disabled: true (kalıcı banlarda)
 */
async function banUser(db, userCode, durationHours, reason) {
  if (!userCode) throw new Error('userCode gerekli');

  // Firestore'da kullanıcıyı bul
  const usersRef = db.collection('users');
  const snap = await usersRef.where('code', '==', userCode).limit(1).get();
  if (snap.empty) throw new Error('Kullanıcı bulunamadı: ' + userCode);

  const userDoc = snap.docs[0];
  const userData = userDoc.data();
  const firebaseUid = userData.firebaseUid;

  const now = Date.now();
  const isPermanent = !durationHours || durationHours <= 0;
  const banUntil = isPermanent ? null : now + durationHours * 60 * 60 * 1000;

  // Firestore güncelle
  await userDoc.ref.update({
    banned:    true,
    banUntil:  banUntil,          // null = kalıcı
    banReason: reason || 'Admin kararı',
    bannedAt:  now,
  });

  // Firebase Auth'da da devre dışı bırak (kalıcı banlarda)
  if (firebaseUid) {
    try {
      await admin.auth().updateUser(firebaseUid, { disabled: true });
    } catch(e) {
      console.warn('[banUser] Auth update failed:', e.message);
    }
  }

  return {
    userCode,
    permanent: isPermanent,
    banUntil:  banUntil ? new Date(banUntil).toISOString() : 'Kalıcı',
    message: isPermanent
      ? `${userCode} kalıcı olarak banlandı.`
      : `${userCode} ${durationHours} saat banlandı.`,
  };
}

/**
 * HESAP BAN KALDIR
 */
async function unbanUser(db, userCode) {
  if (!userCode) throw new Error('userCode gerekli');

  const snap = await db.collection('users').where('code', '==', userCode).limit(1).get();
  if (snap.empty) throw new Error('Kullanıcı bulunamadı: ' + userCode);

  const userDoc = snap.docs[0];
  const firebaseUid = userDoc.data().firebaseUid;

  await userDoc.ref.update({
    banned:    false,
    banUntil:  admin.firestore.FieldValue.delete(),
    banReason: admin.firestore.FieldValue.delete(),
    bannedAt:  admin.firestore.FieldValue.delete(),
  });

  if (firebaseUid) {
    try {
      await admin.auth().updateUser(firebaseUid, { disabled: false });
    } catch(e) {
      console.warn('[unbanUser] Auth update failed:', e.message);
    }
  }

  return { userCode, message: `${userCode} yasağı kaldırıldı.` };
}

/**
 * HESAP SİL
 * - Firestore users dökümanı silinir
 * - Firebase Auth hesabı silinir
 * - Kullanıcının global_cards kartları gizlenir (silinmez, veri korunur)
 * - friends, push_tokens, tokenBalance temizlenir
 */
async function deleteUser(db, userCode) {
  if (!userCode) throw new Error('userCode gerekli');

  const snap = await db.collection('users').where('code', '==', userCode).limit(1).get();
  if (snap.empty) throw new Error('Kullanıcı bulunamadı: ' + userCode);

  const userDoc = snap.docs[0];
  const userData = userDoc.data();
  const firebaseUid = userData.firebaseUid;
  const batch = db.batch();

  // 1. users dökümanını sil
  batch.delete(userDoc.ref);

  // 2. tokenBalance sil
  const tokenRef = db.collection('tokenBalance').doc(firebaseUid || userCode);
  batch.delete(tokenRef);

  // 3. push_token sil
  const ptRef = db.collection('push_tokens').doc(userCode);
  batch.delete(ptRef);

  // 4. leaderboard sil
  const lbRef = db.collection('leaderboard').doc(userCode);
  batch.delete(lbRef);

  await batch.commit();

  // 5. Kullanıcının global kartlarını gizle (toplu)
  const cardsSnap = await db.collection('global_cards')
    .where('uploaderCode', '==', userCode)
    .get();

  if (!cardsSnap.empty) {
    const cardBatch = db.batch();
    cardsSnap.forEach(d => {
      cardBatch.update(d.ref, {
        hidden: true,
        bannedReason: 'Hesap silindi',
        bannedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    await cardBatch.commit();
  }

  // 6. Firebase Auth hesabını sil
  if (firebaseUid) {
    try {
      await admin.auth().deleteUser(firebaseUid);
    } catch(e) {
      console.warn('[deleteUser] Auth delete failed:', e.message);
    }
  }

  return {
    userCode,
    cardsHidden: cardsSnap.size,
    message: `${userCode} hesabı silindi, ${cardsSnap.size} kartı gizlendi.`,
  };
}

/**
 * ŞİKAYET ÇÖZÜLDÜ işaretle (kart banlamadan sadece raporu kapat)
 */
async function resolveReport(db, reportId) {
  if (!reportId) throw new Error('reportId gerekli');

  const ref = db.collection('reports').doc(reportId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Rapor bulunamadı');

  await ref.update({
    status: 'resolved',
    resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { reportId, message: 'Rapor çözüldü olarak işaretlendi.' };
}

// ── Ana Handler ───────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return err(res, 'Sadece POST kabul edilir', 405);

  // Secret kontrolü (header veya body)
  const secret = req.headers['x-admin-secret'] || req.body?.secret;
  if (secret !== BACKUP_SECRET) return err(res, 'Yetkisiz.', 401);

  const { action, cardId, userCode, durationHours, reason, reportId } = req.body || {};

  if (!action) return err(res, 'action gerekli');

  try {
    const db = admin.firestore();
    let result;

    switch (action) {
      case 'ban_card':      result = await banCard(db, cardId, reason);                break;
      case 'unban_card':    result = await unbanCard(db, cardId);                      break;
      case 'ban_user':      result = await banUser(db, userCode, durationHours, reason); break;
      case 'unban_user':    result = await unbanUser(db, userCode);                    break;
      case 'delete_user':   result = await deleteUser(db, userCode);                   break;
      case 'resolve_report':result = await resolveReport(db, reportId);               break;
      default: return err(res, 'Bilinmeyen action: ' + action);
    }

    // Log (Vercel logs'ta görünür)
    console.log(`[admin-action] ${action}`, { cardId, userCode, reason, result: result.message });

    return ok(res, result);

  } catch(e) {
    console.error('[admin-action] HATA:', e.message);
    return err(res, e.message, 500);
  }
};
