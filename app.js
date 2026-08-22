
/* =========================================================
   CashTokens Ledger — app logic
   Data flow:
     1. fetchTokenPage(offset) hits TokenStork /api/tokens.
        Results are cached in memory + localStorage (2–5 min TTL).
     2. The full directory is far too large (~19k+ categories)
        to hold client-side, so the Explorer table works page
        by page against TokenStork's own offset pagination,
        while search/filter are additionally applied client-
        side against whatever page(s) are currently loaded so
        results feel instant even if the upstream API ignores
        a given query param on a given deploy.
     3. Leaderboards/ticker pull a handful of pages once per
        session (cached) and rank client-side — good enough
        for a "top of the ecosystem" view without indexing
        20k tokens ourselves.
     4. Opening a token detail panel lazily fetches BCMR
        metadata + (if available) holders/NFTs for JUST that
        token, cached per category ID until the tab closes.
   ========================================================= */

// All data goes through our own /api/* Vercel functions rather than
// tokenstork.com / bcmr.paytaca.com directly. Neither upstream sends
// Access-Control-Allow-Origin, so a browser fetch() straight to them
// is blocked by CORS even though a server-side call succeeds — the
// serverless routes under /api exist specifically to work around that.
const TOKENSTORK = '/api/tokens';
const TOKEN_DETAIL = (id, type) => `/api/token-detail?id=${encodeURIComponent(id)}&type=${type}`;
const TOKENSTORK_HOLDERS = (id) => TOKEN_DETAIL(id, 'holders');
const TOKENSTORK_NFTS = (id) => TOKEN_DETAIL(id, 'nfts');
const TOKENSTORK_HISTORY = (id) => TOKEN_DETAIL(id, 'history');
const BCMR_TOKEN = (id) => `/api/bcmr?id=${encodeURIComponent(id)}`;
const BCMR_LATEST_BLOCK = '/api/latest-block';

const PAGE_SIZE = 100;
const LIST_CACHE_TTL = 3 * 60 * 1000;      // 2–5 min for the directory
const DETAIL_CACHE_TTL = 15 * 60 * 1000;   // longer for holders/NFTs

const state = {
  offset: 0,
  total: null,
  rawPage: [],          // current page as returned by the API
  displayRows: [],       // after client-side filter/search/sort
  sortKey: 'genesisTime',
  sortDir: 'desc',
  search: '',
  typeFilter: '',
  activeOnly: false,
  newWeekOnly: false,
  minHolders: 0,
  bcmrCache: {},          // categoryId -> bcmr record
  detailCache: {},        // categoryId -> {holders, nfts}
  samplePages: [],        // a handful of pages pooled for leaderboards/ticker/stats
  watchlist: new Set(JSON.parse(localStorage.getItem('ctl:watchlist') || '[]')),
  watchlistOnly: false,
};

function saveWatchlist(){
  try { localStorage.setItem('ctl:watchlist', JSON.stringify([...state.watchlist])); } catch(e){}
}
function toggleWatch(id){
  if (state.watchlist.has(id)) { state.watchlist.delete(id); toast('Removed from watchlist'); }
  else { state.watchlist.add(id); toast('Added to watchlist'); }
  saveWatchlist();
  renderTable();
  if (document.getElementById('detailPanel').classList.contains('open')) {
    document.querySelectorAll('.watch-star').forEach(el => {
      if (el.dataset.id) el.classList.toggle('active', state.watchlist.has(el.dataset.id));
    });
  }
}

// ---------- theme ----------
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('ctl:theme', theme); } catch(e){}
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = theme === 'light' ? '🌙' : '☀️';
}
function initTheme(){
  const saved = (() => { try { return localStorage.getItem('ctl:theme'); } catch(e){ return null; } })();
  applyTheme(saved === 'light' ? 'light' : 'dark');
}

