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

function serialize(doc) {
  const data = doc.data() || {};
  const clean = {};
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && typeof v.toDate === 'function') {
      clean[k] = v.toDate().toISOString();
    } else if (Array.isArray(v)) {
      clean[k] = v.map(i => (i && typeof i.toDate === 'function') ? i.toDate().toISOString() : i);
    } else {
      clean[k] = v;
    }
  }
  return { _id: doc.id, ...clean };
}

// Basit koleksiyon — tüm dokümanları çek
async function fetchFlat(db, colName) {
  const result = {};
  const snap = await db.collection(colName).get();
  snap.forEach(d => { result[d.id] = serialize(d); });
  return result;
}

// Üst doküman YOK ama subcollection var (chats/{id}/messages)
async function fetchChats(db) {
  const result = {};
  const snap = await db.collectionGroup('messages').get();

  snap.forEach(d => {
    const pathParts = d.ref.path.split('/');
    if (pathParts[0] !== 'chats') return;

    const chatId = pathParts[1];
    if (!result[chatId]) {
      result[chatId] = { _id: chatId, _messages: {} };
    }
    result[chatId]._messages[d.id] = serialize(d);
  });

  return result;
}

// groups/{groupId}/messages subcollection
async function fetchGroups(db) {
  const result = {};
  const snap = await db.collection('groups').get();

  await Promise.all(snap.docs.map(async d => {
    const entry = serialize(d);
    const msgSnap = await d.ref.collection('messages').get();
    entry._messages = {};
    msgSnap.forEach(m => { entry._messages[m.id] = serialize(m); });
    result[d.id] = entry;
  }));

  return result;
}

// inbox/{userCode}/items subcollection
async function fetchInbox(db) {
  const result = {};
  const snap = await db.collectionGroup('items').get();

  snap.forEach(d => {
    const pathParts = d.ref.path.split('/');
    if (pathParts[0] !== 'inbox') return;

    const userCode = pathParts[1];
    if (!result[userCode]) {
      result[userCode] = { _id: userCode, _items: {} };
    }
    result[userCode]._items[d.id] = serialize(d);
  });

  return result;
}

// ai_sessions/{userCode}/sessions/{sessionId} subcollection
async function fetchAiSessions(db) {
  const result = {};
  const snap = await db.collectionGroup('sessions').get();

  snap.forEach(d => {
    const pathParts = d.ref.path.split('/');
    if (pathParts[0] !== 'ai_sessions') return;

    const userCode = pathParts[1];
    if (!result[userCode]) {
      result[userCode] = { _id: userCode, _sessions: {} };
    }
    result[userCode]._sessions[d.id] = serialize(d);
  });

  return result;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.query.secret !== BACKUP_SECRET) {
    return res.status(401).json({ error: 'Yetkisiz.' });
  }

  try {
    const db = admin.firestore();

    const [
      users,
      chats,
      friends,
      groups,
      inbox,
      leaderboard,
      push_tokens,
      ai_sessions,
      // --- YENİ KOLEKSİYONLAR ---
      reports,
      global_cards,
      blocks,
      friend_requests,
      tokenBalance,
      user_report_stats,
    ] = await Promise.all([
      fetchFlat(db, 'users'),
      fetchChats(db),
      fetchFlat(db, 'friends'),
      fetchGroups(db),
      fetchInbox(db),
      fetchFlat(db, 'leaderboard'),
      fetchFlat(db, 'push_tokens'),
      fetchAiSessions(db),
      // --- YENİ ---
      fetchFlat(db, 'reports'),
      fetchFlat(db, 'global_cards'),
      fetchFlat(db, 'blocks'),
      fetchFlat(db, 'friend_requests'),
      fetchFlat(db, 'tokenBalance'),
      fetchFlat(db, 'user_report_stats'),
    ]);

    const backup = {
      exportedAt: new Date().toISOString(),
      projectId: process.env.FIREBASE_PROJECT_ID || 'yks-asistan-10a95',
      collections: {
        users,
        chats,
        friends,
        groups,
        inbox,
        leaderboard,
        push_tokens,
        ai_sessions,
        // --- YENİ ---
        reports,
        global_cards,
        blocks,
        friend_requests,
        tokenBalance,
        user_report_stats,
      }
    };

    const json    = JSON.stringify(backup, null, 2);
    const dateStr = new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="yks-backup-${dateStr}.json"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(json);

  } catch (e) {
    console.error('[backup]', e);
    return res.status(500).json({ error: 'Yedekleme başarısız', detail: e.message });
  }
};
