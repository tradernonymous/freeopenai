# ADR 0002: logic both surfaces use lives in `shared/`

Status: accepted (2026-09-22), first module moved.

## Context

The same rules exist two or three times: the web app's `app.js`, `chatlib.js` and `server.js` monoliths, the desktop's `desktop/src/*.js` modules, and the Android app's Kotlin. The desktop audit named this triple implementation the main maintainability risk (roadmap 6.10): a fix in one copy leaves the others wrong.

## Decision

Pure logic that more than one surface can run lives in a top-level `shared/` folder, as the same UMD modules the desktop already writes:

- no build step and no framework: a `<script src="shared/x.js">` in `index.html` publishes the global, a Vite import in the desktop does the same, and `require()` in `node:test` gets the exports;
- no DOM or storage access at load time, and browser globals only through `globalThis` (the repo's lint rule);
- a `.d.ts` beside each module for the desktop's TypeScript.

The desktop imports them from `../../shared/` (allowed in `vite.config.ts` and `tsconfig.json`); the Desktop workflow rebuilds on `shared/**`. The engine serves any file under the repo root with an extension, so the web app can load `shared/*.js` without a server change.

## Migration order

1. **Key resolver** -- `shared/keymap.js` (done). Desktop-only today; the web app's shortcuts can adopt it next.
2. **Slash registry** -- the `SLASH` table and parsing in `desktop/src/composer.js`, which `app.js` re-implements as its own command list.
3. **Tool schemas and approval reasons** -- the tool definitions in `desktop/src/tools.js` and the web's `tool-call-text.js`.
4. **Tool renderers** -- the text a tool call and its result are shown as.

Each step moves one module, points every importer and test at the new path in the same commit, and leaves no forwarding copy behind. The web side of each step is made with whoever owns `app.js` at the time, because that session's work must not be edited out from under it.

## Consequences

- One place to fix a shortcut, a slash command or a tool's wording, once the migration reaches it.
- `shared/` modules cannot use anything a surface does not have; surface-specific code stays in its surface.
- Android keeps its Kotlin; sharing with it would need data files (JSON) rather than code, which is a later decision.
