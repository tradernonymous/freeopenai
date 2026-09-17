---
paths:
  - "server.js"
  - "auth.js"
  - "github.js"
  - "provider-routing.js"
  - "image-store.js"
  - "test/**"
---

# Server rules

- No runtime dependencies. Use Node built-ins (`http`, `crypto`, `fetch`, `node:test`).
- Every `/api/*` route except `PUBLIC_PATHS` sits behind the login gate; keep the public set minimal.
- Errors are JSON `{ error: string }`; provider errors go through `describeProviderError`, never raw upstream bodies with keys.
- Providers are declared in `LLM_PROVIDERS` (key env var, base URL, models, image block). `/api/health` must never reveal keys, URLs or which keys are set.
- Server-side fetches of user-supplied URLs go through the private-address guard (SSRF).
- Add or update a `test/*.test.js` for every behaviour change; tests stub upstreams with a local `http.createServer`, never the real internet.
- The Android app and the web page both parse these responses: changing a response shape is a migration.