// ---------- tiny cache helpers (memory + localStorage) ----------
const mem = new Map();
function cacheGet(key, ttl){
  const hit = mem.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  try {
    const raw = localStorage.getItem('ctl:' + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.t > ttl) return null;
    mem.set(key, parsed);
    return parsed.v;
  } catch(e){ return null; }
}
function cacheSet(key, v){
  const entry = { t: Date.now(), v };
  mem.set(key, entry);
  try { localStorage.setItem('ctl:' + key, JSON.stringify(entry)); } catch(e){ /* storage full/unavailable — memory cache still works */ }
}

function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), 1800);
}

function fmtNum(n, decimals){
  if (n === null || n === undefined) return '—';
  let num = Number(n);
  if (decimals) num = num / Math.pow(10, decimals);
  if (!isFinite(num)) return '—';
  if (Math.abs(num) >= 1e12) return (num/1e12).toFixed(2) + 'T';
  if (Math.abs(num) >= 1e9) return (num/1e9).toFixed(2) + 'B';
  if (Math.abs(num) >= 1e6) return (num/1e6).toFixed(2) + 'M';
  if (Math.abs(num) >= 1e3) return (num/1e3).toFixed(2) + 'K';
  if (Number.isInteger(num)) return num.toLocaleString();
  return num.toLocaleString(undefined, {maximumFractionDigits:4});
}
function fmtAgo(unixSeconds){
  if (!unixSeconds) return '—';
  const diff = Date.now()/1000 - unixSeconds;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff/60) + 'm ago';
  if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
  if (diff < 86400*30) return Math.floor(diff/86400) + 'd ago';
  return new Date(unixSeconds*1000).toLocaleDateString();
}
function truncId(id, n=8){
  if (!id) return '—';
  return id.slice(0,n) + '…' + id.slice(-n);
}
function typeBadge(t){
  const map = { 'FT':['ft','FT'], 'NFT':['nft','NFT'], 'FT+NFT':['hybrid','FT+NFT'] };
  const [cls,label] = map[t] || ['unverified', t || '?'];
  return `<span class="badge ${cls}">${label}</span>`;
}
function statusBadge(tok){
  if (tok.isFullyBurned) return '<span class="badge burned">● burned</span>';
  if (tok.isVerifiedOnchain === false) return '<span class="badge unverified">unverified</span>';
  return '<span class="badge ft">● active</span>';
}
function copyToClipboard(text, label){
  navigator.clipboard?.writeText(text).then(() => toast((label||'Copied') + ' to clipboard')).catch(()=>{
    toast('Could not copy — select manually');
  });
}

// ---------- fetch layer ----------
async function fetchTokenPage(offset){
  const key = `page:${offset}`;
  const cached = cacheGet(key, LIST_CACHE_TTL);
  if (cached) return cached;
  const res = await fetch(`${TOKENSTORK}?limit=${PAGE_SIZE}&offset=${offset}`);
  if (!res.ok) throw new Error('TokenStork responded ' + res.status);
  const data = await res.json();
  cacheSet(key, data);
  return data;
}

async function fetchBcmr(categoryId){
  if (state.bcmrCache[categoryId]) return state.bcmrCache[categoryId];
  const cached = cacheGet('bcmr:' + categoryId, DETAIL_CACHE_TTL);
  if (cached) { state.bcmrCache[categoryId] = cached; return cached; }
  try {
    const res = await fetch(BCMR_TOKEN(categoryId));
    if (!res.ok) throw new Error('no bcmr record');
    const data = await res.json();
    state.bcmrCache[categoryId] = data;
    cacheSet('bcmr:' + categoryId, data);
    return data;
  } catch(e){
    state.bcmrCache[categoryId] = null;
    return null;
  }
}

async function fetchHoldersAndNfts(categoryId){
  const cached = cacheGet('detail:' + categoryId, DETAIL_CACHE_TTL);
  if (cached) return cached;
  const out = { holders: null, nfts: null, history: null };
  await Promise.all([
    fetch(TOKENSTORK_HOLDERS(categoryId)).then(r => r.ok ? r.json() : null).then(d => out.holders = d).catch(()=>{}),
    fetch(TOKENSTORK_NFTS(categoryId)).then(r => r.ok ? r.json() : null).then(d => out.nfts = d).catch(()=>{}),
    fetch(TOKENSTORK_HISTORY(categoryId)).then(r => r.ok ? r.json() : null).then(d => out.history = d).catch(()=>{}),
  ]);
  cacheSet('detail:' + categoryId, out);
  return out;
}

