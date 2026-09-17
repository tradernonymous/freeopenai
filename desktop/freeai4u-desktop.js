// FreeAI4U Desktop: the Windows app.
//
// The app itself runs on the FreeAI4U server (Railway), so there is nothing to
// install or update here: this launcher checks the server is up, then opens it
// in its own app window -- Edge's app mode, which every Windows 10/11 machine
// has -- with a separate browser profile, so the sign-in and the chats stay out
// of the everyday browser. The window loads the desktop layout (?app=desktop):
// Chat / Plan / Build with the Builds panel docked beside the chat.
//
// Packaged as one .exe with Node's single-executable-application support (see
// .github/workflows/desktop.yml). No dependencies. Everything that touches the
// machine is passed in, so test/desktop.test.js can check the decisions.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const VERSION = '1.0.0';
const DEFAULT_SERVER = 'https://freeopenai-production.up.railway.app';
const HEALTH_TIMEOUT_MS = 12000;
// Where a newer exe announces itself: version.json beside the download in the
// rolling desktop-latest release, the same shape the Android app reads. The
// app itself lives on the server and is always current; this is only about
// the launcher, so the check is quiet, short, and never blocks the window.
const UPDATE_URL = 'https://github.com/tradernonymous/freeopenai/releases/download/desktop-latest/version.json';
const UPDATE_TIMEOUT_MS = 6000;

const HELP = [
  'FreeAI4U Desktop ' + VERSION,
  '',
  'Opens FreeAI4U in its own window.',
  '',
  '  --server <url>   Use another FreeAI4U server and remember it (https only)',
  '  --reset          Forget the saved server and go back to the default',
  '  --version        Show the version',
  '  --help           Show this help',
].join('\n');

// An address the window may open: https anywhere, http only on this machine,
// no credentials, reduced to its origin.
function normalizeServer(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && local) return url.origin;
  return null;
}

function parseArgs(argv) {
  const out = { server: null, reset: false, help: false, version: false, writeVersion: null, unknown: [] };
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '--server') out.server = args[++i] == null ? '' : String(args[i]);
    else if (arg.startsWith('--server=')) out.server = arg.slice('--server='.length);
    else if (arg === '--reset') out.reset = true;
    else if (arg === '--help' || arg === '-h' || arg === '/?') out.help = true;
    else if (arg === '--version' || arg === '-v') out.version = true;
    else if (arg === '--write-version') out.writeVersion = args[++i] == null ? null : String(args[i]);
    else out.unknown.push(arg);
  }
  return out;
}

function configPaths(env) {
  const e = env || process.env;
  const roaming = e.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const local = e.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return {
    configFile: path.join(roaming, 'FreeAI4U', 'desktop.json'),
    profileDir: path.join(local, 'FreeAI4U', 'profile'),
    logFile: path.join(local, 'FreeAI4U', 'desktop.log'),
  };
}

function readConfig(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

// Flag first (and it is remembered), then the saved choice, then the default.
function chooseServer(args, config) {
  if (args.server != null) {
    const server = normalizeServer(args.server);
    return server
      ? { server, save: true }
      : { server: null, error: 'That server address is not usable. Use the https:// address of your FreeAI4U server.' };
  }
  const saved = normalizeServer(config && config.server);
  return { server: saved || DEFAULT_SERVER, save: false };
}

// Edge first (always present on Windows 10/11), then Chrome.
function browserCandidates(env) {
  const e = env || process.env;
  const roots = [e['ProgramFiles(x86)'], e.ProgramFiles, e.LOCALAPPDATA].filter(Boolean);
  const edge = roots.map((root) => path.win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  const chrome = roots.map((root) => path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  return [...edge, ...chrome];
}

function findBrowser(candidates, exists) {
  const check = exists || ((p) => fs.existsSync(p));
  return candidates.find((p) => check(p)) || null;
}

function appUrl(server) {
  return server + '/?app=desktop';
}

function launchArgs(url, profileDir) {
  return [
    '--app=' + url,
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1360,900',
    '--disable-features=Translate',
  ];
}

// Is this a FreeAI4U server that answers? The public health route says so
// without a sign-in.
async function checkHealth(server, fetchImpl, timeoutMs = HEALTH_TIMEOUT_MS) {
  const get = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await get(server + '/api/health', { signal: controller.signal, headers: { Accept: 'application/json' } });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok || !data || data.ok !== true) {
      return { ok: false, error: server + ' answered, but it does not look like a FreeAI4U server (HTTP ' + res.status + ').' };
    }
    return { ok: true, version: String(data.version || ''), commit: String(data.commit || '').slice(0, 7) };
  } catch (err) {
    const why = err && err.name === 'AbortError' ? 'it did not answer in time' : (err && err.message) || 'unknown error';
    return { ok: false, error: 'Could not reach ' + server + ' (' + why + '). Check your internet connection, or that the server is running on Railway.' };
  } finally {
    clearTimeout(timer);
  }
}

/** "1.2.10" against "1.2.9": each part compared as a number, missing parts as
 * zero, anything unparseable as not newer. */
function isNewerVersion(candidate, current) {
  const parts = (value) => String(value == null ? '' : value).trim().split('.').map((n) => Number.parseInt(n, 10));
  const a = parts(candidate);
  const b = parts(current);
  if (!a.length || a.some((n) => !Number.isFinite(n))) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = Number.isFinite(a[i]) ? a[i] : 0;
    const right = Number.isFinite(b[i]) ? b[i] : 0;
    if (left !== right) return left > right;
  }
  return false;
}

