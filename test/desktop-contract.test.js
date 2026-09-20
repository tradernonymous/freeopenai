// The two contracts the desktop can only fail at runtime otherwise.
//
// The shell is Rust, the frontend is TypeScript, and between them are two sets
// of names that nothing in either language checks: the Tauri command names the
// frontend invokes, and the engine's HTTP routes. A typo in either is a button
// that does nothing -- the exact class of bug that is invisible in review,
// invisible in `tsc`, and found by a user.
//
// So both are read as data here: the frontend's command names against the
// shell's `generate_handler!` list, and the engine's routes against server.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

/** Every frontend source file: the bridge is not the only door to the shell. */
function frontendSources() {
  const dir = path.join(ROOT, 'desktop', 'src');
  const out = [];
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        out.push(fs.readFileSync(full, 'utf8'));
      }
    }
  };
  walk(dir);
  return out.join('\n');
}

const BRIDGE = frontendSources();
const API = read('desktop', 'src', 'api.ts');
const MAIN_RS = read('desktop', 'src-tauri', 'src', 'main.rs');
const SERVER = read('server.js');

/** Every Tauri command the frontend asks for, `call<T>('name')` or `invoke('name')`. */
function invokedCommands(source) {
  const names = new Set();
  for (const match of source.matchAll(/\.invoke\(\s*'([a-z_]+)'/g)) names.add(match[1]);
  for (const match of source.matchAll(/\bcall(?:<[^>]*>)?\(\s*'([a-z_]+)'/g)) names.add(match[1]);
  return [...names].sort();
}

/** Every command the Rust shell actually registers. */
function registeredCommands(source) {
  const handler = source.match(/generate_handler!\[([\s\S]*?)\]/);
  assert.ok(handler, 'the shell registers a command handler');
  return handler[1]
    .split(',')
    .map((entry) => entry.trim().split('::').pop())
    .filter((name) => /^[a-z_]+$/.test(name))
    .sort();
}

/** Every engine route the desktop client calls, as written in api.ts. */
function engineRoutes(source) {
  const names = new Set();
  for (const match of source.matchAll(/'(\/api\/[A-Za-z0-9/_-]+)'/g)) names.add(match[1]);
  return [...names].sort();
}

test('every command the frontend invokes exists in the shell', () => {
  const invoked = invokedCommands(BRIDGE);
  const registered = new Set(registeredCommands(MAIN_RS));
  assert.ok(invoked.length >= 8, 'the frontend invokes more than a couple of commands');
  for (const name of invoked) {
    assert.ok(registered.has(name), `the frontend invokes '${name}', which main.rs does not register`);
  }
});

test('the shell registers no command the frontend never calls', () => {
  const invoked = new Set(invokedCommands(BRIDGE));
  const unused = registeredCommands(MAIN_RS).filter((name) => !invoked.has(name));
  // A registered command that nothing calls is surface area with no user: it
  // still has to be maintained, and it still widens what a compromised webview
  // can reach. Either it is used or it should go.
  assert.deepEqual(unused, [], `registered but never invoked: ${unused.join(', ')}`);
});

test('every engine route the app calls is a route the engine serves', () => {
  const routes = engineRoutes(API);
  assert.ok(routes.length >= 10, 'the client talks to more than a couple of routes');
  const missing = routes.filter((route) => !SERVER.includes(route));
  assert.deepEqual(missing, [], `api.ts calls routes server.js does not serve: ${missing.join(', ')}`);
});

test('the streaming route is built the same way the engine expects it', () => {
  // streamChat builds its URL inline instead of going through the route table,
  // so its shape needs its own check: the engine selects the provider from the
  // query string.
  const stream = API.slice(API.indexOf('export async function streamChat'));
  assert.match(stream, /\/api\/llm\/chat\?provider=/, 'the provider rides the query string');
  assert.ok(SERVER.includes('/api/llm/chat'), 'and the engine serves that path');
});

test('the CSP allows exactly the edges the app actually uses', () => {
  const conf = JSON.parse(read('desktop', 'src-tauri', 'tauri.conf.json'));
  const csp = conf.app.security.csp || '';
  assert.ok(csp && csp !== 'null', 'the shell declares a CSP instead of leaving it open');
  assert.match(csp, /connect-src[^;]*'self'/, 'the app may reach its own bundled assets');
  assert.match(csp, /connect-src[^;]*https:/, 'and the engine, which is https');
  assert.match(csp, /connect-src[^;]*http:\/\/127\.0\.0\.1:\*/, 'and a local model server');
  assert.match(csp, /object-src 'none'/, 'and it refuses plugins');
  assert.ok(!/unsafe-eval/.test(csp), 'nothing in the shell needs eval');
});
