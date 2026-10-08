#!/usr/bin/env node
/* ROF AI relay — zero dependencies, Node >= 18.
 *
 *   node server.mjs                      → http://localhost:8787  (serves index.html + the relay)
 *   PROXY=host:port:user:pass node server.mjs
 *   PROXY=socks5://host:port:user:pass node server.mjs
 *
 * Why: browsers enforce CORS and cannot use authenticated HTTP/SOCKS proxies. The page sends each API call to
 * /api/relay and this server performs it, optionally through an upstream proxy, then streams the answer back.
 * Nothing is logged except "METHOD host/path → status": never keys, bodies or query strings.
 *
 * Environment
 *   PORT                 listen port (default 8787)
 *   HOST                 listen address (default 127.0.0.1). A non-loopback HOST requires RELAY_TOKEN.
 *   PROXY                default upstream proxy: host:port[:user[:pass]] | user:pass@host:port, optional scheme
 *                        http:// or socks5:// (no scheme = auto-detect HTTP CONNECT, then SOCKS5)
 *   RELAY_TOKEN          if set, clients must send it (the page has a "Relay token" field)
 *   ALLOW_PRIVATE        1/0 — allow targets on private/loopback addresses (default 1 on loopback, else 0)
 *   ALLOW_CLIENT_PROXY   1/0 — allow the page to choose the proxy per request (default = ALLOW_PRIVATE)
 *   ALLOWED_HOSTS        extra comma-separated Host header values accepted (non-loopback deployments)
 *   IDLE_TIMEOUT_S       abort an upstream call that sends nothing for this long (default 600)
 *
 * Routes
 *   GET  /                    index.html
 *   GET  /api/health          {app, relay, renderer, tokenRequired, clientProxy, …} — the page reads this to enable the token / proxy fields
 *   POST /api/relay           {url, method, headers, body, proxy?} → the provider's answer, streamed (x-rof-source: provider)
 * Errors produced by the relay itself carry x-rof-source: rof-relay, so the page can tell them apart from a provider's own 401/403.
 */
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import dns from 'node:dns';
import crypto from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.RELAY_TOKEN || '';
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
const flag = (v, d) => v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v);
const ALLOW_PRIVATE = flag(process.env.ALLOW_PRIVATE, LOOPBACK);
const ALLOW_CLIENT_PROXY = flag(process.env.ALLOW_CLIENT_PROXY, ALLOW_PRIVATE);
const IDLE_MS = (Number(process.env.IDLE_TIMEOUT_S) || 600) * 1000;
const MAX_BODY = 16 * 1024 * 1024;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const EXTRA_HOSTS = (process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

if (!LOOPBACK && !TOKEN){
  console.error('Refusing to listen on a non-loopback address without RELAY_TOKEN — that would be an open proxy.\n  Example: HOST=0.0.0.0 RELAY_TOKEN=choose-a-long-secret node server.mjs');
  process.exit(1);
}

/* ---------------------------------------------------------------- proxy ---- */
export function parseProxy(input){
  let s = String(input || '').trim();
  if (!s) return null;
  let kind = 'auto';
  const m = /^([a-z0-9]+):\/\/(.*)$/i.exec(s);
  if (m){
    const scheme = m[1].toLowerCase();
    if (scheme === 'http') kind = 'http';
    else if (scheme === 'socks5' || scheme === 'socks5h') kind = 'socks5';
    else throw new Error(`Unsupported proxy scheme "${scheme}://" — use http:// or socks5://.`);
    s = m[2];
  }
  s = s.replace(/\/+$/, '');
  let host, port, user = '', pass = '';
  const at = s.lastIndexOf('@');
  if (at >= 0){                                      // user:pass@host:port
    const cred = s.slice(0, at), hp = s.slice(at + 1).split(':');
    host = hp[0]; port = hp[1];
    const i = cred.indexOf(':');
    user = decodeURIComponent(i < 0 ? cred : cred.slice(0, i)); pass = i < 0 ? '' : decodeURIComponent(cred.slice(i + 1));
  } else {                                           // host:port[:user[:pass]] — the password may itself contain ':'
    const parts = s.split(':');
    host = parts[0]; port = parts[1];
    if (parts.length > 2){ user = parts[2]; pass = parts.slice(3).join(':'); }
  }
  if (!host || !/^\d{1,5}$/.test(port || '') || Number(port) > 65535) throw new Error('Proxy must look like host:port:user:pass');
  return { kind, host, port: Number(port), user, pass, label: `${host}:${port}` };
}
const proxyError = (message, extra = {}) => Object.assign(new Error(message), { proxy: true }, extra);

function viaHttpConnect(proxy, host, port, timeout){
  return new Promise((resolve, reject) => {
    const headers = { Host: `${host}:${port}` };
    if (proxy.user || proxy.pass) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${proxy.user}:${proxy.pass}`).toString('base64');
    const req = http.request({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: `${host}:${port}`, headers });
    req.setTimeout(timeout, () => req.destroy(proxyError('Proxy did not answer (timeout).', { notHttp: true })));
    req.once('connect', (res, socket) => {
      if (res.statusCode === 200){ socket.setTimeout(0); resolve(socket); return; }
      socket.destroy();
      reject(proxyError(res.statusCode === 407 ? 'Proxy rejected the login (HTTP 407) — check user:pass.' : `Proxy refused the tunnel (HTTP ${res.statusCode}).`));
    });
    req.once('error', e => {
      const notHttp = /^HPE_/.test(e.code || '') || e.code === 'ECONNRESET' || /socket hang up/i.test(e.message);
      reject(e.proxy ? e : proxyError(e.code === 'ECONNREFUSED' ? `Proxy ${proxy.label} refused the connection.` : e.code === 'ENOTFOUND' ? `Couldn't resolve the proxy host ${proxy.host}.` : `Proxy error: ${e.message}`, { notHttp, code: e.code }));
    });
    req.end();
  });
}

