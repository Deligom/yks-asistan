// api/gdrive-backup.js
// Google Drive'a kullanıcı başına yedek yaz / oku / listele
// Env vars: GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, GDRIVE_REFRESH_TOKEN, GDRIVE_FOLDER_ID

async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method : 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body   : new URLSearchParams({
      client_id    : process.env.GDRIVE_CLIENT_ID,
      client_secret: process.env.GDRIVE_CLIENT_SECRET,
      refresh_token: process.env.GDRIVE_REFRESH_TOKEN,
      grant_type   : 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error('Token alınamadı: ' + await res.text());
  const data = await res.json();
  return data.access_token;
}

async function getOrCreateUserFolder(token, uid) {
  const parentId = process.env.GDRIVE_FOLDER_ID || 'root';
  const q = `'${parentId}' in parents and name='${uid}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;

  const listRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!listRes.ok) throw new Error(`Klasör arama hatası (${listRes.status}): ${await listRes.text()}`);
  const listData = await listRes.json();
  if (listData.files && listData.files.length > 0) return listData.files[0].id;

  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body   : JSON.stringify({ name: uid, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  });
  if (!createRes.ok) throw new Error(`Klasör oluşturma hatası (${createRes.status}): ${await createRes.text()}`);
  const createData = await createRes.json();
  if (!createData.id) throw new Error('Klasör ID alınamadı: ' + JSON.stringify(createData));
  return createData.id;
}

async function driveMultipartUpload(token, { folderId, fileName, mimeType, content, existingFileId }) {
  const boundary = 'BOUNDARY_YKS_BACKUP_2026';
  const metadata = existingFileId ? '{}' : JSON.stringify({ name: fileName, mimeType, parents: [folderId] });

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

  const url    = existingFileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
  const method = existingFileId ? 'PATCH' : 'POST';

  const upRes = await fetch(url, {
    method,
    headers: {
      Authorization : `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary="${boundary}"`,
    },
    body,
  });
  if (!upRes.ok) throw new Error(`Drive upload hatası (${upRes.status}): ${await upRes.text()}`);
  return upRes.json();
}

async function listFiles(token, folderId, fileName = null) {
  let q = `'${folderId}' in parents and trashed=false`;
  if (fileName) q += ` and name='${fileName}'`;
  const res  = await fetch(
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'X-Backup-Date');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Vercel req.body'yi otomatik parse eder — stream okumaya gerek yok
  const body = req.method === 'POST' ? (req.body || {}) : {};
  const { action, uid, date } = req.method === 'POST' ? body : req.query;

  if (!uid) return res.status(400).json({ error: 'uid gerekli' });

  try {
    const token = await getAccessToken();

    // ── POST { action:'save', uid, date, data } ──────────────────────────────
    if (req.method === 'POST' && action === 'save') {
      const { date: d, data } = body;
      if (!d || !data) return res.status(400).json({ error: 'date ve data gerekli' });

      const folderId       = await getOrCreateUserFolder(token, uid);
      const fname          = `${d}.json`;
      const json           = JSON.stringify(data);
      const existing       = await listFiles(token, folderId, fname);
      const existingFileId = existing.length > 0 ? existing[0].id : null;

      await driveMultipartUpload(token, { folderId, fileName: fname, mimeType: 'application/json', content: json, existingFileId });
      return res.status(200).json({ ok: true, date: d, filename: fname });
    }

    // ── GET ?action=list ─────────────────────────────────────────────────────
    if (action === 'list') {
      const folderId = await getOrCreateUserFolder(token, uid);
      const files    = await listFiles(token, folderId);
      return res.status(200).json({ files });
    }

    // ── GET ?action=load ─────────────────────────────────────────────────────
    if (action === 'load') {
      const { filename } = req.query;
      const fname = filename || (date ? `${date}.json` : null);
      if (!fname) return res.status(400).json({ error: 'filename veya date gerekli' });
      const folderId = await getOrCreateUserFolder(token, uid);
      const found    = await listFiles(token, folderId, fname.endsWith('.json') ? fname : fname + '.json');
      if (found.length === 0) return res.status(404).json({ error: 'Yedek bulunamadı' });
      const content = await downloadFile(token, found[0].id);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Backup-Filename', found[0].name);
      return res.status(200).send(content);
    }

    // ── GET ?action=latest ───────────────────────────────────────────────────
    if (action === 'latest') {
      const folderId = await getOrCreateUserFolder(token, uid);
      const files    = await listFiles(token, folderId);
      if (files.length === 0) return res.status(404).json({ error: 'Yedek yok' });
      const latest  = files[0];
      const content = await downloadFile(token, latest.id);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Backup-Date', latest.name.replace('.json', ''));
      return res.status(200).send(content);
    }

    return res.status(400).json({ error: 'Geçersiz action' });

  } catch (e) {
    console.error('[gdrive-backup] ERROR:', e.message);
    return res.status(500).json({ error: 'Drive işlemi başarısız', detail: e.message });
  }
}
