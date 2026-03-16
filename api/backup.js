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

const BACKUP_SECRET = process.env.BACKUP_SECRET || 'yks-backup-2026';
const COLLECTIONS   = ['users', 'chats', 'friends', 'groups', 'inbox', 'leaderboard', 'ai_sessions'];

function serializeDoc(doc) {
  const data = doc.data() || {};
  const clean = {};
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && v.toDate) {
      clean[k] = v.toDate().toISOString();
    } else if (Array.isArray(v)) {
      clean[k] = v.map(item => (item && item.toDate) ? item.toDate().toISOString() : item);
    } else {
      clean[k] = v;
    }
  }
  return { _id: doc.id, ...clean };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.query.secret !== BACKUP_SECRET) {
    return res.status(401).json({ error: 'Yetkisiz.' });
  }

  try {
    const db = admin.firestore();
    const backup = {
      exportedAt: new Date().toISOString(),
      projectId: process.env.FIREBASE_PROJECT_ID || 'yks-asistan-10a95',
      collections: {}
    };

    let totalDocs = 0;

    for (const colName of COLLECTIONS) {
      backup.collections[colName] = {};
      const snapshot = await db.collection(colName).get();

      for (const doc of snapshot.docs) {
        const entry = serializeDoc(doc);

        if (colName === 'chats') {
          try {
            const msgSnap = await doc.ref.collection('messages').get();
            entry._messages = {};
            for (const msgDoc of msgSnap.docs) {
              entry._messages[msgDoc.id] = serializeDoc(msgDoc);
            }
            totalDocs += msgSnap.size;
          } catch(e) {
            entry._messages = {};
          }
        }

        backup.collections[colName][doc.id] = entry;
        totalDocs++;
      }
    }

    const json     = JSON.stringify(backup, null, 2);
    const dateStr  = new Date().toISOString().slice(0, 10);
    const fileName = `yks-backup-${dateStr}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('X-Total-Docs', String(totalDocs));
    return res.status(200).send(json);

  } catch (e) {
    return res.status(500).json({ error: 'Yedekleme başarısız', detail: e.message });
  }
};
