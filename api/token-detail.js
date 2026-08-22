const ALLOWED = new Set(['holders', 'nfts', 'history']);

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      },
    });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  const type = url.searchParams.get('type');

  if (!id) {
    return Response.json(
      { error: 'Missing required "id" query param' },
      { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } }
    );
  }
  if (!type || !ALLOWED.has(type)) {
    return Response.json(
      { error: `"type" must be one of: ${[...ALLOWED].join(', ')}` },
      { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } }
    );
  }

  const upstream = `https://tokenstork.com/api/tokens/\( {encodeURIComponent(id)}/ \){type}`;

  try {
    const r = await fetch(upstream, { headers: { accept: 'application/json' } });
    if (r.status === 404) {
      return Response.json(null, {
        status: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }
    if (!r.ok) {
      return Response.json(
        { error: `TokenStork responded ${r.status}` },
        { status: r.status, headers: { 'Access-Control-Allow-Origin': '*' } }
      );
    }
    const data = await r.json();
    return Response.json(data, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 's-maxage=300, stale-while-revalidate=600',
      },
    });
  } catch (err) {
    return Response.json(
      { error: 'Could not reach TokenStork', detail: String(err) },
      { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } }
    );
  }
}
