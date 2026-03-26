// api/gdrive-backup.js
// Google Drive'a kullanıcı başına yedek yaz / oku / listele
// Env vars: GDRIVE_CLIENT_EMAIL, GDRIVE_PRIVATE_KEY, GDRIVE_FOLDER_ID

const LOG = (...args) => console.log('[GDrive]', ...args);
const ERR = (...args) => console.error('[GDrive][HATA]', ...args);

// ── JWT ile service-account access token al ───────────────────────────────────
async function getAccessToken() {
  LOG('🔑 [1/5] Access token alınıyor...');

  const email  = process.env.GDRIVE_CLIENT_EMAIL;
  const rawKey = (process.env.GDRIVE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!email) {
    ERR('❌ [1/5] GDRIVE_CLIENT_EMAIL env değişkeni eksik!');
    throw new Error('GDRIVE_CLIENT_EMAIL tanımlı değil');
  }
  if (!rawKey || rawKey.length < 100) {
    ERR('❌ [1/5] GDRIVE_PRIVATE_KEY env değişkeni eksik veya çok kısa! (uzunluk:', rawKey.length, ')');
    throw new Error('GDRIVE_PRIVATE_KEY tanımlı değil veya hatalı');
  }
  if (!rawKey.includes('-----BEGIN')) {
    ERR('❌ [1/5] GDRIVE_PRIVATE_KEY PEM formatında değil! \\n satırları düzgün çözümlenmemiş olabilir.');
    throw new Error('GDRIVE_PRIVATE_KEY PEM formatı geçersiz');
  }

  LOG('✅ [1/5] Env değişkenleri mevcut. email:', email.slice(0, 20) + '...');

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

  let signature;
  try {
    const crypto = require('crypto');
    const sign   = crypto.createSign('RSA-SHA256');
    sign.update(signingInput);
    signature = sign.sign(rawKey, 'base64url');
    LOG('✅ [1/5] JWT imzalandı.');
  } catch (e) {
    ERR('❌ [1/5] JWT imzalama başarısız! Private key formatı hatalı olabilir:', e.message);
    throw new Error('JWT imzalama hatası: ' + e.message);
  }

  const jwt = `${signingInput}.${signature}`;

  LOG('🌐 [1/5] Google OAuth token endpoint çağrılıyor...');
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
    ERR(`❌ [1/5] OAuth token alınamadı! HTTP ${tokenRes.status}. Cevap:`, err);
    throw new Error(`Token alınamadı (HTTP ${tokenRes.status}): ${err}`);
  }

  const tokenData = await tokenRes.json();
  LOG('✅ [1/5] Access token başarıyla alındı. Token türü:', tokenData.token_type);
  return tokenData.access_token;
}

// ── Kullanıcıya ait alt klasörü bul veya oluştur ──────────────────────────────
async function getOrCreateUserFolder(token, uid) {
  const parentId = process.env.GDRIVE_FOLDER_ID;

  if (!parentId) {
    ERR('❌ [2/5] GDRIVE_FOLDER_ID env değişkeni eksik!');
    throw new Error('GDRIVE_FOLDER_ID tanımlı değil');
  }

  LOG(`📁 [2/5] Kullanıcı klasörü aranıyor. uid=${uid}, parentId=${parentId}`);

  const q       = `'${parentId}' in parents and name='${uid}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const listRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!listRes.ok) {
    const err = await listRes.text();
    ERR(`❌ [2/5] Klasör listeleme başarısız! HTTP ${listRes.status}:`, err);
    throw new Error(`Klasör listelenemedi (HTTP ${listRes.status}): ${err}`);
  }

  const listData = await listRes.json();

  if (listData.files && listData.files.length > 0) {
    LOG(`✅ [2/5] Mevcut klasör bulundu. id=${listData.files[0].id}`);
    return listData.files[0].id;
  }

  LOG('📁 [2/5] Klasör bulunamadı, yeni oluşturuluyor...');
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body   : JSON.stringify({
      name    : uid,
      mimeType: 'application/vnd.google-apps.folder',
      parents : [parentId],
    }),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    ERR(`❌ [2/5] Klasör oluşturma başarısız! HTTP ${createRes.status}:`, err);
    throw new Error(`Klasör oluşturulamadı (HTTP ${createRes.status}): ${err}`);
  }

  const createData = await createRes.json();
  LOG(`✅ [2/5] Yeni klasör oluşturuldu. id=${createData.id}`);
  return createData.id;
}

// ── Dosya yükle: yeni oluştur (multipart POST) VEYA üzerine yaz (simple PATCH) ─
async function driveUpload(token, { folderId, fileName, mimeType, content, existingFileId }) {

  if (existingFileId) {
    LOG(`📤 [3/5] Mevcut dosya güncelleniyor. fileId=${existingFileId}, boyut=${content.length} byte`);

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
      ERR(`❌ [3/5] Dosya güncelleme (PATCH) başarısız! HTTP ${upRes.status}:`, err);
      throw new Error(`Drive upload hatası (${upRes.status}): ${err}`);
    }

    const result = await upRes.json();
    LOG(`✅ [3/5] Dosya güncellendi. id=${result.id}, name=${result.name}`);
    return result;
  }

  LOG(`📤 [3/5] Yeni dosya oluşturuluyor. name=${fileName}, boyut=${content.length} byte`);

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
    ERR(`❌ [3/5] Dosya oluşturma (POST) başarısız! HTTP ${upRes.status}:`, err);
    throw new Error(`Drive upload hatası (${upRes.status}): ${err}`);
  }

  const result = await upRes.json();
  LOG(`✅ [3/5] Yeni dosya oluşturuldu. id=${result.id}, name=${result.name}`);
  return result;
}

// ── Dosya listele ─────────────────────────────────────────────────────────────
async function listFiles(token, folderId, fileName = null) {
  let q = `'${folderId}' in parents and trashed=false`;
  if (fileName) q += ` and name='${fileName}'`;

  LOG(`🔍 [4/5] Dosyalar listeleniyor. folderId=${folderId}${fileName ? ', fileName=' + fileName : ''}`);

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime,size)&orderBy=name+desc`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    const err = await res.text();
    ERR(`❌ [4/5] Dosya listesi alınamadı! HTTP ${res.status}:`, err);
    throw new Error(`Dosya listelenemedi (HTTP ${res.status}): ${err}`);
  }

  const data = await res.json();
  LOG(`✅ [4/5] ${(data.files || []).length} dosya bulundu.`);
  return data.files || [];
}

