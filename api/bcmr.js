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
  if (!id) {
    return Response.json(
      { error: 'Missing required "id" query param' },
      { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } }
    );
  }

  try {
    const r = await fetch(`https://bcmr.paytaca.com/api/tokens/${encodeURIComponent(id)}`, {
      headers: { accept: 'application/json' },
    });
    if (r.status === 404) {
      return Response.json(null, {
        status: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }
    if (!r.ok) {
      return Response.json(
        { error: `BCMR responded ${r.status}` },
        { status: r.status, headers: { 'Access-Control-Allow-Origin': '*' } }
      );
    }
    const data = await r.json();
    return Response.json(data, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 's-maxage=900, stale-while-revalidate=1800',
      },
    });
  } catch (err) {
    return Response.json(
      { error: 'Could not reach BCMR', detail: String(err) },
      { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } }
    );
  }
}
