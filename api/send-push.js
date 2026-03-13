const { GoogleAuth } = require('google-auth-library');

const SERVICE_ACCOUNT = {
  type: "service_account",
  project_id: "yks-asistan-10a95",
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  token_uri: "https://oauth2.googleapis.com/token"
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token, title, body, senderCode } = req.body;
    if (!token || !title || !body) return res.status(400).json({ error: 'Missing required fields' });

    const auth = new GoogleAuth({
      credentials: SERVICE_ACCOUNT,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging']
    });
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    const fcmUrl = `https://fcm.googleapis.com/v1/projects/${SERVICE_ACCOUNT.project_id}/messages:send`;

    const message = {
      message: {
        token,
        data: { senderCode: senderCode || '' },
        webpush: {
          headers: { Urgency: 'high' },
          notification: {
            title,
            body,
            icon: 'https://deligom.github.io/yks-asistan/icon-192.png'
          }
        }
      }
    };

    const response = await fetch(fcmUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(message)
    });

    const result = await response.json();
    if (!response.ok) return res.status(500).json(result);
    return res.status(200).json({ success: true });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