async function fetchLatestBlock(){
  const cached = cacheGet('latestBlock', 60*1000);
  if (cached !== null) return cached;
  try {
    const res = await fetch(BCMR_LATEST_BLOCK);
    const data = await res.json();
    cacheSet('latestBlock', data.height);
    return data.height;
  } catch(e){ return null; }
}

// pool a handful of pages once per session for stats/leaderboards/ticker
async function getSamplePool(){
  if (state.samplePages.length) return state.samplePages.flatMap(p => p.tokens || []);
  const pagesToPool = 3; // 300 tokens — enough for a representative "hot" view without hammering the API
  const pages = [];
  for (let i = 0; i < pagesToPool; i++){
    try { pages.push(await fetchTokenPage(i * PAGE_SIZE)); } catch(e){ break; }
  }
  state.samplePages = pages;
  return pages.flatMap(p => p.tokens || []);
}

// ---------- rendering: header stats ----------
async function renderHeaderStats(){
  try {
    const first = await fetchTokenPage(0);
    state.total = first.total ?? first.tokens?.length ?? 0;
    document.getElementById('statTotal').textContent = fmtNum(state.total);
    document.getElementById('kpiTotal').textContent = fmtNum(state.total);

    const pool = await getSamplePool();
    const burned = pool.filter(t => t.isFullyBurned).length;
    const burnedShare = pool.length ? Math.round((burned/pool.length) * state.total) : null;
    document.getElementById('statBurned').textContent = burnedShare !== null ? '~' + fmtNum(burnedShare) : fmtNum(burned);

    const now = Date.now()/1000;
    const new24h = pool.filter(t => t.firstSeenAt && (now - t.firstSeenAt) < 86400).length;
    document.getElementById('statNew24h').textContent = pool.length < state.total ? '~' + new24h + '*' : new24h;

    const ft = pool.filter(t => t.tokenType === 'FT').length;
    const nft = pool.filter(t => t.tokenType === 'NFT').length;
    const hybrid = pool.filter(t => t.tokenType === 'FT+NFT').length;
    const scale = pool.length ? state.total / pool.length : 1;
    document.getElementById('kpiFT').textContent = '~' + fmtNum(Math.round(ft*scale));
    document.getElementById('kpiNFT').textContent = '~' + fmtNum(Math.round(nft*scale));
    document.getElementById('kpiHybrid').textContent = '~' + fmtNum(Math.round(hybrid*scale));
  } catch(e){
    document.getElementById('statTotal').textContent = 'offline';
    toast('Could not reach TokenStork — showing cached data if any');
  }

  const block = await fetchLatestBlock();
  document.getElementById('statBlock').textContent = block ? fmtNum(block) : '—';

  document.getElementById('lastFetchTag').textContent = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  document.getElementById('footerFetchTimes').textContent = 'last synced ' + new Date().toLocaleTimeString();
}

// ---------- genesis activity mini chart ----------
let genesisChartInstance = null;
async function renderGenesisChart(){
  const pool = await getSamplePool();
  const days = 14;
  const buckets = new Array(days).fill(0);
  const now = Math.floor(Date.now()/1000);
  const dayStart = now - (now % 86400);
  pool.forEach(t => {
    if (!t.genesisTime) return;
    const d = Math.floor((dayStart - (t.genesisTime - (t.genesisTime % 86400))) / 86400);
    if (d >= 0 && d < days) buckets[days - 1 - d]++;
  });
  const labels = [];
  for (let i = days-1; i >= 0; i--){
    const d = new Date((dayStart - i*86400) * 1000);
    labels.push(d.toLocaleDateString(undefined, {month:'short', day:'numeric'}));
  }
  const ctx = document.getElementById('genesisChart');
  if (genesisChartInstance) genesisChartInstance.destroy();
  genesisChartInstance = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data: buckets, backgroundColor: 'rgba(10,193,142,.55)', borderRadius: 3, maxBarThickness: 18 }] },
    options: {
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label: (c) => c.parsed.y + ' new (sampled)' } } },
      scales:{
        x:{ ticks:{ color:'#5f6864', font:{size:9} }, grid:{ display:false } },
        y:{ ticks:{ color:'#5f6864', font:{size:9}, precision:0 }, grid:{ color:'#161e1b' } }
      }
    }
  });
}

