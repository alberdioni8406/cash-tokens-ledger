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
  const offset = url.searchParams.get('offset') || '0';
  const limit = url.searchParams.get('limit') || '100';
  const search = url.searchParams.get('search') || '';

  const upstream = new URL('https://tokenstork.com/api/tokens');
  upstream.searchParams.set('offset', offset);
  upstream.searchParams.set('limit', limit);
  if (search) upstream.searchParams.set('search', search);

  try {
    const r = await fetch(upstream.toString(), {
      headers: { accept: 'application/json' },
    });
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
        'Cache-Control': 's-maxage=120, stale-while-revalidate=300',
      },
    });
  } catch (err) {
    return Response.json(
      { error: 'Could not reach TokenStork', detail: String(err) },
      { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } }
    );
  }
}
