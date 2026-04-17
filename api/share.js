// api/share.js — Vercel serverless function
// Stores encrypted trip share data, returns a short ID

const ENCRYPTED_TRIPS = new Map(); // In-memory store (use KV in production)

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { Storage } = await import('@vercel/kv');
  const kv = new Storage({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

  if (req.method === 'GET') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    const trip = await kv.get(`share:${id}`);
    if (!trip) return res.status(404).json({ error: 'Not found or expired' });
    return res.status(200).json(JSON.parse(trip));
  }

  if (req.method === 'POST') {
    const { encryptedData, meta, expiresInDays = 30 } = req.body;
    if (!encryptedData) return res.status(400).json({ error: 'Missing encryptedData' });

    const id = generateId(8);
    const expiresAt = Date.now() + (expiresInDays * 24 * 60 * 60 * 1000);

    const record = {
      encryptedData,
      meta: meta || {},
      createdAt: Date.now(),
      expiresAt,
    };

    await kv.set(`share:${id}`, JSON.stringify(record), { exat: Math.floor(expiresAt / 1000) });
    return res.status(200).json({ id, expiresAt, url: `/view/${id}` });
  }

  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    await kv.del(`share:${id}`);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

function generateId(length = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let result = '';
  const randomValues = crypto.getRandomValues(new Uint8Array(length));
  for (let i = 0; i < length; i++) {
    result += chars[randomValues[i] % chars.length];
  }
  return result;
}
