// /api/bcmr?id=<categoryId> — proxies Paytaca's BCMR metadata registry
// for a single token category. Same CORS-dodge pattern as the other
// two routes: BCMR is fine to call server-side, blocked client-side.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing required "id" query param' });

  try {
    const r = await fetch(`https://bcmr.paytaca.com/api/tokens/${encodeURIComponent(id)}`, {
      headers: { accept: 'application/json' },
    });
    if (!r.ok) {
      if (r.status === 404) return res.status(200).json(null);
      return res.status(r.status).json({ error: `BCMR responded ${r.status}` });
    }
    const data = await r.json();
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: 'Could not reach BCMR', detail: String(err) });
  }
}
