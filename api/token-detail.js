// /api/token-detail?id=<categoryId>&type=holders|nfts|history
// Proxies TokenStork's per-token sub-resources for the same CORS
// reason as /api/tokens.js. One route handles all three so we don't
// need three near-identical files.

const ALLOWED_TYPES = new Set(['holders', 'nfts', 'history']);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id, type } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing required "id" query param' });
  if (!type || !ALLOWED_TYPES.has(type)) {
    return res.status(400).json({ error: `"type" must be one of: ${[...ALLOWED_TYPES].join(', ')}` });
  }

  const upstream = `https://tokenstork.com/api/tokens/${encodeURIComponent(id)}/${type}`;

  try {
    const r = await fetch(upstream, { headers: { accept: 'application/json' } });
    if (!r.ok) {
      // Not every category has holders/nfts/history data — treat 404 as
      // "no data" rather than an error the client needs to alarm about.
      if (r.status === 404) return res.status(200).json(null);
      return res.status(r.status).json({ error: `TokenStork responded ${r.status}` });
    }
    const data = await r.json();
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: 'Could not reach TokenStork', detail: String(err) });
  }
}
