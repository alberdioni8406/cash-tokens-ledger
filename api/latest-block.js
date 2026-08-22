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

  try {
    const r = await fetch('https://bcmr.paytaca.com/api/status/latest-block/', {
      headers: { accept: 'application/json' },
    });
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
        'Cache-Control': 's-maxage=30, stale-while-revalidate=60',
      },
    });
  } catch (err) {
    return Response.json(
      { error: 'Could not reach BCMR', detail: String(err) },
      { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } }
    );
  }
}