function viaSocks5(proxy, host, port, timeout){
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxy.port, proxy.host);
    let stage = 0, buf = Buffer.alloc(0), settled = false;
    const fail = e => { if (settled) return; settled = true; sock.destroy(); reject(e); };
    sock.setTimeout(timeout, () => fail(proxyError('SOCKS5 proxy did not answer (timeout).')));
    sock.once('error', e => fail(proxyError(e.code === 'ECONNREFUSED' ? `Proxy ${proxy.label} refused the connection.` : e.code === 'ENOTFOUND' ? `Couldn't resolve the proxy host ${proxy.host}.` : `Proxy error: ${e.message}`)));
    sock.once('close', () => fail(proxyError('SOCKS5 proxy closed the connection.')));
    sock.once('connect', () => sock.write(Buffer.from(proxy.user || proxy.pass ? [5, 2, 0, 2] : [5, 1, 0])));
    const sendConnect = () => {
      const h = Buffer.from(host);
      sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]));
    };
    const onData = d => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0){
        if (buf.length < 2) return;
        if (buf[0] !== 5) return fail(proxyError('That is not a SOCKS5 proxy.'));
        const method = buf[1]; buf = buf.subarray(2);
        if (method === 2){
          const u = Buffer.from(proxy.user), p = Buffer.from(proxy.pass);
          sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p])); stage = 1;
        } else if (method === 0){ sendConnect(); stage = 2; }
        else return fail(proxyError('SOCKS5 proxy accepts no login method we support.'));
      }
      if (stage === 1){
        if (buf.length < 2) return;
        if (buf[1] !== 0) return fail(proxyError('SOCKS5 proxy rejected the login — check user:pass.'));
        buf = buf.subarray(2); sendConnect(); stage = 2;
      }
      if (stage === 2){
        if (buf.length < 5) return;
        if (buf[1] !== 0) return fail(proxyError(`SOCKS5 proxy could not reach ${host}:${port} (code ${buf[1]}).`));
        const need = buf[3] === 1 ? 10 : buf[3] === 4 ? 22 : 7 + buf[4];
        if (buf.length < need) return;
        sock.removeListener('data', onData); sock.removeAllListeners('close'); sock.removeAllListeners('error'); sock.setTimeout(0);
        const rest = buf.subarray(need); if (rest.length) sock.unshift(rest);
        settled = true; resolve(sock);
      }
    };
    sock.on('data', onData);
  });
}

async function openTunnel(proxy, host, port){
  if (proxy.kind === 'http') return viaHttpConnect(proxy, host, port, 20000);
  if (proxy.kind === 'socks5') return viaSocks5(proxy, host, port, 20000);
  try { return await viaHttpConnect(proxy, host, port, 8000); }                       // unknown type: try HTTP first …
  catch (e){ if (!e.notHttp) throw e; return viaSocks5(proxy, host, port, 12000); }    // … then SOCKS5
}

function tunnelAgent(isHttps, proxy){
  const Base = isHttps ? https.Agent : http.Agent;
  return new (class extends Base {
    createConnection(options, cb){
      const host = options.host || options.hostname, port = Number(options.port) || (isHttps ? 443 : 80);
      openTunnel(proxy, host, port).then(sock => {
        if (!isHttps) return cb(null, sock);
        const secure = tls.connect({ socket: sock, servername: net.isIP(host) ? undefined : (options.servername || host), ALPNProtocols: ['http/1.1'] });
        secure.once('secureConnect', () => cb(null, secure));
        secure.once('error', cb);
      }, cb);
    }
  })({ keepAlive: false });
}

