/* ROF AI relay for Cloudflare Workers — serves the page (static assets) and the same /api protocol as server.mjs.
 *
 *   GET  /api/health   {app, relay, renderer, tokenRequired, clientProxy, privateTargets}
 *   POST /api/relay    {url, method, headers, body} → the provider's answer, streamed (x-rof-source: provider)
 *
 * Why: browsers enforce CORS, and some gateways answer 403 to every Origin but their own. The page sends each API call here and this Worker
 * performs it from Cloudflare's network. Nothing is stored or logged. Keys pass through in memory only.
 *
 * Environment:  RELAY_TOKEN (secret, optional but recommended on a public URL — the page then shows a "Relay token" field)
 *               ALLOW_PRIVATE=1 only for local tests.
 * Not supported here (needs raw TCP): per-request upstream proxies (host:port:user:pass). Use server.mjs for those.
 */
const MAX_BODY = 16 * 1024 * 1024;
const DROP_REQ = /^(host|connection|content-length|transfer-encoding|accept-encoding|origin|referer|cookie|upgrade|te|trailer|keep-alive|proxy-.*|sec-.*|cf-.*|x-forwarded-.*|x-real-ip|true-client-ip|x-rof-.*)$/i;
const DROP_RES = new Set(['transfer-encoding', 'connection', 'keep-alive', 'set-cookie', 'strict-transport-security', 'content-security-policy', 'content-security-policy-report-only', 'x-frame-options',
  'clear-site-data', 'public-key-pins', 'alt-svc', 'proxy-authenticate', 'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy', 'report-to', 'nel', 'content-encoding', 'content-length']);

const json = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });
const relayError = (status, message, code = 'rof_relay') => json(status, { error: { message, code } }, { 'x-rof-relay-error': '1', 'x-rof-source': 'rof-relay' });

function privateHost(h){
  h = h.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m){ const [a, b] = [+m[1], +m[2]]; return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224; }
  if (h.includes(':')) return h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:');
  return false;
}
async function tokenOk(given, expected){
  const enc = new TextEncoder(), [a, b] = await Promise.all([given, expected].map(v => crypto.subtle.digest('SHA-256', enc.encode(String(v ?? '')))));
  const x = new Uint8Array(a), y = new Uint8Array(b); let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]; return d === 0;
}
const sameOrigin = req => { const o = req.headers.get('origin'); if (!o) return true; try { return new URL(o).host === new URL(req.url).host; } catch { return false; } };

async function relay(req, env){
  if (!sameOrigin(req)) return relayError(403, 'Cross-origin request refused.');
  if (req.headers.get('x-rof-client') !== '1') return relayError(400, 'Missing X-ROF-Client header.');
  if (env.RELAY_TOKEN && !(await tokenOk(req.headers.get('x-rof-token'), env.RELAY_TOKEN))) return relayError(401, 'Relay token missing or wrong.', 'rof_auth');
  if (Number(req.headers.get('content-length')) > MAX_BODY) return relayError(413, 'Request too large.');
  let job; try { job = JSON.parse(await req.text() || '{}'); } catch { return relayError(400, 'Body must be JSON.'); }
  let target; try { target = new URL(String(job.url)); } catch { return relayError(400, 'Invalid target URL.'); }
  if (!/^https?:$/.test(target.protocol)) return relayError(400, 'Only http(s) targets are allowed.');
  if (target.username || target.password) return relayError(400, 'Credentials inside the URL are not accepted.');
  if (target.host === new URL(req.url).host) return relayError(400, 'The relay cannot call itself.');
  if (!env.ALLOW_PRIVATE && privateHost(target.hostname)) return relayError(403, `Blocked: ${target.hostname} is a private or local address.`);
  const method = String(job.method || 'POST').toUpperCase();
  if (!['GET', 'POST'].includes(method)) return relayError(400, 'Only GET and POST are allowed.');
  if (job.proxy) return relayError(403, 'This relay cannot use an upstream proxy (Cloudflare Workers have no raw TCP). Run server.mjs for that.');

  const headers = new Headers({ 'accept-encoding': 'identity' });
  for (const [k, v] of Object.entries(job.headers && typeof job.headers === 'object' ? job.headers : {})) if (typeof v === 'string' && !DROP_REQ.test(k)) { try { headers.set(k, v); } catch {} }
  if (!headers.has('user-agent')) headers.set('user-agent', 'Mozilla/5.0 (compatible; ROF-AI-relay/1.0)');
  const body = job.body == null ? undefined : typeof job.body === 'string' ? job.body : JSON.stringify(job.body);
  let up;
  try { up = await fetch(target.href, { method, headers, body: method === 'GET' ? undefined : body, redirect: 'manual', signal: req.signal }); }
  catch (e){ return relayError(502, `Couldn't reach ${target.hostname}: ${String(e?.message || e).slice(0, 200)}`, 'ECONNRESET'); }
  const out = new Headers(); for (const [k, v] of up.headers) if (!DROP_RES.has(k.toLowerCase())) out.set(k, v);
  out.set('x-rof-source', 'provider'); out.set('x-rof-via', 'cloudflare'); out.set('cache-control', 'no-store');
  if (req.cf?.colo) out.set('x-rof-colo', String(req.cf.colo));       // which Cloudflare data center sent the call — the page names it when a provider refuses the relay's address
  return new Response(up.body, { status: up.status, statusText: up.statusText, headers: out });       // streamed straight through
}

export default {
  async fetch(req, env){
    const url = new URL(req.url);
    if (url.pathname === '/api/health' && req.method === 'GET') return json(200, { app: 'rof-ai', relay: true, renderer: 'browser', tokenRequired: !!env.RELAY_TOKEN, clientProxy: false, privateTargets: !!env.ALLOW_PRIVATE });
    if (url.pathname === '/api/relay'){ if (req.method !== 'POST') return relayError(405, 'Use POST.'); return relay(req, env); }
    if (url.pathname.startsWith('/api/')) return relayError(404, 'Not found.');
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response('ROF AI relay is running. Add the page as a static asset (see cloudflare/README.md).', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
};
