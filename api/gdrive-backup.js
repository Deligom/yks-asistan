// api/gdrive-backup.js
// Google Drive'a kullanıcı başına yedek yaz / oku / listele
// Env vars: GDRIVE_CLIENT_EMAIL, GDRIVE_PRIVATE_KEY, GDRIVE_FOLDER_ID

const { google } = require('googleapis');

// ── Auth ──────────────────────────────────────────────────────────────────────
function getDriveClient() {
  const auth = new google.auth.JWT({
    email: process.env.GDRIVE_CLIENT_EMAIL,
    key: (process.env.GDRIVE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

// ── Kullanıcıya ait alt klasörü bul veya oluştur ──────────────────────────────
async function getOrCreateUserFolder(drive, uid) {
  const parentId = process.env.GDRIVE_FOLDER_ID;

  // Var mı bak
  const res = await drive.files.list({
    q: `'${parentId}' in parents and name='${uid}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive',
  });

  if (res.data.files.length > 0) return res.data.files[0].id;

  // Yoksa oluştur
  const created = await drive.files.create({
    requestBody: {
      name: uid,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });
  return created.data.id;
}

// ── Yardımcılar ───────────────────────────────────────────────────────────────
const { Readable } = require('stream');
function stringToStream(str) {
  const s = new Readable();
  s.push(str);
  s.push(null);
  return s;
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
    const drive = getDriveClient();

    // ── POST /api/gdrive-backup  { action:'save', uid, date, data } ──────────
    if (req.method === 'POST' && action === 'save') {
      const { date: d, data } = req.body;
      if (!d || !data) return res.status(400).json({ error: 'date ve data gerekli' });

      const folderId = await getOrCreateUserFolder(drive, uid);
      const fname    = `${d}.json`;   // örn: 2026-03-25.json

      // Aynı isimde dosya var mı? Varsa güncelle (üzerine yaz)
      const existing = await drive.files.list({
        q: `'${folderId}' in parents and name='${fname}' and trashed=false`,
        fields: 'files(id)',
      });

      const json = JSON.stringify(data);

      if (existing.data.files.length > 0) {
        // Güncelle
        await drive.files.update({
          fileId: existing.data.files[0].id,
          media: { mimeType: 'application/json', body: stringToStream(json) },
        });
      } else {
        // Yeni oluştur
        await drive.files.create({
          requestBody: {
            name: fname,
            mimeType: 'application/json',
            parents: [folderId],
          },
          media: { mimeType: 'application/json', body: stringToStream(json) },
          fields: 'id',
        });
      }

      return res.status(200).json({ ok: true, date: d });
    }

    // ── GET /api/gdrive-backup?action=list&uid=... ────────────────────────────
    if (action === 'list') {
      const folderId = await getOrCreateUserFolder(drive, uid);
      const list = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'files(id,name,modifiedTime,size)',
        orderBy: 'name desc',
      });
      return res.status(200).json({ files: list.data.files });
    }

    // ── GET /api/gdrive-backup?action=load&uid=...&date=2026-03-25 ────────────
    if (action === 'load') {
      if (!date) return res.status(400).json({ error: 'date gerekli' });
      const folderId = await getOrCreateUserFolder(drive, uid);
      const fname    = `${date}.json`;

      const found = await drive.files.list({
        q: `'${folderId}' in parents and name='${fname}' and trashed=false`,
        fields: 'files(id)',
      });
      if (found.data.files.length === 0) return res.status(404).json({ error: 'Yedek bulunamadı' });

      const fileId = found.data.files[0].id;
      const content = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'text' }
      );

      res.setHeader('Content-Type', 'application/json');
      return res.status(200).send(content.data);
    }

    // ── GET /api/gdrive-backup?action=latest&uid=... ──────────────────────────
    // En son yedek dosyasını döndür (yeni cihazda otomatik geri yükleme için)
    if (action === 'latest') {
      const folderId = await getOrCreateUserFolder(drive, uid);
      const list = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'files(id,name,modifiedTime)',
        orderBy: 'name desc',
        pageSize: 1,
      });
      if (list.data.files.length === 0) return res.status(404).json({ error: 'Yedek yok' });

      const fileId = list.data.files[0].id;
      const fname  = list.data.files[0].name;  // 2026-03-25.json
      const content = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'text' }
      );

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Backup-Date', fname.replace('.json', ''));
      return res.status(200).send(content.data);
    }

    return res.status(400).json({ error: 'Geçersiz action' });

  } catch (e) {
    console.error('[gdrive-backup]', e);
    return res.status(500).json({ error: 'Drive işlemi başarısız', detail: e.message });
  }
};