/* ------------------------------------------------------------------ SSRF ---- */
export function isPrivateIp(ip){
  if (net.isIPv4(ip)){
    const [a, b, c] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)){
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    if (l.startsWith('::ffff:')){
      const rest = l.slice(7);
      if (net.isIPv4(rest)) return isPrivateIp(rest);
      const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
      if (m){ const n = (parseInt(m[1], 16) << 16) | parseInt(m[2], 16); return isPrivateIp([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')); }
      return true;
    }
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
  }
  return true;
}
function guardedLookup(hostname, options, cb){            // used for the real connection, so DNS rebinding can't slip past the check
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return cb(err, address, family);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (list.some(a => isPrivateIp(a.address))) return cb(Object.assign(new Error(`Blocked: ${hostname} points to a private address (set ALLOW_PRIVATE=1 to allow).`), { code: 'ERELAY_PRIVATE' }));
    cb(null, address, family);
  });
}

/* --------------------------------------------------------------- helpers ---- */
const DROP_REQ = /^(host|connection|content-length|transfer-encoding|accept-encoding|origin|referer|cookie|upgrade|te|trailer|keep-alive|proxy-.*|sec-.*|x-rof-.*)$/i;
const DROP_RES = new Set(['transfer-encoding', 'connection', 'keep-alive', 'set-cookie', 'strict-transport-security', 'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'clear-site-data', 'public-key-pins', 'alt-svc', 'proxy-authenticate', 'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy', 'report-to', 'nel']);

function relayError(res, status, message, code){
  if (res.headersSent){ res.destroy(); return; }
  const body = JSON.stringify({ error: { message, code: code || 'rof_relay' } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-rof-relay-error': '1', 'x-rof-source': 'rof-relay', 'cache-control': 'no-store' });
  res.end(body);
}
function explain(e, target, proxy){
  if (e.proxy) return e.message;                           // already worded by the tunnel code (proxy down, bad login, …)
  const where = proxy ? ` (through proxy ${proxy.label})` : '';
  switch (e.code){
    case 'ENOTFOUND': return `Couldn't resolve ${target.hostname}${where}.`;
    case 'ECONNREFUSED': return `${target.hostname}:${target.port || (target.protocol === 'https:' ? 443 : 80)} refused the connection${where}.`;
    case 'ECONNRESET': return `The connection was reset by ${target.hostname}${where}.`;
    case 'ETIMEDOUT': case 'ESOCKETTIMEDOUT': return `Timed out talking to ${target.hostname}${where}.`;
    case 'ERELAY_PRIVATE': return e.message;
    default:
      if (/CERT|TLS|SSL|self[- ]signed|certificate/i.test(`${e.code} ${e.message}`)) return `TLS certificate problem with ${target.hostname}: ${e.message}`;
      return `${e.message}${where}`;
  }
}
function tokenOk(given){
  const a = crypto.createHash('sha256').update(String(given || '')).digest(), b = crypto.createHash('sha256').update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}
function hostAllowed(req){
  const h = String(req.headers.host || '').toLowerCase();
  if (EXTRA_HOSTS.includes(h)) return true;
  if (!LOOPBACK) return true;                              // protected by RELAY_TOKEN instead
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h);   // blocks DNS-rebinding against a local relay
}
function sameOrigin(req){
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); } catch { return false; }
}
function readJson(req, limit){
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', d => { size += d.length; if (size > limit){ reject(Object.assign(new Error('Request too large.'), { status: 413 })); req.destroy(); } else chunks.push(d); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('Body must be JSON.'), { status: 400 })); } });
    req.on('error', reject);
  });
}