// ---------- ticker ----------
async function renderTicker(){
  const pool = await getSamplePool();
  const recent = [...pool].filter(t => t.genesisTime).sort((a,b) => b.genesisTime - a.genesisTime).slice(0, 20);
  const track = document.getElementById('tickerTrack');
  if (!recent.length){ track.innerHTML = '<div class="state-msg faint">no recent genesis activity in the sampled window</div>'; return; }
  const itemsHtml = recent.map(t => `
    <div class="ticker-item">
      <span class="sym">${escapeHtml(t.symbol || t.name || '?')}</span>
      <span>${typeBadge(t.tokenType)}</span>
      <span class="age">${fmtAgo(t.genesisTime)}</span>
    </div>`).join('');
  // duplicate for seamless loop
  track.innerHTML = itemsHtml + itemsHtml;
}

// ---------- explorer table ----------
function applyClientFilters(tokens){
  let rows = tokens;
  const q = state.search.trim().toLowerCase();
  if (q) {
    rows = rows.filter(t =>
      (t.name && t.name.toLowerCase().includes(q)) ||
      (t.symbol && t.symbol.toLowerCase().includes(q)) ||
      (t.id && t.id.toLowerCase().includes(q))
    );
  }
  if (state.typeFilter) rows = rows.filter(t => t.tokenType === state.typeFilter);
  if (state.activeOnly) rows = rows.filter(t => !t.isFullyBurned);
  if (state.newWeekOnly) {
    const now = Date.now()/1000;
    rows = rows.filter(t => t.firstSeenAt && (now - t.firstSeenAt) < 86400*7);
  }
  if (state.minHolders) rows = rows.filter(t => (t.holderCount||0) >= state.minHolders);
  if (state.watchlistOnly) rows = rows.filter(t => state.watchlist.has(t.id));

  const key = state.sortKey;
  const dir = state.sortDir === 'asc' ? 1 : -1;
  rows = [...rows].sort((a,b) => {
    let av = a[key], bv = b[key];
    if (key === 'currentSupply'){ av = Number(av)||0; bv = Number(bv)||0; }
    if (key === 'status'){ av = a.isFullyBurned?0:1; bv = b.isFullyBurned?0:1; }
    if (av === null || av === undefined) av = key==='name' ? '' : -Infinity;
    if (bv === null || bv === undefined) bv = key==='name' ? '' : -Infinity;
    if (typeof av === 'string') return dir * av.localeCompare(bv);
    return dir * (av - bv);
  });
  return rows;
}

function renderTable(){
  const rows = applyClientFilters(state.rawPage);
  state.displayRows = rows;
  const tbody = document.getElementById('tableBody');
  if (!rows.length){
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8">No tokens match this page's filters — try clearing search, or Next page to keep browsing the directory.</td></tr>`;
  } else {
    tbody.innerHTML = rows.map(t => `
      <tr data-id="${t.id}">
        <td>
          <div class="token-cell">
            <button class="watch-star ${state.watchlist.has(t.id) ? 'active' : ''}" data-watch="${t.id}" title="${state.watchlist.has(t.id) ? 'Remove from' : 'Add to'} watchlist">★</button>
            <div class="token-icon">${iconHtml(t)}</div>
            <div>
              <div class="token-name">${escapeHtml(t.name || 'Unnamed')}</div>
              <div class="token-sym">${escapeHtml(t.symbol || '—')}</div>
            </div>
          </div>
        </td>
        <td><span class="copy-id" data-copy="${t.id}" title="Click to copy full ID">${truncId(t.id)} <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></span></td>
        <td>${typeBadge(t.tokenType)}</td>
        <td class="num-cell">${fmtNum(t.currentSupply, t.decimals)}</td>
        <td class="num-cell">${fmtNum(t.holderCount)}</td>
        <td class="num-cell">${fmtNum(t.liveUtxoCount)}</td>
        <td class="dim">${fmtAgo(t.genesisTime)}</td>
        <td>${statusBadge(t)}</td>
      </tr>
    `).join('');
  }
  document.querySelectorAll('[data-sort]').forEach(th => {
    th.classList.toggle('sorted', th.dataset.sort === state.sortKey);
    const arrow = th.querySelector('.arrow');
    arrow.textContent = th.dataset.sort === state.sortKey ? (state.sortDir === 'asc' ? '↑' : '↓') : '';
  });
  updatePagerInfo();
}

