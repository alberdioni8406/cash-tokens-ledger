// /api/tokens — proxies TokenStork's token directory.
// Exists purely to dodge browser CORS: TokenStork does not send
// Access-Control-Allow-Origin, so a direct fetch() from the page
// fails silently in every browser even though curl/server-side
// fetches succeed. Vercel functions run server-side, so this call
// is unrestricted, and we re-serve the JSON with our own CORS
// headers so the static front-end can read it.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { offset = '0', limit = '100', search = '' } = req.query;

  const upstream = new URL('https://tokenstork.com/api/tokens');
  upstream.searchParams.set('offset', offset);
  upstream.searchParams.set('limit', limit);
  if (search) upstream.searchParams.set('search', search);

  try {
    const r = await fetch(upstream.toString(), {
      headers: { 'accept': 'application/json' },
    });
    if (!r.ok) {
      return res.status(r.status).json({ error: `TokenStork responded ${r.status}` });
    }
    const data = await r.json();
    // short edge cache so repeated page loads across visitors don't
    // hammer TokenStork; the client also caches this in localStorage
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: 'Could not reach TokenStork', detail: String(err) });
  }
}
