// /api/latest-block — proxies BCMR's indexer height, shown in the
// header strip so users can see how fresh the underlying index is.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const r = await fetch('https://bcmr.paytaca.com/api/status/latest-block/', {
      headers: { accept: 'application/json' },
    });
    if (!r.ok) return res.status(r.status).json({ error: `BCMR responded ${r.status}` });
    const data = await r.json();
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: 'Could not reach BCMR', detail: String(err) });
  }
}
