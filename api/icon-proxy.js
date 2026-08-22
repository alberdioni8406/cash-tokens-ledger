// /api/icon-proxy?src=<url> — fetches a token icon SERVER-SIDE and streams
// it back, instead of letting the browser load it directly.
//
// Why this exists: token name/description/icon come from each token's
// issuer via TokenStork/BCMR — that's arbitrary, untrusted data. If an
// issuer sets icon to something like "http://192.168.1.1/x.png" or
// "http://localhost:1234/y.png", a plain <img src="..."> would make the
// VISITOR'S browser fetch it directly, i.e. probe their own local
// network from our page. Chrome's newer "Local Network Access" check
// flags exactly this. Routing every icon through this proxy means the
// visitor's browser only ever talks to our own domain — the actual
// fetch happens from Vercel's infrastructure, and we validate/reject
// private, loopback and link-local hosts before making it.

const BLOCKED_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /\.local$/i,
  /^0\.0\.0\.0$/,
];

function isPrivateIPv4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127) return true;                     // loopback
  if (a === 10) return true;                       // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;          // 192.168.0.0/16
  if (a === 169 && b === 254) return true;          // link-local
  return false;
}

function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  if (BLOCKED_HOSTNAME_PATTERNS.some((re) => re.test(h))) return true;
  if (isPrivateIPv4(h)) return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true; // IPv6 loopback/ULA/link-local
  return false;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { src } = req.query;
  if (!src) return res.status(400).end();

  let url;
  try {
    url = new URL(src);
  } catch {
    return res.status(400).end();
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return res.status(400).end();
  if (isBlockedHost(url.hostname)) return res.status(403).end();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const upstream = await fetch(url.toString(), { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timeout);

    if (!upstream.ok) return res.status(404).end();

    const contentType = upstream.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) return res.status(415).end();

    // Re-check the FINAL (post-redirect) host too, so a public URL that
    // redirects to a private address doesn't slip through.
    const finalHost = new URL(upstream.url).hostname;
    if (isBlockedHost(finalHost)) return res.status(403).end();

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.byteLength > 2 * 1024 * 1024) return res.status(413).end(); // 2MB cap

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).send(buf);
  } catch (err) {
    return res.status(502).end();
  }
}