function iconHtml(t){
  const src = resolveIconUrl(t.icon);
  if (!src) return initialGlyph(t.symbol || t.name);
  return `<img src="${src}" alt="" loading="lazy" onerror="this.parentElement.innerHTML=initialGlyph('${escapeHtml((t.symbol||t.name||'?')).replace(/'/g,"")}')">`;
}
function initialGlyph(label){
  const ch = (label || '?').trim().charAt(0).toUpperCase() || '?';
  return ch;
}
function resolveIconUrl(icon){
  if (!icon) return null;
  if (icon.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + icon.slice(7);
  if (icon.startsWith('http')) return icon;
  return null; // emoji or bare string icons render fine as text via initialGlyph fallback
}
function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function updatePagerInfo(){
  const startIdx = state.offset + 1;
  const endIdx = state.offset + (state.rawPage?.length || 0);
  document.getElementById('pagerInfo').textContent =
    `Showing ${startIdx.toLocaleString()}–${endIdx.toLocaleString()} of ${fmtNum(state.total)} tracked categories` +
    (state.search || state.typeFilter || state.activeOnly || state.newWeekOnly || state.minHolders ? ' (filtered within this page)' : '');
  document.getElementById('prevPage').disabled = state.offset <= 0;
  document.getElementById('nextPage').disabled = state.total !== null && state.offset + PAGE_SIZE >= state.total;
}

async function loadPage(offset){
  state.offset = Math.max(0, offset);
  document.getElementById('tableBody').innerHTML = `<tr class="empty-row"><td colspan="8"><span class="spinner"></span> Loading…</td></tr>`;
  try {
    const data = await fetchTokenPage(state.offset);
    state.rawPage = data.tokens || [];
    state.total = data.total ?? state.total;
    renderTable();
  } catch(e){
    document.getElementById('tableBody').innerHTML = `<tr class="empty-row"><td colspan="8">Couldn't reach TokenStork right now. It may be rate-limiting or briefly down — try Refresh in a moment.</td></tr>`;
  }
}

// ---------- leaderboards ----------
async function renderLeaderboards(){
  const pool = await getSamplePool();
  const byHolders = [...pool].filter(t=>t.holderCount).sort((a,b)=>b.holderCount-a.holderCount).slice(0,10);
  const byUtxos = [...pool].filter(t=>t.liveUtxoCount).sort((a,b)=>b.liveUtxoCount-a.liveUtxoCount).slice(0,10);
  const byRecent = [...pool].filter(t=>t.updatedAt).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,10);

  const row = (t, val) => `
    <div class="lb-row" data-id="${t.id}" style="cursor:pointer">
      <div class="lb-name"><div class="n">${escapeHtml(t.name||'Unnamed')}</div><div class="s">${escapeHtml(t.symbol||'—')}</div></div>
      <div class="lb-val">${val}</div>
    </div>`;

  document.getElementById('lbHolders').innerHTML = byHolders.map(t => row(t, fmtNum(t.holderCount))).join('') || '<div class="faint state-msg">no data in sample</div>';
  document.getElementById('lbUtxos').innerHTML = byUtxos.map(t => row(t, fmtNum(t.liveUtxoCount))).join('') || '<div class="faint state-msg">no data in sample</div>';
  document.getElementById('lbRecent').innerHTML = byRecent.map(t => row(t, fmtAgo(t.updatedAt))).join('') || '<div class="faint state-msg">no data in sample</div>';

  document.querySelectorAll('#tab-leaderboards [data-id]').forEach(el => {
    el.addEventListener('click', () => openDetail(el.dataset.id, findInPool(el.dataset.id)));
  });
}
function findInPool(id){
  for (const p of state.samplePages){ const hit = (p.tokens||[]).find(t=>t.id===id); if (hit) return hit; }
  return state.rawPage.find(t=>t.id===id) || null;
}