// ── Dosya içeriğini indir ─────────────────────────────────────────────────────
async function downloadFile(token, fileId) {
  LOG(`⬇️  [5/5] Dosya indiriliyor. fileId=${fileId}`);

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    ERR(`❌ [5/5] Dosya indirme başarısız! HTTP ${res.status}`);
    throw new Error(`Drive download hatası (${res.status})`);
  }

  LOG('✅ [5/5] Dosya başarıyla indirildi.');
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

  LOG(`\n━━━ YENİ İSTEK ━━━ method=${req.method} action=${action} uid=${uid} date=${date}`);

  if (!uid) {
    ERR('uid parametresi eksik!');
    return res.status(400).json({ error: 'uid gerekli' });
  }

  try {
    const token = await getAccessToken();

    // ── POST { action:'save', uid, date, data } ──────────────────────────────
    if (req.method === 'POST' && action === 'save') {
      const { date: d, data } = req.body;
      if (!d || !data) {
        ERR('save: date veya data eksik!');
        return res.status(400).json({ error: 'date ve data gerekli' });
      }

      LOG(`💾 SAVE işlemi başladı. date=${d}`);
      const folderId       = await getOrCreateUserFolder(token, uid);
      const fname          = `${d}.json`;
      const json           = JSON.stringify(data);
      const existing       = await listFiles(token, folderId, fname);
      const existingFileId = existing.length > 0 ? existing[0].id : null;

      LOG(existingFileId ? `♻️  Üzerine yazılacak. fileId=${existingFileId}` : '🆕 Yeni dosya oluşturulacak.');
      await driveUpload(token, { folderId, fileName: fname, mimeType: 'application/json', content: json, existingFileId });

      LOG('🎉 SAVE tamamlandı.');
      return res.status(200).json({ ok: true, date: d });
    }

    // ── GET ?action=list ─────────────────────────────────────────────────────
    if (action === 'list') {
      LOG('📋 LIST işlemi başladı.');
      const folderId = await getOrCreateUserFolder(token, uid);
      const files    = await listFiles(token, folderId);
      LOG(`📋 LIST tamamlandı. ${files.length} yedek bulundu.`);
      return res.status(200).json({ files });
    }

    // ── GET ?action=load&date=2026-03-25 ─────────────────────────────────────
    if (action === 'load') {
      if (!date) {
        ERR('load: date parametresi eksik!');
        return res.status(400).json({ error: 'date gerekli' });
      }
      LOG(`📂 LOAD işlemi başladı. date=${date}`);
      const folderId = await getOrCreateUserFolder(token, uid);
      const found    = await listFiles(token, folderId, `${date}.json`);
      if (found.length === 0) {
        LOG(`⚠️  LOAD: ${date}.json bulunamadı.`);
        return res.status(404).json({ error: 'Yedek bulunamadı' });
      }
      const content = await downloadFile(token, found[0].id);
      LOG('🎉 LOAD tamamlandı.');
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).send(content);
    }

    // ── GET ?action=latest ───────────────────────────────────────────────────
    if (action === 'latest') {
      LOG('⏩ LATEST işlemi başladı.');
      const folderId = await getOrCreateUserFolder(token, uid);
      const files    = await listFiles(token, folderId);
      if (files.length === 0) {
        LOG('⚠️  LATEST: Hiç yedek bulunamadı.');
        return res.status(404).json({ error: 'Yedek yok' });
      }
      const latest  = files[0];
      LOG(`⏩ En son yedek: ${latest.name}`);
      const content = await downloadFile(token, latest.id);
      LOG('🎉 LATEST tamamlandı.');
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Backup-Date', latest.name.replace('.json', ''));
      return res.status(200).send(content);
    }

    ERR('Geçersiz action:', action);
    return res.status(400).json({ error: 'Geçersiz action' });

  } catch (e) {
    ERR('İşlem başarısız:', e.message);
    console.error('[GDrive][STACK]', e.stack);
    return res.status(500).json({ error: 'Drive işlemi başarısız', detail: e.message });
  }
};
