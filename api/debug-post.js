// api/debug-post.js
// POST/GET test endpoint — deploy et, tarayıcıdan test et
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  return res.status(200).json({
    method  : req.method,
    body    : req.body,
    query   : req.query,
    headers : {
      'content-type'  : req.headers['content-type'],
      'content-length': req.headers['content-length'],
    },
    env: {
      has_client_id    : !!process.env.GDRIVE_CLIENT_ID,
      has_client_secret: !!process.env.GDRIVE_CLIENT_SECRET,
      has_refresh_token: !!process.env.GDRIVE_REFRESH_TOKEN,
      has_folder_id    : !!process.env.GDRIVE_FOLDER_ID,
    },
  });
}