// ---------- detail panel ----------
async function openDetail(id, knownToken){
  document.getElementById('overlay').classList.add('open');
  const panel = document.getElementById('detailPanel');
  panel.classList.add('open');
  const tok = knownToken || state.rawPage.find(t=>t.id===id) || findInPool(id);

  panel.innerHTML = detailSkeleton(tok, id);
  wireDetailStaticButtons(id, tok);

  // enrich with BCMR if the on-chain record is sparse
  let bcmr = null;
  if (tok && (!tok.description || !tok.icon || !tok.name)) {
    bcmr = await fetchBcmr(id);
  }
  const merged = mergeBcmr(tok, bcmr);
  panel.querySelector('.receipt').outerHTML = receiptHtml(merged, id);
  panel.querySelector('.metric-grid')?.remove();
  const metricGrid = document.createElement('div');
  metricGrid.className = 'metric-grid';
  metricGrid.innerHTML = metricsHtml(merged);
  panel.querySelector('.receipt').after(metricGrid);
  wireDetailStaticButtons(id, merged);

  // holders / nfts / history
  const holdersSection = panel.querySelector('#holdersSection');
  try {
    const details = await fetchHoldersAndNfts(id);
    renderHoldersSection(holdersSection, details, merged);
  } catch(e){
    holdersSection.innerHTML = `<h4>Top holders</h4><div class="state-msg faint">Holder breakdown isn't available for this category right now.</div>`;
  }
}

function detailSkeleton(tok, id){
  return `
    <div class="detail-close">
      <button class="watch-star ${state.watchlist.has(id) ? 'active' : ''}" data-id="${id}" id="detailWatchBtn" title="Toggle watchlist" style="margin-right:auto; margin-left:16px;">★</button>
      <button id="closeDetailBtn" aria-label="Close">✕</button>
    </div>
    ${receiptHtml(tok, id)}
    <div class="metric-grid">${metricsHtml(tok)}</div>
    <div class="detail-section">
      <h4>Category</h4>
      <div class="id-row"><span class="val">${id}</span><button data-copy="${id}" title="Copy category ID">⧉</button></div>
      <div class="link-row">
        <a class="link-btn" target="_blank" rel="noopener" href="https://explorer.bch.ninja/token/${id}">Explorer</a>
        <a class="link-btn" target="_blank" rel="noopener" href="https://tokenstork.com/token/${id}">TokenStork</a>
        <a class="link-btn" target="_blank" rel="noopener" href="https://cauldron.quest/token/${id}">Cauldron</a>
      </div>
    </div>
    <div class="detail-section" id="holdersSection">
      <h4>Top holders</h4>
      <div class="state-msg"><span class="spinner"></span>loading holder breakdown…</div>
    </div>
  `;
}

function receiptHtml(tok, id){
  if (!tok) return `<div class="receipt"><div class="state-msg faint">Token record unavailable.</div></div>`;
  const statusStamp = tok.isFullyBurned
    ? '<span class="stamp burned">⛔ fully burned</span>'
    : (tok.isVerifiedOnchain === false ? '<span class="stamp unverified">? unverified</span>' : '<span class="stamp">✓ on-chain verified</span>');
  return `
    <div class="receipt">
      <div class="receipt-head">
        <div class="receipt-icon">${iconHtml(tok)}</div>
        <div>
          <div class="receipt-title">${escapeHtml(tok.name || 'Unnamed token')}</div>
          <div class="receipt-sym">${escapeHtml(tok.symbol || '—')} · ${typeBadge(tok.tokenType)}</div>
        </div>
      </div>
      ${statusStamp}
      <div class="receipt-desc">${escapeHtml(tok.description || 'No description supplied by the token issuer.')}</div>
    </div>
  `;
}

