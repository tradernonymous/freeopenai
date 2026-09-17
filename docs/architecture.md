# Architecture

[← Back to README](../README.md)

<a name="architecture"></a>

<img src="readme/banner-architecture.svg" alt="Architecture" width="100%">

<br>

**Request path.** Browser loads `index.html` → Puter.js authenticates the user and meters usage → the page calls `puter.ai.chat()` directly from the browser → the reply streams back into the chat. When a direct-provider key is configured, the chat goes through `server.js`, which streams the upstream SSE body straight to the client so tokens still appear one at a time without a full-page wait. `server.js` caches the model catalogue in memory to avoid re-fetching on every provider switch.

**What a load actually transfers.** The whole UI is one file — a 520KB `index.html` — plus a 208KB `chatlib.js`, and both used to go out raw on every visit. Most of that is whitespace and the long comments this codebase is written in, so it compresses about seven to one: a first load now transfers **175KB instead of 728KB**. Brotli when the browser takes it, gzip otherwise, identity when it takes neither — parsed rather than pattern-matched, because a `;q=0` is a refusal and sending a body the client cannot read is worse than sending a big one. Each encoding is produced once and kept in memory, keyed on the file's mtime and size, so a 520KB compress does not happen per request and a deploy invalidates it without anyone remembering to.

Every static response also carries an **ETag**. `Cache-Control: no-cache` is right here and is not what it sounds like — it means revalidate before reuse, not never store, which matters because the whole UI ships inside `index.html` and a copy reused blind would run yesterday's code after a deploy. But with no validator to revalidate *against*, every reload was a full download of bytes the browser already held. Now an unchanged deploy answers `304` with no body at all. `npm test` checks this over a real socket: that the compressed bodies decode back to the exact page, that `Content-Length` describes the encoded body rather than the original, that `HEAD` agrees with `GET`, that the single-page fallback shares the page's validator, and that a missing `.js` is still a 404 rather than HTML that would fail to parse.

<details>
<summary><b>🗂️ Project layout</b> &nbsp;·&nbsp; click to expand</summary>

```text
index.html      chat UI: markup, styles, and all client-side logic
login.html      username/password screen, shown once AUTH_USER_1/AUTH_PASS_1 are set
chatlib.js      shared, dependency-free logic (model list, HTML escaping,
                prompt budgeting) — used by the page and by the tests
attachment-helpers.js
                every attachment decision, and the only copy of them: what a
                picked file becomes (image, document or text), whether its bytes
                are text, what a picture may be sent as, and what stored history
                keeps — loaded by the page as its own script and required by the
                tests, so both run the same code
auth.js         session-cookie signing and credential checking
github.js       AES-256-GCM sealing for the stored GitHub token
server.js       zero-dependency static server + the login and GitHub routes
test/           node --test suite for server.js, chatlib.js, auth.js, github.js,
                the GitHub tools, the conversation store, and a boot check that
                runs index.html's script against a stub DOM
.github/        CI: lint + tests on every push and a PR, and the browser smoke,
                which renders the page in headless Chrome and is the only check
                that can see the wiring between a rule and the DOM it changes
```

</details>

<br>

<img src="readme/divider.svg" alt="" width="100%">