/* ----------------------------------------------------------------- relay ---- */
function guard(req, res){
  if (!sameOrigin(req)){ relayError(res, 403, 'Cross-origin request refused.'); return false; }
  if (req.headers['x-rof-client'] !== '1'){ relayError(res, 400, 'Missing X-ROF-Client header.'); return false; }
  if (TOKEN && !tokenOk(req.headers['x-rof-token'])){ relayError(res, 401, 'Relay token missing or wrong.', 'rof_auth'); return false; }
  return true;
}
async function handleRelay(req, res){
  if (!guard(req, res)) return;
  let job;
  try { job = await readJson(req, MAX_BODY); } catch (e){ return relayError(res, e.status || 400, e.message); }
  return forward(job, res, 'provider');
}
/* performs one upstream call and streams the answer back; `source` tells the page whose answer it is */
async function forward(job, res, source){
  let target;
  try { target = new URL(String(job.url)); } catch { return relayError(res, 400, 'Invalid target URL.'); }
  if (!/^https?:$/.test(target.protocol)) return relayError(res, 400, 'Only http(s) targets are allowed.');
  if (target.username || target.password) return relayError(res, 400, 'Credentials inside the URL are not accepted.');
  const method = String(job.method || 'POST').toUpperCase();
  if (!['GET', 'POST'].includes(method)) return relayError(res, 400, 'Only GET and POST are allowed.');

  let proxy = DEFAULT_PROXY;
  if (job.proxy){
    if (!ALLOW_CLIENT_PROXY) return relayError(res, 403, 'This relay does not accept a per-request proxy — set PROXY on the server instead.');
    try { proxy = parseProxy(job.proxy); } catch (e){ return relayError(res, 400, e.message); }
  }
  if (!proxy && !ALLOW_PRIVATE && net.isIP(target.hostname.replace(/^\[|\]$/g, '')) && isPrivateIp(target.hostname.replace(/^\[|\]$/g, ''))) return relayError(res, 403, `Blocked: ${target.hostname} is a private address (set ALLOW_PRIVATE=1 to allow).`);

  const headers = { 'accept-encoding': 'identity' };
  for (const [k, v] of Object.entries(job.headers && typeof job.headers === 'object' ? job.headers : {}))
    if (typeof v === 'string' && !DROP_REQ.test(k)) headers[k.toLowerCase()] = v;
  headers['user-agent'] ||= 'Mozilla/5.0 (compatible; ROF-AI-relay/1.0)';
  const payload = job.body == null ? null : Buffer.from(typeof job.body === 'string' ? job.body : JSON.stringify(job.body));
  if (payload) headers['content-length'] = String(payload.length);

  const isHttps = target.protocol === 'https:';
  const opts = { protocol: target.protocol, hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || (isHttps ? 443 : 80), path: target.pathname + target.search, method, headers };
  if (proxy) opts.agent = tunnelAgent(isHttps, proxy);
  else { opts.agent = false; if (!ALLOW_PRIVATE) opts.lookup = guardedLookup; }

  const log = status => console.log(`[relay] ${method} ${target.host}${target.pathname} → ${status}${proxy ? ` via ${proxy.label}` : ''}`);
  let up;
  try {
    up = (isHttps ? https : http).request(opts, upRes => {
      const out = {};
      for (const [k, v] of Object.entries(upRes.headers)) if (!DROP_RES.has(k)) out[k] = v;
      out['x-rof-source'] = source;
      out['x-rof-via'] = proxy ? 'relay+proxy' : 'relay';
      out['cache-control'] = 'no-store';
      res.writeHead(upRes.statusCode || 502, out);
      res.flushHeaders?.();
      log(upRes.statusCode);
      upRes.pipe(res);
      upRes.on('error', () => res.destroy());
    });
  } catch (e){ return relayError(res, 400, `Bad request headers: ${e.message}`); }
  up.setTimeout(IDLE_MS, () => up.destroy(Object.assign(new Error('Upstream idle timeout'), { code: 'ETIMEDOUT' })));
  up.on('error', e => { log(`error ${e.code || ''}`.trim()); relayError(res, 502, explain(e, target, proxy), e.code); });
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });     // browser left (Stop button): drop the upstream call too
  if (payload) up.write(payload);
  up.end();
}

let DEFAULT_PROXY = null;
try { DEFAULT_PROXY = parseProxy(process.env.PROXY); } catch (e){ console.error('PROXY: ' + e.message); process.exit(1); }

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (!hostAllowed(req)){ res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('Forbidden host'); }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')){
      try {
        const file = await readFile(path.join(ROOT, 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
        return res.end(file);
      } catch { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('index.html not found next to server.mjs'); }
    }
    if (req.method === 'GET' && url.pathname === '/api/health'){
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ app: 'rof-ai', relay: true, renderer: 'browser', tokenRequired: !!TOKEN, proxy: DEFAULT_PROXY?.label ?? null, proxyKind: DEFAULT_PROXY?.kind ?? null, clientProxy: ALLOW_CLIENT_PROXY, privateTargets: ALLOW_PRIVATE }));
    }
    if (req.method === 'POST' && url.pathname === '/api/relay') return await handleRelay(req, res);
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found');
  } catch (e){
    console.error('[relay] internal error:', e.message);
    relayError(res, 500, 'Relay internal error.');
  }
});
server.requestTimeout = 0;                                  // long generations must not be cut by Node's request timeout
server.headersTimeout = 30000;
server.on('clientError', (e, socket) => socket.destroy());

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log(`ROF AI relay ready → http://${shown}:${PORT}`);
  console.log(`  upstream proxy : ${DEFAULT_PROXY ? `${DEFAULT_PROXY.label} (${DEFAULT_PROXY.kind === 'auto' ? 'auto-detect http/socks5' : DEFAULT_PROXY.kind})` : 'none (set PROXY=host:port:user:pass, or fill it in on the page)'}`);
  console.log(`  private targets: ${ALLOW_PRIVATE ? 'allowed' : 'blocked'}   token: ${TOKEN ? 'required' : 'not required'}`);
});
