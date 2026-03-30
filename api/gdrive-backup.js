// api/gdrive-backup.js
// Google Drive yedekleme - 405 hatası kesin çözüldü (temiz versiyon)

async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GDRIVE_CLIENT_ID,
      client_secret: process.env.GDRIVE_CLIENT_SECRET,
      refresh_token: process.env.GDRIVE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error('Token alınamadı: ' + await res.text());
  const data = await res.json();
  return data.access_token;
}

async function getOrCreateUserFolder(token, uid) {
  const parentId = process.env.GDRIVE_FOLDER_ID || 'root';

  const q = `'\( {parentId}' in parents and name=' \){uid}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;

  const listRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!listRes.ok) throw new Error(`Klasör arama hatası: ${await listRes.text()}`);
  const listData = await listRes.json();
  if (listData.files?.length > 0) return listData.files[0].id;

  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: uid,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
  });

  if (!createRes.ok) throw new Error(`Klasör oluşturma hatası: ${await createRes.text()}`);
  const createData = await createRes.json();
  return createData.id;
}

async function driveMultipartUpload(token, { folderId, fileName, mimeType, content }) {
  const boundary = 'BOUNDARY_YKS_BACKUP_2026';
  const metadata = JSON.stringify({ name: fileName, mimeType, parents: [folderId] });

  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    metadata,
    `--${boundary}`,
    `Content-Type: ${mimeType}`,
    '',
    content,
    `--${boundary}--`,
  ].join('\r\n');

  const upRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary="${boundary}"`,
      },
      body,
    }
  );

  if (!upRes.ok) throw new Error(`Drive upload hatası (${upRes.status}): ${await upRes.text()}`);
  return upRes.json();
}

async function listFiles(token, folderId, fileName = null) {
  let q = `'${folderId}' in parents and trashed=false`;
  if (fileName) q += ` and name='${fileName}'`;

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime,size)&orderBy=name+desc`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.files || [];
}

async function downloadFile(token, fileId) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Drive download hatası (${res.status})`);
  return res.text();
}

// ── ANA HANDLER ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  let body = {};
  if (req.method === 'POST') {
    try {
      const raw = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(data));
        req.on('error', reject);
      });
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = req.body || {};
    }
  }

  const { action, uid, date } = req.method === 'POST' ? body : req.query;

  if (!uid) return res.status(400).json({ error: 'uid gerekli' });

  try {
    const token = await getAccessToken();

    if (req.method === 'POST' && action === 'save') {
      const { date: d, data } = body;
      if (!d || !data) return res.status(400).json({ error: 'date ve data gerekli' });

      const folderId = await getOrCreateUserFolder(token, uid);
      const fname = `${d}.json`;
      const json = JSON.stringify(data);

      const existing = await listFiles(token, folderId, fname);
      if (existing.length > 0) {
        await fetch(`https://www.googleapis.com/drive/v3/files/${existing[0].id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      }

      await driveMultipartUpload(token, {
        folderId,
        fileName: fname,
        mimeType: 'application/json',
        content: json,
      });

      return res.status(200).json({ ok: true, date: d, filename: fname });
    }

    if (action === 'list') {
      const folderId = await getOrCreateUserFolder(token, uid);
      const files = await listFiles(token, folderId);
      return res.status(200).json({ files });
    }

    if (action === 'load') {
      if (!date) return res.status(400).json({ error: 'date gerekli' });
      const folderId = await getOrCreateUserFolder(token, uid);
      const found = await listFiles(token, folderId, `${date}.json`);
      if (found.length === 0) return res.status(404).json({ error: 'Yedek bulunamadı' });

      const content = await downloadFile(token, found[0].id);
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).send(content);
    }

    return res.status(400).json({ error: 'Bilinmeyen action' });

  } catch (e) {
    console.error('[gdrive-backup]', e);
    return res.status(500).json({ error: e.message });
  }
};
