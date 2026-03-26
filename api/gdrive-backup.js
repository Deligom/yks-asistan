// api/gdrive-backup.js
// Google Drive'a kullanıcı başına yedek yaz / oku / listele
// Env vars: GDRIVE_CLIENT_EMAIL, GDRIVE_PRIVATE_KEY, GDRIVE_FOLDER_ID
// NOT: googleapis paketi KULLANILMIYOR — saf fetch + built-in crypto ile Drive REST API

// ── JWT ile service-account access token al ───────────────────────────────────
async function getAccessToken() {
  const email  = process.env.GDRIVE_CLIENT_EMAIL;
  const rawKey = (process.env.GDRIVE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const now  = Math.floor(Date.now() / 1000);

  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss  : email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud  : 'https://oauth2.googleapis.com/token',
    iat  : now,
    exp  : now + 3600,
  };

  const signingInput = `${b64(header)}.${b64(payload)}`;

  const crypto    = require('crypto');
  const sign      = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(rawKey, 'base64url');

  const jwt = `${signingInput}.${signature}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method : 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body   : new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion : jwt,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error('Token alınamadı: ' + err);
  }
  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}

// ── Kullanıcıya ait alt klasörü bul veya oluştur ──────────────────────────────
async function getOrCreateUserFolder(token, uid) {
  const parentId = process.env.GDRIVE_FOLDER_ID;

  const q      = `'${parentId}' in parents and name='${uid}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const listRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const listData = await listRes.json();

  if (listData.files && listData.files.length > 0) return listData.files[0].id;

  // Klasör oluştur
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body   : JSON.stringify({
      name    : uid,
      mimeType: 'application/vnd.google-apps.folder',
      parents : [parentId],
    }),
  });
  const createData = await createRes.json();
  return createData.id;
}

// ── Dosya yükle: yeni oluştur (multipart) VEYA üzerine yaz (simple media) ─────
async function driveUpload(token, { folderId, fileName, mimeType, content, existingFileId }) {

  // Mevcut dosyayı güncelle → simple media upload (PATCH)
  // Multipart PATCH, Drive API'de 405 döndürebiliyor; simple media güvenli.
  if (existingFileId) {
    const upRes = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=media`,
      {
        method : 'PATCH',
        headers: {
          Authorization : `Bearer ${token}`,
          'Content-Type': mimeType,
        },
        body: content,
      }
    );
    if (!upRes.ok) {
      const err = await upRes.text();
      throw new Error(`Drive upload hatası (${upRes.status}): ${err}`);
    }
    return upRes.json();
  }

  // Yeni dosya oluştur → multipart upload (POST)
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
      method : 'POST',
      headers: {
        Authorization : `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary="${boundary}"`,
      },
      body,
    }
  );

  if (!upRes.ok) {
    const err = await upRes.text();
    throw new Error(`Drive upload hatası (${upRes.status}): ${err}`);
  }
  return upRes.json();
}

// ── Dosya listele ─────────────────────────────────────────────────────────────
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

// ── Dosya içeriğini indir ─────────────────────────────────────────────────────
async function downloadFile(token, fileId) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Drive download hatası (${res.status})`);
  return res.text();
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, uid, date } = req.method === 'POST'
    ? (req.body || {})
    : req.query;

  if (!uid) return res.status(400).json({ error: 'uid gerekli' });

  try {
    const token = await getAccessToken();

    // ── POST { action:'save', uid, date, data } ──────────────────────────────
    if (req.method === 'POST' && action === 'save') {
      const { date: d, data } = req.body;
      if (!d || !data) return res.status(400).json({ error: 'date ve data gerekli' });

      const folderId       = await getOrCreateUserFolder(token, uid);
      const fname          = `${d}.json`;
      const json           = JSON.stringify(data);
      const existing       = await listFiles(token, folderId, fname);
      const existingFileId = existing.length > 0 ? existing[0].id : null;

      await driveUpload(token, { folderId, fileName: fname, mimeType: 'application/json', content: json, existingFileId });

      return res.status(200).json({ ok: true, date: d });
    }

    // ── GET ?action=list ─────────────────────────────────────────────────────
    if (action === 'list') {
      const folderId = await getOrCreateUserFolder(token, uid);
      const files    = await listFiles(token, folderId);
      return res.status(200).json({ files });
    }

    // ── GET ?action=load&date=2026-03-25 ─────────────────────────────────────
    if (action === 'load') {
      if (!date) return res.status(400).json({ error: 'date gerekli' });
      const folderId = await getOrCreateUserFolder(token, uid);
      const found    = await listFiles(token, folderId, `${date}.json`);
      if (found.length === 0) return res.status(404).json({ error: 'Yedek bulunamadı' });

      const content = await downloadFile(token, found[0].id);
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).send(content);
    }

    // ── GET ?action=latest ───────────────────────────────────────────────────
    if (action === 'latest') {
      const folderId = await getOrCreateUserFolder(token, uid);
      const files    = await listFiles(token, folderId);
      if (files.length === 0) return res.status(404).json({ error: 'Yedek yok' });

      const latest  = files[0]; // orderBy name desc → en yeni tarih üstte
      const content = await downloadFile(token, latest.id);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Backup-Date', latest.name.replace('.json', ''));
      return res.status(200).send(content);
    }

    return res.status(400).json({ error: 'Geçersiz action' });

  } catch (e) {
    console.error('[gdrive-backup]', e);
    return res.status(500).json({ error: 'Drive işlemi başarısız', detail: e.message });
  }
};
