const { GoogleAuth } = require('google-auth-library');

const SERVICE_ACCOUNT = {
  type: "service_account",
  project_id: "yks-asistan-10a95",
  private_key_id: "890decab8c",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDcUu/feoP/Dntc\n7P99dJST8I0iVMlxmw6r8mIk7Cfbc3EpBLKSHzyzHna75bq6xjq0ClNxuh/7O+iL\nvZE6bWS/+MBgByN2lDcDPzAAr0CbxsTCgd6ly25CndO5cZTOeniotIbWSsosG11d\n9701rj39BJ2aWumKCj+Qgc3gUHnOg0fCJTJJ4F2RjUQ5umpX+J3PaJmSsWY7Hvpl\nJS6VGd9WocSJcU1wtQksKVJi3q8BKtUkIPtXkZ7XhG4UU/H4HXLtmuQwCUaWvk8P\neSN4VqEjkoCMuuvP34w77Osd3EeIkgAvp08+ZqAZ0nKTb47a0i1qVeXhaTC/9aUz\nmWzww9kVAgMBAAECggEAAVE49ZfuGG/LOrErY+IhuJ1hvU35eFrqJGAKHdi68kZx\n65dcw/U42oSjnBhRsf0ua6t7d+dveoPkrjU0xunRhjj5WXmhc3uLtVLC5DYoB5ER\ngGzgr71pdtoqYmZJ8qQWeu0SuKRGKiuttrqc9dMJXte7Y36zUmvLmSnALoenUB3u\nUAaKSQmwVPtAOd0LrjxwpxmSkxQ0jJ/xctbi4fWkDioIh4mHCYxsOTrg1eSin+dN\nwTnGBuQARIPmKO17VSOzbbxsZWPfb/drA+ILm7dcFOtG7xnm4EkV0nvKwSqgYdwu\nNYGVJAHaubhXJb06Rov0kDe+6jlCkFlRax12plDqMQKBgQD1H/exbj2D5lbW33ty\nS2KTdqbvjr8VVuoO3yw8K1GLRwO3fkVtXRCLA/g64Y/rqd8OGfCxGL1eaxKJE5BW\n8cZn9y3pdf01z3rdIhhys9eETNh3RsLFlIG29JCa72SLmY9kIickdAnIsSaJLnPG\nkrhgBuMfXoHMe0G7xeKEISZHTQKBgQDmGUpftFgE5U4/U4j8OH+uhsdSQpfah8Og\nbCohAookfqCJrSmKOMzScmNbKoqkEHSd3Df3DiMX5+0LHmYCEHHk5HJWbMcIf7Vb\nFN175NuVTn0naAzablorXZu/0hkTtSYQAeBwT/lF4iZIE52VQDgAdB/S1fs9UtOk\nU8RZAK7E6QKBgBW0Ze9NDp9eRvQxx7GAIVNjXza5EgxmrMTyV+1f/JFzkU2vHaCo\na+2TRWiZTnAUk46hF2HnCeWRX4vJsq8wK1xLU8JnUytvmrZ37WhCqmOplkVBe7+Y\n/b9gemltpx6BU2QPbh3ZNICTxxDAjznXBgJiubuuV5nulAx3Yi5G7SfFAoGAV2YR\nzupUaH+kyf7z0EGxldwRx5gNz+6zirKrCeDKEfSbC9BfL+ZFPkY+oPk2sfyiHvfv\ntgKDp+frLMb+Hhia+kMfft5Qd1Ty0MbLHe0ezsaCWT53a1xxGXmz2Bd4ePjcnUXp\nNx/ZYgb1XXk96Nv8qYdyMwYeKPvV8dvzf47300kCgYB3H08hZhjPNQAbV93/ewRl\nPO3gUNX0sBCRpMVQEHhk3Uxx3c8mEWeDrgEWVF6sMO3U1ne03PVV8exO5M+RtEPX\nt6Ibp+qmyr3h29vYFSYYf+n1fR6Y4UKJ1lCGlzYJYcrkUpZICA7/jY6qRXt3diVo\nbkWZ2vx5AqlmFkKKN0ROkQ==\n-----END PRIVATE KEY-----\n",
  client_email: "firebase-adminsdk-fbsvc@yks-asistan-10a95.iam.gserviceaccount.com",
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
        data: {
          title:      String(title),
          body:       String(body),
          senderCode: String(senderCode || '')
        },
        webpush: { headers: { Urgency: 'high' } }
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
