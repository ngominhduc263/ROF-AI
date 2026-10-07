# ROF AI — modelrealoffake (rofai.net)

Web app that tests whether an LLM endpoint is the real model. The page is a single static file (`index.html`);
an optional zero-dependency Node relay (`server.mjs`) removes browser CORS limits and adds upstream proxy support.

- **Connect** to any OpenAI-compatible, Anthropic (Messages) or Google Gemini endpoint with a base URL + API key.
  The key lives only in the password field (memory). It is never written to storage, URLs or reports.
- **Probe test** — 12 checks: handshake, model echo, self-identification, reasoning sanity, hidden-prompt token overhead,
  token accounting, `max_tokens`, system-prompt handling, hidden system prompt, echo integrity, long-context recall, SSE streaming.
- **HTML test (Cycling Pelican)** — the model writes an animated SVG pelican on a bicycle; the result renders in a sandboxed
  iframe next to the genuine reference, can be downloaded as `.html`, and is auto-checked against the prompt's constraints.
  Reasoning models that burn their whole budget thinking are retried with a larger budget, and an empty answer is explained
  (finish reason, token counts, reasoning length).

## Two ways to run

**1. Static (no server).** Open `index.html` in a normal browser tab, or host it on any static host.
Calls go straight from the browser, so the provider must allow CORS. Preview panes/sandboxes block outside requests.
Some gateways answer **403 to every `Origin` except their own site and `http://localhost`** (ShareLLM does this, verified):
a page opened from a file (`Origin: null`) or hosted on another domain can never call them — use the relay below.

**2. With the relay (recommended when CORS or a proxy is a problem).**

```bash
node server.mjs                       # → http://localhost:8787   (Node ≥ 18, nothing to install)
PROXY=host:port:user:pass node server.mjs
PROXY=socks5://host:port:user:pass node server.mjs
```

Open the page from the relay's address (`http://localhost:8787`; the relay's own requests carry no `Origin`, so Origin-restricted gateways such as ShareLLM work). The page detects it and routes API calls through `/api/relay`
(*Advanced → Connection route*: Auto / Direct / Via relay). The relay forwards the call server-side and streams the answer back,
so CORS never applies. You can also type the proxy into the page (*Advanced → Upstream proxy*, kept in memory only).

Proxy format is `host:port:user:pass` (a password containing `:` is fine; `user:pass@host:port` also works).
With no scheme the relay tries an HTTP `CONNECT` tunnel first and falls back to SOCKS5; add `http://` or `socks5://` to force one.

| env | meaning |
| --- | --- |
| `PORT` / `HOST` | listen address, default `127.0.0.1:8787` |
| `PROXY` | default upstream proxy |
| `RELAY_TOKEN` | clients must send it (*Advanced → Relay token*). **Required** when `HOST` is not loopback |
| `ALLOW_PRIVATE` | allow targets on private/loopback addresses (default on for loopback, off otherwise) |
| `ALLOW_CLIENT_PROXY` | let the page choose the proxy per request (default = `ALLOW_PRIVATE`) |
| `ALLOWED_HOSTS` | extra accepted `Host` headers for non-loopback deployments |
| `IDLE_TIMEOUT_S` | abort an upstream call that sends nothing for this long (default 600) |

Relay safety: it listens on loopback by default, refuses cross-origin and DNS-rebinding requests, blocks private targets unless
allowed, strips cookies/HSTS from answers, and logs only `METHOD host/path → status` — never keys, bodies or query strings.
Do not expose it publicly without `RELAY_TOKEN` (it refuses to start that way).

## Adding the genuine reference file

The left pane currently shows a **placeholder sample**. To use the real model's file, open `index.html`, find

```html
<script type="text/plain" id="rof-reference-html">
```

and replace everything between that tag and its closing `</script>` with the genuine HTML (paste it raw; write `<\/script>`
if the file itself contains `</script>`). The "Placeholder sample" badge disappears automatically.
You can also try a file without editing the source via the **Load reference file** button (kept in memory only).

## Notes

- Model output is rendered in an iframe with `sandbox="allow-scripts"` (no same-origin access) and a CSP that blocks all network
  access, so external libraries fail to load — exactly what the prompt forbids.
- The endpoint is used exactly as typed: only the method path (`/chat/completions`, `/messages`, `/models`) is appended to a
  base URL, and a URL that already ends with it is called verbatim. Nothing else (no `/v1`) is ever inserted; the exact URLs are
  shown under the field. If a strict relay refuses the response, the request is retried once with a bare-bones body
  (no `temperature` / `stream_options`).
- The HTML test sends **no practical output limit**: it asks for 131,072 tokens and, if the provider rejects that (OpenAI, Anthropic,
  Gemini, OpenRouter credit limits, …), steps down automatically to the cap it names (or halves until accepted). Type a number into
  *Max output tokens* to force a limit, or choose *Don't send a limit* to omit the field (OpenAI format).
- The model picker always lists every model returned by the endpoint (with search), regardless of what is typed in the field.
- Results are heuristic: passing every check does not prove a relay is clean.