/** version.json read into { version, url }, or null. The download link has to
 * be an https github.com address: this is a file from the internet, and the
 * only thing done with it is showing it to the user. */
function parseDesktopUpdate(body) {
  let data = null;
  try {
    data = JSON.parse(String(body || ''));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const version = String(data.version || data.versionName || '').trim();
  const url = String(data.url || '').trim();
  if (!/^\d+(\.\d+)*$/.test(version)) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return null;
  return { version, url: parsed.href };
}

/** The message to show when a newer launcher exists, or '' when there is
 * nothing to say. Never throws: an update check must not be able to stop the
 * app from opening. */
async function updateNotice(fetchImpl, current = VERSION, url = UPDATE_URL, timeoutMs = UPDATE_TIMEOUT_MS) {
  const get = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await get(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res || !res.ok) return '';
    const info = parseDesktopUpdate(await res.text());
    if (!info || !isNewerVersion(info.version, current)) return '';
    return 'FreeAI4U Desktop ' + info.version + ' is out (you have ' + current + ').\n\n' +
      'Download it from:\n' + info.url + '\n\nYour chats and sign-in are unaffected.';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// A Windows message box. The text travels in an environment variable, never
// inside the script, so nothing in it can become PowerShell code.
function messageBoxCommand(text, title) {
  return {
    command: 'powershell.exe',
    args: [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
      'Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($env:FREEAI4U_MESSAGE, $env:FREEAI4U_TITLE) | Out-Null',
    ],
    env: { FREEAI4U_MESSAGE: String(text), FREEAI4U_TITLE: String(title || 'FreeAI4U') },
  };
}

function log(paths, line) {
  try {
    fs.mkdirSync(path.dirname(paths.logFile), { recursive: true });
    fs.appendFileSync(paths.logFile, new Date().toISOString() + ' ' + line + '\n');
  } catch { /* logging is best effort */ }
}

function showMessage(text) {
  if (process.platform !== 'win32') {
    console.log(text);
    return Promise.resolve();
  }
  const call = messageBoxCommand(text, 'FreeAI4U Desktop');
  return new Promise((resolve) => {
    const child = spawn(call.command, call.args, { env: { ...process.env, ...call.env }, windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}

function openWindow(url, paths, env) {
  const browser = findBrowser(browserCandidates(env));
  if (browser) {
    fs.mkdirSync(paths.profileDir, { recursive: true });
    const child = spawn(browser, launchArgs(url, paths.profileDir), { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', (err) => log(paths, 'browser failed: ' + err.message));
    child.unref();
    return browser;
  }
  // No Edge or Chrome: the default browser, as a normal tab. The URL was built
  // from a normalised origin, so it holds no characters cmd would act on.
  const child = spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
  child.unref();
  return 'default browser';
}

async function main(argv) {
  const args = parseArgs(argv);
  const paths = configPaths(process.env);
  if (args.writeVersion) {
    fs.writeFileSync(args.writeVersion, VERSION);
    return 0;
  }
  if (args.version) {
    await showMessage('FreeAI4U Desktop ' + VERSION);
    return 0;
  }
  if (args.help || args.unknown.length) {
    await showMessage((args.unknown.length ? 'Unknown option: ' + args.unknown.join(' ') + '\n\n' : '') + HELP);
    return args.help ? 0 : 2;
  }
  let config = readConfig(paths.configFile);
  if (args.reset) {
    config = {};
    writeConfig(paths.configFile, config);
  }
  const choice = chooseServer(args, config);
  if (!choice.server) {
    await showMessage(choice.error);
    return 2;
  }
  if (choice.save) writeConfig(paths.configFile, { ...config, server: choice.server });

  const health = await checkHealth(choice.server);
  log(paths, 'server ' + choice.server + ' health ' + JSON.stringify(health));
  if (!health.ok) {
    await showMessage(health.error + '\n\nThe window will open anyway, so you can retry from there.');
  }
  const opened = openWindow(appUrl(choice.server), paths, process.env);
  log(paths, 'opened with ' + opened);
  // After the window, never before: a slow or unreachable GitHub must cost the
  // user nothing, and an update is news rather than a gate.
  const notice = await updateNotice();
  if (notice) {
    log(paths, 'update available');
    await showMessage(notice);
  }
  return 0;
}

module.exports = {
  VERSION,
  DEFAULT_SERVER,
  normalizeServer,
  parseArgs,
  configPaths,
  readConfig,
  writeConfig,
  chooseServer,
  browserCandidates,
  findBrowser,
  appUrl,
  launchArgs,
  checkHealth,
  isNewerVersion,
  parseDesktopUpdate,
  updateNotice,
  UPDATE_URL,
  messageBoxCommand,
  main,
};

function isSingleExecutable() {
  try {
    return require('node:sea').isSea();
  } catch {
    return false;
  }
}

if (require.main === module || isSingleExecutable()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    log(configPaths(process.env), 'crashed: ' + (err && err.stack));
    return showMessage('FreeAI4U Desktop could not start: ' + (err && err.message)).then(() => { process.exitCode = 1; });
  });
}
