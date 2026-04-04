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

function ok(res, data) { return res.status(200).json({ success: true, ...data }); }
function err(res, msg, code = 400) { return res.status(code).json({ success: false, error: msg }); }

async function banCard(db, cardId, reason) {
  if (!cardId) throw new Error('cardId required');
  const cardRef = db.collection('global_cards').doc(cardId);
  const cardSnap = await cardRef.get();
  if (!cardSnap.exists) throw new Error('Card not found: ' + cardId);
  const now = admin.firestore.FieldValue.serverTimestamp();
  await cardRef.update({ hidden: true, bannedAt: now, bannedReason: reason || 'Admin decision' });
  const reportsSnap = await db.collection('reports').where('cardId', '==', cardId).get();
  const batch = db.batch();
  reportsSnap.forEach(d => { batch.update(d.ref, { status: 'resolved', resolvedAt: now }); });
  await batch.commit();
  return { cardId, resolvedReports: reportsSnap.size, message: 'Card hidden, ' + reportsSnap.size + ' reports resolved.' };
}

async function unbanCard(db, cardId) {
  if (!cardId) throw new Error('cardId required');
  const cardRef = db.collection('global_cards').doc(cardId);
  const cardSnap = await cardRef.get();
  if (!cardSnap.exists) throw new Error('Card not found: ' + cardId);
  await cardRef.update({ hidden: false, bannedAt: admin.firestore.FieldValue.delete(), bannedReason: admin.firestore.FieldValue.delete() });
  return { cardId, message: 'Card ban removed.' };
}

async function banUser(db, userCode, durationHours, reason) {
  if (!userCode) throw new Error('userCode required');
  const snap = await db.collection('users').where('code', '==', userCode).limit(1).get();
  if (snap.empty) throw new Error('User not found: ' + userCode);
  const userDoc = snap.docs[0];
  const firebaseUid = userDoc.data().firebaseUid;
  const now = Date.now();
  const isPermanent = !durationHours || durationHours <= 0;
  const banUntil = isPermanent ? null : now + durationHours * 60 * 60 * 1000;
  await userDoc.ref.update({ banned: true, banUntil: banUntil, banReason: reason || 'Admin decision', bannedAt: now });
  if (firebaseUid) {
    try { await admin.auth().updateUser(firebaseUid, { disabled: true }); } catch(e) {}
  }
  return { userCode, permanent: isPermanent, banUntil: banUntil ? new Date(banUntil).toISOString() : 'Permanent', message: userCode + (isPermanent ? ' permanently banned.' : ' banned for ' + durationHours + 'h.') };
}

async function unbanUser(db, userCode) {
  if (!userCode) throw new Error('userCode required');
  const snap = await db.collection('users').where('code', '==', userCode).limit(1).get();
  if (snap.empty) throw new Error('User not found: ' + userCode);
  const userDoc = snap.docs[0];
  const firebaseUid = userDoc.data().firebaseUid;
  await userDoc.ref.update({ banned: false, banUntil: admin.firestore.FieldValue.delete(), banReason: admin.firestore.FieldValue.delete(), bannedAt: admin.firestore.FieldValue.delete() });
  if (firebaseUid) {
    try { await admin.auth().updateUser(firebaseUid, { disabled: false }); } catch(e) {}
  }
  return { userCode, message: userCode + ' ban removed.' };
}

async function deleteUser(db, userCode) {
  if (!userCode) throw new Error('userCode required');
  const snap = await db.collection('users').where('code', '==', userCode).limit(1).get();
  if (snap.empty) throw new Error('User not found: ' + userCode);
  const userDoc = snap.docs[0];
  const userData = userDoc.data();
  const firebaseUid = userData.firebaseUid;
  const batch = db.batch();
  batch.delete(userDoc.ref);
  batch.delete(db.collection('tokenBalance').doc(firebaseUid || userCode));
  batch.delete(db.collection('push_tokens').doc(userCode));
  batch.delete(db.collection('leaderboard').doc(userCode));
  await batch.commit();
  const cardsSnap = await db.collection('global_cards').where('uploaderCode', '==', userCode).get();
  if (!cardsSnap.empty) {
    const cardBatch = db.batch();
    cardsSnap.forEach(d => { cardBatch.update(d.ref, { hidden: true, bannedReason: 'Account deleted', bannedAt: admin.firestore.FieldValue.serverTimestamp() }); });
    await cardBatch.commit();
  }
  if (firebaseUid) {
    try { await admin.auth().deleteUser(firebaseUid); } catch(e) {}
  }
  return { userCode, cardsHidden: cardsSnap.size, message: userCode + ' deleted, ' + cardsSnap.size + ' cards hidden.' };
}

async function setTokens(db, userCode, amount) {
  if (!userCode) throw new Error('userCode required');
  if (typeof amount !== 'number' || amount < 0) throw new Error('Invalid amount');
  const snap = await db.collection('users').where('code', '==', userCode).limit(1).get();
  if (snap.empty) throw new Error('User not found: ' + userCode);
  const firebaseUid = snap.docs[0].data().firebaseUid;
  const docId = firebaseUid || userCode;
  await db.collection('tokenBalance').doc(docId).set({ tokens: amount, updatedAt: Date.now() }, { merge: true });
  return { userCode, amount, message: userCode + ' token balance set to ' + amount + '.' };
}

async function resolveReport(db, reportId) {
  if (!reportId) throw new Error('reportId required');
  const ref = db.collection('reports').doc(reportId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Report not found');
  await ref.update({ status: 'resolved', resolvedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { reportId, message: 'Report marked as resolved.' };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return err(res, 'POST only', 405);
  const secret = req.headers['x-admin-secret'] || req.body?.secret;
  if (secret !== BACKUP_SECRET) return err(res, 'Unauthorized.', 401);
  const { action, cardId, userCode, durationHours, reason, reportId } = req.body || {};
  if (!action) return err(res, 'action required');
  try {
    const db = admin.firestore();
    let result;
    switch (action) {
      case 'ban_card':       result = await banCard(db, cardId, reason); break;
      case 'unban_card':     result = await unbanCard(db, cardId); break;
      case 'ban_user':       result = await banUser(db, userCode, durationHours, reason); break;
      case 'unban_user':     result = await unbanUser(db, userCode); break;
      case 'delete_user':    result = await deleteUser(db, userCode); break;
      case 'resolve_report': result = await resolveReport(db, reportId); break;
      case 'set_tokens':     result = await setTokens(db, userCode, Number(req.body.amount)); break;
      default: return err(res, 'Unknown action: ' + action);
    }
    console.log('[admin-action]', action, { cardId, userCode, result: result.message });
    return ok(res, result);
  } catch(e) {
    console.error('[admin-action] ERROR:', e.message);
    return err(res, e.message, 500);
  }
};
