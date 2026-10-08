# ROF AI on Cloudflare Workers

One Worker serves the page and the relay (`/api/health`, `/api/relay`), so gateways that refuse every Origin but their own (ShareLLM…) work from the hosted page.
The config is the `wrangler.jsonc` at the **repository root**; the page that gets served is `cloudflare/public/index.html` (a copy of the root `index.html`).

## Deploy from your computer
```bash
npm run cf:prepare              # copies index.html → cloudflare/public/index.html
npx wrangler login              # once
npx wrangler secret put RELAY_TOKEN   # recommended on a public URL (the page then asks for the token)
npx wrangler deploy
```
(`npm run cf:deploy` does the copy and the deploy.)

## Deploy from Cloudflare "Workers Builds" (connected to GitHub)
- Root directory: leave empty (the repository root). Build command: `npm run cf:prepare` (optional — the copy is committed). Deploy command: `npx wrangler deploy`.
- The Worker name in the dashboard must equal `name` in `wrangler.jsonc` (`rof-ai`). If your Worker has another name, edit `name` or use `npx wrangler deploy --name <your-worker>`.
- Add `RELAY_TOKEN` under Settings → Variables and Secrets (type: Secret).

## Notes
- If `/` answers 404 with an empty page, the page is not in `cloudflare/public/index.html` or was deployed without the Worker config.
- Without `RELAY_TOKEN` anyone who finds the URL can send requests through your Worker (and spend your Cloudflare quota). Set it.
- Keys pass through the Worker in memory and are never stored or logged. If you prefer that no third party sees them, use the page without the relay (providers that allow CORS) or run `node server.mjs` locally.
- Anthropic answers `403 Request not allowed` when the request leaves from an address it does not serve, and through this Worker that address is the Cloudflare data center that ran it (the page shows it, e.g. `HKG`; it comes from the `x-rof-colo` response header). On the automatic route the page retries once straight from the browser and remembers it; with the route fixed to *Relay* it shows the explanation instead. Choose **Direct** for `api.anthropic.com` (it accepts browser calls). Use Anthropic only from regions it supports — do not route around its regional rules.
- Not available here: per-request upstream proxies (`host:port:user:pass`) — Workers have no raw TCP. Use `server.mjs`.
- To update the page: `npm run cf:prepare`, commit `cloudflare/public/index.html`, push (or run `wrangler deploy`).