function metricsHtml(tok){
  if (!tok) return '';
  return `
    <div class="metric"><div class="v">${fmtNum(tok.currentSupply, tok.decimals)}</div><div class="k">Current supply</div></div>
    <div class="metric"><div class="v">${fmtNum(tok.holderCount)}</div><div class="k">Holders</div></div>
    <div class="metric"><div class="v">${fmtNum(tok.liveUtxoCount)}</div><div class="k">Live UTXOs</div></div>
    <div class="metric"><div class="v">${fmtNum(tok.liveNftCount)}</div><div class="k">Live NFTs</div></div>
    <div class="metric"><div class="v">${tok.genesisBlock ? '#'+fmtNum(tok.genesisBlock) : '—'}</div><div class="k">Genesis block</div></div>
    <div class="metric"><div class="v">${fmtAgo(tok.genesisTime)}</div><div class="k">Genesis time</div></div>
  `;
}

function mergeBcmr(tok, bcmr){
  if (!tok) return tok;
  if (!bcmr) return tok;
  // BCMR shape varies; pull common fields defensively without overwriting good TokenStork data
  const b = bcmr.token || bcmr;
  return {
    ...tok,
    name: tok.name || b.name,
    description: tok.description || b.description,
    icon: tok.icon || b.uris?.icon || b.icon,
    symbol: tok.symbol || b.token?.symbol || b.symbol,
  };
}

function renderHoldersSection(el, details, tok){
  const holders = details?.holders?.holders || details?.holders?.data || (Array.isArray(details?.holders) ? details.holders : null);
  const nfts = details?.nfts?.nfts || details?.nfts?.data || (Array.isArray(details?.nfts) ? details.nfts : null);
  let html = '<h4>Top holders</h4>';
  if (holders && holders.length){
    const supply = Number(tok?.currentSupply) || 0;
    html += holders.slice(0,10).map(h => {
      const bal = Number(h.balance ?? h.amount ?? 0);
      const pct = supply ? Math.min(100, (bal/supply)*100) : 0;
      const addr = h.address || h.lockingBytecode || '—';
      return `<div class="holder-row">
        <span class="holder-addr" title="${escapeHtml(addr)}">${escapeHtml(truncId(addr,6))}</span>
        <span class="holder-bar-wrap"><span class="holder-bar" style="width:${pct.toFixed(1)}%"></span></span>
        <span class="holder-pct">${pct.toFixed(1)}%</span>
      </div>`;
    }).join('');
  } else {
    html += '<div class="state-msg faint">No public per-address holder breakdown is exposed for this category — only the aggregate holder count shown above.</div>';
  }
  if (nfts && nfts.length){
    html += `<h4 style="margin-top:16px;">NFT instances (${nfts.length})</h4>` +
      nfts.slice(0,8).map(n => `<div class="holder-row"><span class="holder-addr">${escapeHtml(n.commitment ? '#'+n.commitment : (n.id||'instance'))}</span><span class="dim" style="font-size:.7rem">${escapeHtml(n.capability||'')}</span></div>`).join('');
  }
  el.innerHTML = html;
}

function wireDetailStaticButtons(id, tok){
  document.getElementById('closeDetailBtn')?.addEventListener('click', closeDetail);
  document.getElementById('detailWatchBtn')?.addEventListener('click', () => toggleWatch(id));
  document.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); copyToClipboard(btn.dataset.copy, 'Category ID'); });
  });
}
function closeDetail(){
  document.getElementById('overlay').classList.remove('open');
  document.getElementById('detailPanel').classList.remove('open');
}

// ---------- event wiring ----------
document.getElementById('overlay').addEventListener('click', closeDetail);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

