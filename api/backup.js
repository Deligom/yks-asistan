const { GoogleAuth } = require('google-auth-library');

const SERVICE_ACCOUNT = {
  type: "service_account",
  project_id: "yks-asistan-10a95",
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  token_uri: "https://oauth2.googleapis.com/token"
};

const BACKUP_SECRET = process.env.BACKUP_SECRET || 'yks-backup-2026';

const COLLECTIONS = ['users', 'chats', 'friends', 'groups', 'inbox', 'leaderboard', 'ai_sessions'];

async function firestoreRequest(auth, path, method = 'GET', body = null) {
  const client = await auth.getClient();
  const token  = await client.getAccessToken();
  const url    = `https://firestore.googleapis.com/v1/projects/${SERVICE_ACCOUNT.project_id}/databases/(default)/documents${path}`;
  const res    = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token.token}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : null
  });
  return res.json();
}

function parseValue(val) {
  if (!val) return null;
  if (val.stringValue  !== undefined) return val.stringValue;
  if (val.integerValue !== undefined) return parseInt(val.integerValue);
  if (val.doubleValue  !== undefined) return parseFloat(val.doubleValue);
  if (val.booleanValue !== undefined) return val.booleanValue;
  if (val.nullValue    !== undefined) return null;
  if (val.timestampValue !== undefined) return val.timestampValue;
  if (val.arrayValue   !== undefined) return (val.arrayValue.values || []).map(parseValue);
  if (val.mapValue     !== undefined) return parseFields(val.mapValue.fields || {});
  return val;
}

function parseFields(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields)) obj[k] = parseValue(v);
  return obj;
}

async function getCollection(auth, colName) {
  const data = {};
  let pageToken = null;
  do {
    const path = `/${colName}` + (pageToken ? `?pageToken=${pageToken}` : '');
    const res  = await firestoreRequest(auth, path);
    for (const doc of (res.documents || [])) {
      const id    = doc.name.split('/').pop();
      const entry = parseFields(doc.fields || {});
      entry._id   = id;
      // chats altındaki messages alt-koleksiyonunu da çek
      if (colName === 'chats') {
        const subRes = await firestoreRequest(auth, `/chats/${id}/messages`);
        entry._messages = {};
        for (const sub of (subRes.documents || [])) {
          const sid = sub.name.split('/').pop();
          entry._messages[sid] = { _id: sid, ...parseFields(sub.fields || {}) };
        }
      }
      data[id] = entry;
    }
    pageToken = res.nextPageToken || null;
  } while (pageToken);
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Güvenlik: secret key kontrolü
  const secret = req.query.secret;
  if (!secret || secret !== BACKUP_SECRET) {
    return res.status(401).json({ error: 'Yetkisiz erişim. ?secret=... parametresi gerekli.' });
  }

  try {
    const auth = new GoogleAuth({
      credentials: SERVICE_ACCOUNT,
      scopes: ['https://www.googleapis.com/auth/datastore']
    });

    const backup = {
      exportedAt: new Date().toISOString(),
      projectId: SERVICE_ACCOUNT.project_id,
      collections: {}
    };

    let totalDocs = 0;
    for (const col of COLLECTIONS) {
      backup.collections[col] = await getCollection(auth, col);
      totalDocs += Object.keys(backup.collections[col]).length;
    }

    const json     = JSON.stringify(backup, null, 2);
    const dateStr  = new Date().toISOString().slice(0, 10);
    const fileName = `yks-backup-${dateStr}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('X-Total-Docs', totalDocs);
    return res.status(200).send(json);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
