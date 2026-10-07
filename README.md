# ROF AI — modelrealoffake (rofai.net)

Single-file web app that tests whether an LLM endpoint is the real model.
Open `index.html` in a browser or host it as a static site — there is no build step and no backend.

- **Connect** to any OpenAI-compatible, Anthropic (Messages) or Google Gemini endpoint with a base URL + API key.
  The key lives only in the password field (memory). It is never written to storage, URLs or reports.
- **Probe test** — 12 checks: handshake, model echo, self-identification, reasoning sanity, hidden-prompt token overhead,
  token accounting, `max_tokens`, system-prompt handling, hidden system prompt, echo integrity, long-context recall, SSE streaming.
- **HTML test (Cycling Pelican)** — the model writes an animated SVG pelican on a bicycle; the result renders in a sandboxed
  iframe next to the genuine reference, can be downloaded as `.html`, and is auto-checked against the prompt's constraints.

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
- Calls are made straight from the browser, so the provider must allow CORS. Open the file in a normal browser tab —
  preview panes/sandboxes block outside requests. The base URL is used exactly as typed (`…/chat/completions` is appended);
  `/v1` is only tried as a fallback, and a bare-bones request body is retried when a strict relay refuses extra parameters.
- A forward proxy in `host:port:user:pass` form cannot be used from a plain web page (browsers can't tunnel through
  authenticated HTTP/SOCKS proxies). The *CORS proxy prefix* field expects the URL of a small self-hosted relay instead
  (your key then passes through it).
- Results are heuristic: passing every check does not prove a relay is clean.