document.getElementById('tableBody').addEventListener('click', (e) => {
  const copyEl = e.target.closest('[data-copy]');
  if (copyEl){ e.stopPropagation(); copyToClipboard(copyEl.dataset.copy, 'Category ID'); return; }
  const watchEl = e.target.closest('[data-watch]');
  if (watchEl){ e.stopPropagation(); toggleWatch(watchEl.dataset.watch); return; }
  const row = e.target.closest('tr[data-id]');
  if (row) openDetail(row.dataset.id);
});

document.getElementById('watchlistChip').addEventListener('click', (e) => {
  state.watchlistOnly = !state.watchlistOnly; e.target.classList.toggle('active', state.watchlistOnly); renderTable();
});

document.getElementById('exportCsvBtn').addEventListener('click', () => {
  const rows = state.displayRows.length ? state.displayRows : state.rawPage;
  if (!rows.length){ toast('Nothing to export on this page'); return; }
  const headers = ['name','symbol','id','tokenType','currentSupply','decimals','holderCount','liveUtxoCount','liveNftCount','genesisBlock','genesisTime','isFullyBurned'];
  const csvEscape = (v) => `"${String(v ?? '').replace(/"/g,'""')}"`;
  const csv = [headers.join(',')].concat(
    rows.map(t => headers.map(h => csvEscape(t[h])).join(','))
  ).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `cashtokens-ledger-page-offset-${state.offset}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast('CSV exported');
});

document.getElementById('themeToggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'light' ? 'dark' : 'light');
});

document.querySelector('.footer').addEventListener('click', (e) => {
  const el = e.target.closest('[data-copy]');
  if (el) copyToClipboard(el.dataset.copy, el.querySelector('.donate-label')?.textContent || 'Address');
});

document.querySelectorAll('thead th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    else { state.sortKey = key; state.sortDir = key === 'name' ? 'asc' : 'desc'; }
    renderTable();
  });
});

let searchDebounce;
document.getElementById('searchInput').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => { state.search = e.target.value; renderTable(); }, 150);
});
document.getElementById('typeFilter').addEventListener('change', (e) => { state.typeFilter = e.target.value; renderTable(); });
document.getElementById('holderFilter').addEventListener('change', (e) => { state.minHolders = Number(e.target.value); renderTable(); });
document.getElementById('activeOnlyChip').addEventListener('click', (e) => {
  state.activeOnly = !state.activeOnly; e.target.classList.toggle('active', state.activeOnly); renderTable();
});
document.getElementById('newWeekChip').addEventListener('click', (e) => {
  state.newWeekOnly = !state.newWeekOnly; e.target.classList.toggle('active', state.newWeekOnly); renderTable();
});

document.getElementById('prevPage').addEventListener('click', () => loadPage(state.offset - PAGE_SIZE));
document.getElementById('nextPage').addEventListener('click', () => loadPage(state.offset + PAGE_SIZE));

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

document.getElementById('refreshBtn').addEventListener('click', () => refreshAll(true));

async function refreshAll(force){
  const btn = document.getElementById('refreshBtn');
  btn.classList.add('spinning');
  document.getElementById('refreshLabel').textContent = 'Syncing…';
  if (force){ mem.clear(); try { Object.keys(localStorage).filter(k=>k.startsWith('ctl:')).forEach(k=>localStorage.removeItem(k)); } catch(e){} }
  state.samplePages = [];
  try {
    await Promise.all([
      renderHeaderStats(),
      renderGenesisChart(),
      renderTicker(),
      renderLeaderboards(),
      loadPage(state.offset),
    ]);
  } finally {
    btn.classList.remove('spinning');
    document.getElementById('refreshLabel').textContent = 'Refresh';
  }
}

// ---------- boot ----------
(function init(){
  initTheme();
  // show cached page instantly if we have one, then refresh in background
  const cachedFirst = cacheGet('page:0', LIST_CACHE_TTL);
  if (cachedFirst){
    state.rawPage = cachedFirst.tokens || [];
    state.total = cachedFirst.total;
    renderTable();
  }
  refreshAll(false);
  setInterval(() => refreshAll(false), 5 * 60 * 1000); // background sync every 5 min
})();
