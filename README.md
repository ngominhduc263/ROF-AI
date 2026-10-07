# ROF AI — modelrealoffake (rofai.net)

Web app that tests whether an LLM endpoint is the real model. The page is a single static file (`index.html`);
an optional zero-dependency Node relay (`server.mjs`) removes browser CORS limits, serves the BazaarLink probe API and adds upstream proxy support.

- **Connect** to any OpenAI-compatible (Chat Completions or Responses), Anthropic (Messages) or Google Gemini endpoint with a base URL + API key.
  The key lives only in the password field (memory). It is never written to storage, URLs, logs or reports.
- **Probe test** — runs the official [BazaarLink probe](https://bazaarlink.ai/probe) (identity assessment, evidence and API-integrity checks) after an explicit
  consent dialog, because the endpoint and key are sent to BazaarLink. The report shows BazaarLink's verdict and reasoning, the resolved identity,
  the score, and every check grouped by category (Chinese check names are translated; the original stays as a subtitle). Neutral control probes,
  errored probes and behaviour warnings are listed separately and never counted as passes.
- **HTML test (Cycling Pelican)** — the model builds an animated SVG pelican on a bicycle. The result renders in a sandboxed iframe next to the
  genuine reference, can be downloaded as `.html`, and is auto-checked (standalone document, inline SVG, CSS keyframes, no scripts / external assets,
  visible on desktop and mobile, animation actually moves).

## The agent harness (HTML test)

The HTML test runs the model inside a harness that follows the **minimal profile of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**:

| | |
| --- | --- |
| system prompt | `You are a helpful software engineer assistant.` — the task prompt is sent unchanged as the first user message |
| tools | `bash` and `str_replace_editor` (`view` / `create` / `str_replace` / `insert`), with DeepSeek Harness's tool descriptions |
| loop | send history + tool schemas → run every tool call → append the results → repeat until the model stops calling tools (≤ 30 model calls, within the time limit) |
| sampling | `temperature 1.0`, `top_p 0.95` (the Temperature field overrides the first) |
| session log | append-only, one JSON object per line; *Download .jsonl* in the page, and embedded in *Harness report* |
| workspace | `/workspace`; the deliverable is `/workspace/index.html` (the newest `.html`, or HTML in the final message, is used if the model picks another name) |

The "machine" is an **in-memory project directory with a small shell emulator** (heredocs, pipes, redirects, `&&`/`||`, `$VAR`, globbing, `ls cat grep find sed sort
head tail wc mkdir cp mv rm tee …`, no network, no loops/conditionals) — a model under test can never touch the computer running the page. It adds one command,
`render [file]`, which renders the page in the sandbox and reports the same checks the page shows, so the model can repair its own work. Each file the model
writes becomes a version you can open in the preview; a final render check runs on the last one.

When a run ends without a page, the page says why (empty reply after reasoning used the whole output limit, a tool call cut off mid-way, text-only
answer with no tool call, step limit, …) and the session log keeps a sample of the raw response for empty replies. A step that the provider cut off at its own
default limit — ROF sent none — is retried once with `max_tokens` 131,072 (stepping down to whatever the provider accepts) and that limit is used for the rest
of the run; the retry is written to the session log. A limit you set yourself is never overridden.

Native tool calling is implemented for all four protocols, streaming or not (DeepSeek's `reasoning_content`, Responses `encrypted_content`, Anthropic thinking
blocks and Gemini `thoughtSignature` are replayed as each provider requires). A model or gateway that refuses tool calling shows a hint; switch the harness to
**Text-only** (the toggle in the panel) to test it with the previous single-prompt loop (≤ 3 model calls, no tools).

*Compatible* means the profile and tool contract above; ROF AI is independent and is not affiliated with or endorsed by DeepSeek. Results from this harness are
not DeepSeek benchmark scores.

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

Open the page from the relay's address (`http://localhost:8787`; the relay's own requests carry no `Origin`, so Origin-restricted gateways such as ShareLLM work).
The page detects it and routes API calls through the relay (*Advanced → Connection route*: Auto / Direct / Via relay). The relay forwards the call server-side
and streams the answer back, so CORS never applies. The BazaarLink probe goes through it too.

The page reads `/api/health` and enables the optional fields only when the relay offers them: *Upstream proxy* (`host:port:user:pass`, kept in memory only)
and *Relay token* (when the relay was started with `RELAY_TOKEN`). Against any other relay both stay disabled.

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
| `PROBE_BASE` | where the BazaarLink probe API lives (default `https://bazaarlink.ai`) |

| route | |
| --- | --- |
| `GET /api/health` | `{app, relay, renderer, probe, tokenRequired, clientProxy, …}` |
| `POST /api/relay` | `{url, method, headers, body, proxy?}` → the provider's answer, streamed. Header `x-rof-source: provider` |
| `POST /api/probe/start`, `GET /api/probe/status?id=` | forwarded to `PROBE_BASE/api/probe/run[/{id}]`. Header `x-rof-source: bazaarlink` |

Answers produced by the relay itself carry `x-rof-source: rof-relay`, so the page never mistakes a provider's own 401/403 for a relay failure.
Relay safety: it listens on loopback by default, refuses cross-origin and DNS-rebinding requests, blocks private targets unless allowed, strips cookies/HSTS
from answers, and logs only `METHOD host/path → status` — never keys, bodies or query strings. Do not expose it publicly without `RELAY_TOKEN` (it refuses to start that way).

## The genuine reference (per model)

The left pane shows the genuine sample of **the model you selected**. Samples live in `<script type="application/json" id="rof-reference-pool">` (schema `rof-reference-pool/2`):
one entry per model, each with a `match` list of regular expressions tested against the Model field. Today there is one entry, **LUNA 6.0** (`openai/gpt-6-luna`, three genuine runs);
for any other model the pane says **"No comparison sample yet"**.

Only the `displayed` round of an entry is shown (the best one: passes every check and renders correctly). Every other run and round — including the ones that failed the automatic
checks — stays in the background, never displayed, with the HTML, checks, measurements and token usage (input / output / reasoning), so thinking budget and code can be compared
across genuine runs. A genuine model sometimes fails the checks, and a page that passes proves nothing by itself; a handful of samples per model is too few to judge from (aim for ~10).

To add a model, append an entry to `entries`. *Load reference file* replaces the pane temporarily (memory only) until the model changes.

## Notes

- Model output is rendered in an iframe with `sandbox="allow-scripts"` (no same-origin access) and a CSP that blocks all network
  access, so external libraries fail to load — exactly what the prompt forbids.
- The endpoint is used exactly as typed: only the method path (`/chat/completions`, `/responses`, `/messages`, `/models`) is appended to a
  base URL, and a URL that already ends with it is called verbatim. Nothing else (no `/v1`) is ever inserted; the exact URLs are shown under the field.
- The HTML test sends **no output limit by default** (*Unlimited by ROF*; Anthropic's required `max_tokens` is set to 100,000), except for the one-time retry
  described above. Pick a parameter name or enter a number in *Advanced* to force one. The total time limit defaults to 15 minutes (up to 30).
- The model picker always lists every model returned by the endpoint (with search), regardless of what is typed in the field.
- Results are heuristic: passing every check does not prove a relay is clean, and the agent harness has been exercised against scripted mock providers,
  not against every real one.
