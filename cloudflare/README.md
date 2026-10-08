# ROF AI on Cloudflare Workers

One Worker serves the page and the relay (`/api/health`, `/api/relay`), so gateways that refuse every Origin but their own (ShareLLM…) work from the hosted page.

```bash
cd cloudflare
mkdir -p public && cp ../index.html public/index.html   # the page must be called index.html
npx wrangler login                                      # once
npx wrangler secret put RELAY_TOKEN                     # recommended on a public URL (the page then asks for the token)
npx wrangler deploy
```

Open the address `wrangler deploy` prints (`https://rofai.<your-subdomain>.workers.dev`). If `/` answers 404 with an empty page, the page is not in `public/index.html` or was not deployed with the Worker.

- Without `RELAY_TOKEN` anyone who finds the URL can send requests through your Worker (and spend your Cloudflare quota). Set it.
- Keys pass through the Worker in memory and are never stored or logged. If you prefer that no third party sees them, use the page without the relay (providers that allow CORS) or run `node server.mjs` locally.
- Not available here: per-request upstream proxies (`host:port:user:pass`) — Workers have no raw TCP. Use `server.mjs`.
- To update the page: copy the new `index.html` into `public/` and run `npx wrangler deploy` again.
