#!/usr/bin/env node
/*
 * Dependency-free browser smoke test for the UI's fragile surface.
 *
 * It starts an isolated local server and a clean headless Chrome profile, then
 * checks the actual rendered page at desktop, portrait and landscape sizes.
 * This is intentionally not part of `npm test`: it needs Chrome and exercises
 * layout timing, not pure rules. Run with `npm run smoke`.
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const WAIT_MS = 250;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chromePath() {
  const candidates = process.platform === 'win32'
    ? [
        process.env['PROGRAMFILES'] && path.join(process.env['PROGRAMFILES'], 'Google/Chrome/Application/chrome.exe'),
        process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
        process.env['PROGRAMFILES'] && path.join(process.env['PROGRAMFILES'], 'Microsoft/Edge/Application/msedge.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function freePort(start = 3213) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(start, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function requestJson(port, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(new Error(body.slice(0, 300) || error.message)); }
      });
    });
    req.once('error', reject);
    req.end();
  });
}

async function waitFor(check, label, attempts = 80) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(WAIT_MS);
  }
  throw new Error('Timed out waiting for ' + label + (lastError ? ': ' + lastError.message : ''));
}

async function main() {
  const chrome = chromePath();
  if (!chrome) throw new Error('Chrome or Chromium was not found; set SMOKE_CHROME to an executable path.');
  const WebSocketImpl = globalThis.WebSocket;
  if (typeof WebSocketImpl !== 'function') {
    throw new Error('browser smoke needs Node 22+ for its built-in WebSocket client.');
  }
  const appPort = await freePort(Number(process.env.SMOKE_PORT) || 3213);
  const cdpPort = await freePort(9333);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'freeopenai-smoke-'));
  let app;
  let browser;
  let ws;
  const pending = new Map();
  let sequence = 0;
  const errors = [];

  try {
    app = spawn(process.execPath, ['server.js'], {
      cwd: APP_DIR,
      env: { ...process.env, PORT: String(appPort) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverOutput = '';
    app.stdout.on('data', (chunk) => { serverOutput += String(chunk); });
    app.stderr.on('data', (chunk) => { serverOutput += String(chunk); });
    await waitFor(async () => {
      const response = await fetch('http://127.0.0.1:' + appPort + '/');
      return response.ok;
    }, 'the local app');

    browser = spawn(chrome, [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--remote-debugging-port=' + cdpPort,
      '--user-data-dir=' + profile,
      '--window-size=1440,900',
      'about:blank',
    ], { stdio: 'ignore' });

    const version = await waitFor(() => requestJson(cdpPort, '/json/version'), 'Chrome DevTools');
    const target = await requestJson(cdpPort, '/json/new?about:blank', 'PUT');
    ws = new WebSocketImpl(target.webSocketDebuggerUrl);
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });

    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.exception && response.exceptionDetails.exception.description || 'page evaluation failed');
      }
      return response.result && response.result.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Network.enable');
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        errors.push((details.exception && details.exception.description) || details.text || 'runtime exception');
      }
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error' && message.params.entry.source !== 'network') {
        errors.push(message.params.entry.text || 'console error');
      }
      if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) {
        const responseUrl = new URL(message.params.response.url);
        if (responseUrl.pathname !== '/favicon.ico') {
          errors.push('HTTP ' + message.params.response.status + ' ' + message.params.response.url);
        }
      }
    });

    const url = 'http://127.0.0.1:' + appPort + '/?smoke=' + Date.now();
    const visit = async (name, width, height, mobile) => {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      await send('Page.navigate', { url: url + '-' + name });
      await waitFor(() => evaluate('!!document.getElementById("viewChat") && typeof addMessage === "function"'), name + ' page');
      await sleep(400);
      const result = await evaluate(`(() => {
        const el = (selector) => document.querySelector(selector);
        const rect = (selector) => { const node = el(selector); if (!node) return null; const box = node.getBoundingClientRect(); return { left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width), height: Math.round(box.height) }; };
        const style = (selector, prop) => { const node = el(selector); return node ? getComputedStyle(node)[prop] : null; };
        const messages = document.getElementById('chatMessages');
        const header = [...document.querySelectorAll('.chat-bar-actions .icon-btn')]
          .filter((b) => getComputedStyle(b).display !== 'none')
          .map((b) => { const box = b.getBoundingClientRect(); return { id: b.id || '?', w: Math.round(box.width), h: Math.round(box.height) }; });
        // Every control the header offers has to be on screen at every size,
        // and the appearance picker has to open onto the viewport rather than
        // hanging off it. The theme toggle was once the first thing to be hidden
        // on a narrow phone, which left tapping the sun/moon impossible there.
        const themeTrigger = el('#themeToggle');
        const themeButton = (() => {
          if (!themeTrigger) return null;
          const box = themeTrigger.getBoundingClientRect();
          return { display: getComputedStyle(themeTrigger).display, w: Math.round(box.width), left: Math.round(box.left), right: Math.round(box.right) };
        })();
        const appearance = (() => {
          if (!themeTrigger || typeof toggleThemeMenu !== 'function') return null;
          toggleThemeMenu({ currentTarget: themeTrigger, stopPropagation() {} });
          const menu = document.getElementById('themeMenu');
          if (!menu) return null;
          const box = menu.getBoundingClientRect();
          const rows = [...menu.querySelectorAll('button')].map((row) => {
            const r = row.getBoundingClientRect();
            return { label: row.textContent.trim(), h: Math.round(r.height), inside: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1 };
          });
          const out = { count: rows.length, inside: box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1, rows };
          closeThemeMenu();
          return out;
        })();
        return {
          viewport: innerWidth + 'x' + innerHeight,
          documentWidth: document.documentElement.scrollWidth,
          chatViewPadding: style('#viewChat', 'padding'),
          card: rect('#viewChat .chat-card'),
          messages: rect('#chatMessages'),
          composer: rect('.composer'),
          model: rect('#modelTrigger'),
          attach: rect('#attachTrigger'),
          header,
          themeButton,
          appearance,
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          messageGap: messages.scrollHeight - messages.scrollTop - messages.clientHeight,
        };
      })()`);
      console.log(name + ': ' + JSON.stringify(result));
      return result;
    };

    const desktop = await visit('desktop', 1440, 900, false);
    if (!desktop.card || desktop.card.width < 700) throw new Error('desktop center card is only ' + (desktop.card && desktop.card.width) + 'px wide');
    if (desktop.overflow) throw new Error('desktop page overflows horizontally');

    const wideDesktop = await visit('wide-desktop', 1600, 900, false);
    if (!wideDesktop.card || wideDesktop.card.width < 700) throw new Error('wide desktop center card is only ' + (wideDesktop.card && wideDesktop.card.width) + 'px wide');
    if (wideDesktop.overflow) throw new Error('wide desktop page overflows horizontally');

    const portrait = await visit('portrait', 390, 844, true);
    if (portrait.chatViewPadding !== '0px') throw new Error('portrait chat view is not full bleed');
    if (portrait.overflow) throw new Error('portrait page overflows horizontally');
    if (!portrait.model || portrait.model.height < 40) throw new Error('portrait model picker is not a usable touch target');

    const landscape = await visit('landscape', 844, 390, true);
    if (landscape.chatViewPadding !== '0px') throw new Error('landscape chat view is not full bleed');
    if (landscape.overflow) throw new Error('landscape page overflows horizontally');
    if (!landscape.model || landscape.model.height < 34 || landscape.model.height > 42) throw new Error('landscape model picker is not in the compact touch range');

    // The smallest phone this is expected to work on, in portrait.
    const small = await visit('small', 360, 640, true);
    if (small.overflow) throw new Error('a 360px phone overflows horizontally');

    // Every size the app is used at keeps the same controls, the same
    // appearance picker, and one height for every icon button in the header.
    for (const [name, shot] of Object.entries({ desktop, wideDesktop, portrait, landscape, small })) {
      if (!shot.themeButton || shot.themeButton.display === 'none' || shot.themeButton.w < 24) {
        throw new Error(name + ' hides the appearance toggle: ' + JSON.stringify(shot.themeButton));
      }
      if (shot.themeButton.left < -1 || shot.themeButton.right > Number(shot.viewport.split('x')[0]) + 1) {
        throw new Error(name + ' puts the appearance toggle off screen: ' + JSON.stringify(shot.themeButton));
      }
      if (!shot.appearance || shot.appearance.count !== 5) {
        throw new Error(name + ' cannot offer the appearance choices: ' + JSON.stringify(shot.appearance));
      }
      if (!shot.appearance.inside) throw new Error(name + ' opens the appearance picker off screen: ' + JSON.stringify(shot.appearance));
      for (const row of shot.appearance.rows) {
        if (!row.inside || row.h < 28) throw new Error(name + ' has an unusable appearance row: ' + JSON.stringify(row));
      }
      const heights = new Set(shot.header.map((b) => b.h));
      const widths = new Set(shot.header.map((b) => b.w));
      if (heights.size > 1 || widths.size > 1) {
        throw new Error(name + ' header controls are not one size: ' + JSON.stringify(shot.header));
      }
    }

    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: url + '-behaviour' });
    await waitFor(() => evaluate('!!document.getElementById("viewChat") && typeof addMessage === "function"'), 'behaviour page');
    await sleep(400);

    const behavior = await evaluate(`(async () => {
      const cm = document.getElementById('chatMessages');
      chatMessages.innerHTML = '';
      emptyState.style.display = 'none';
      messages = [];
      for (let i = 0; i < 24; i++) addMessage('user', 'Smoke message ' + i + ' with enough text to create a real scrollable transcript window.');
      cm.scrollTop = Math.max(0, cm.scrollHeight - cm.clientHeight - 180);
      cm.dispatchEvent(new Event('scroll'));
      const before = cm.scrollTop;
      addMessage('system', 'Smoke tool output');
      const detached = { before, after: cm.scrollTop, pill: document.getElementById('scrollBottom').classList.contains('visible'), label: document.querySelector('.scroll-bottom-label').textContent };
      jumpToNewest();
      await new Promise((resolve) => setTimeout(resolve, 120));
      const jumped = { gap: cm.scrollHeight - cm.scrollTop - cm.clientHeight, pill: document.getElementById('scrollBottom').classList.contains('visible') };
      const settleGaps = [];
      for (const delay of [50, 150, 300, 600, 1000]) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        settleGaps.push({ delay, gap: cm.scrollHeight - cm.scrollTop - cm.clientHeight, top: cm.scrollTop, height: cm.scrollHeight });
      }

      const attach = document.getElementById('attachMenu');
      toggleAttachMenu();
      const attachment = { open: attach.classList.contains('open'), options: attach.querySelectorAll('.attach-menu-item').length };
      closeAttachMenu();

      const canvas = document.createElement('canvas');
      canvas.width = 64; canvas.height = 32;
      canvas.getContext('2d').fillRect(0, 0, 64, 32);
      const png = canvas.toDataURL('image/png');
      const entry = { type: 'bot', content: '[Generated image: smoke]' };
      messages.push(entry);
      await storeGeneratedImages(entry, [png], 'smoke');
      switchView('gallery');
      const image = document.querySelector('#galleryGrid img');
      const gallery = { stored: !!(entry.images && entry.images.length), jpeg: !!(entry.images && entry.images[0] && entry.images[0].url.startsWith('data:image/jpeg')), rendered: !!image };

      // A real sendMessage() on a stubbed model call: the whole body runs, so
      // a use-before-declaration or a broken handler kills the probe instead
      // of shipping a composer that silently does nothing (that exact bug once
      // passed every unit test -- it only shows when the function executes).
      // The smoke server has no AUTH_USER_*, so needsPuterLogin() is true for
      // a fresh visitor; a signed-in deployment with its own login does not
      // demand Puter, which is the state simulated here.
      const providerOriginal = selectedProvider;
      const runOriginal = runChatWithTools;
      const loginOriginal = loginRequired;
      selectedProvider = 'smoke-direct';
      loginRequired = true;
      runChatWithTools = async () => ({
        message: { role: 'assistant', content: 'smoke reply text' },
        exhausted: false,
        finishReason: 'stop',
      });
      const input = document.getElementById('chatInput');
      input.value = 'smoke send probe';
      let sendError = '';
      try { await sendMessage(); } catch (e) { sendError = String(e && e.message || e); }
      try {
        selectedProvider = providerOriginal;
        runChatWithTools = runOriginal;
        loginRequired = loginOriginal;
      } catch { /* restore best-effort */ }
      const sent = messages.map((m) => m.type + ':' + (m.content || '')).join('|');
      const send = {
        error: sendError,
        inputCleared: input.value === '',
        userEcho: sent.includes('user:smoke send probe'),
        botReply: sent.includes('bot:smoke reply text'),
        transcriptShows: document.getElementById('chatMessages').textContent.includes('smoke reply text'),
      };
      return { detached, jumped, settleGaps, attachment, gallery, send };
    })()`);
    console.log('behaviour: ' + JSON.stringify(behavior));
    if (behavior.detached.before !== behavior.detached.after || !behavior.detached.pill || behavior.detached.label !== '1 new') {
      throw new Error('detached transcript did not preserve position and announce one new item');
    }
    if (behavior.jumped.gap > 120 || behavior.jumped.pill) throw new Error('jump-to-newest did not settle at the bottom');
    if (behavior.send.error) throw new Error('sendMessage threw in the browser: ' + behavior.send.error);
    if (!behavior.send.inputCleared || !behavior.send.userEcho || !behavior.send.botReply || !behavior.send.transcriptShows) {
      throw new Error('the composer did not complete a send: ' + JSON.stringify(behavior.send));
    }
    if (!behavior.attachment.open || behavior.attachment.options !== 3) throw new Error('attachment menu smoke check failed');
    if (!behavior.gallery.stored || !behavior.gallery.jpeg || !behavior.gallery.rendered) throw new Error('generated image did not survive into the Gallery');

    // A pinned skill has to survive a reload *and* keep the chip that turns it
    // off. A pin that still applies with nothing on screen is a setting the user
    // cannot reach: the skill is running and there is nothing to click.
    await send('Page.navigate', { url: url + '-pinned' });
    await waitFor(() => evaluate('!!document.getElementById("skillBar") && typeof pinSkillForChat === "function"'), 'pinned page');
    await sleep(400);
    const pinned = await evaluate(`(async () => {
      await ensureSkillsLoaded();
      const names = (skillsCatalog || []).slice(0, 2).map((s) => s.name);
      for (const name of names) pinSkillForChat(name);
      return {
        catalog: (skillsCatalog || []).length,
        active: activeSkillNames.slice(),
        chips: document.querySelectorAll('#skillBar .skill-pin').length,
        offButtons: document.querySelectorAll('#skillBar .skill-pin button').length,
      };
    })()`);
    console.log('pinned: ' + JSON.stringify(pinned));
    //
    // An empty catalogue here is the weather, not the app. The catalogue is
    // fetched from GitHub's tree API unauthenticated, which allows 60 requests an
    // hour *per address* -- and this machine shares its address with every other
    // run, so the library goes quiet part way through a day of work. The library
    // itself is covered by test/skill-fetch.test.js and the router by
    // test/skill-router.test.js, both offline. So this says so and moves on,
    // rather than reporting a red build for somebody else's rate limit.
    const skillsAvailable = pinned.catalog > 0;
    if (!skillsAvailable) {
      console.log('pinned: skipped — the skill catalogue is empty (a GitHub API rate limit; set GITHUB_TOKEN to raise the hourly allowance)');
    }
    if (skillsAvailable) {
      if (!pinned.active.length) throw new Error('could not pin a skill in the smoke browser: ' + JSON.stringify(pinned));
      if (pinned.chips !== pinned.active.length) throw new Error('the pinned chips do not match what is pinned');
      if (pinned.offButtons !== pinned.active.length) throw new Error('a pinned chip has no way to turn it off');

      // The same chat, reloaded: the pins have to come back, chip and all.
      await send('Page.navigate', { url: url + '-pinned' });
      await waitFor(() => evaluate('typeof syncActiveSkillsFromConversation === "function"'), 'pinned reload');
      await sleep(600);
      const restored = await evaluate(`({
        active: activeSkillNames.slice(),
        chips: document.querySelectorAll('#skillBar .skill-pin').length,
        offButtons: document.querySelectorAll('#skillBar .skill-pin button').length,
        saved: ((conversations.find((c) => c.id === activeConversationId) || {}).skills) || null,
        barHidden: document.getElementById('skillBar').hidden,
      })`);
      console.log('restored: ' + JSON.stringify(restored));
      if (JSON.stringify(restored.active) !== JSON.stringify(pinned.active)) {
        throw new Error('a reload lost the pinned skills: ' + JSON.stringify(restored));
      }
      if (restored.chips !== restored.active.length || restored.offButtons !== restored.active.length) {
        throw new Error('a reload left a pinned skill with no chip to turn it off: ' + JSON.stringify(restored));
      }

      // And the chip has to work: turning one off is the whole point of it coming
      // back, and the turn-off has to survive the next reload too.
      const turnedOff = await evaluate(`({
        before: activeSkillNames.length,
        clicked: (document.querySelector('#skillBar .skill-pin button') || {}).click ? (document.querySelector('#skillBar .skill-pin button').click(), true) : false,
      })`);
      await sleep(200);
      const afterOff = await evaluate(`({
        active: activeSkillNames.slice(),
        chips: document.querySelectorAll('#skillBar .skill-pin').length,
      })`);
      console.log('turned off: ' + JSON.stringify({ turnedOff, afterOff }));
      if (turnedOff.before !== afterOff.active.length + 1 || afterOff.chips !== afterOff.active.length) {
        throw new Error('the chip did not turn a pinned skill off: ' + JSON.stringify({ turnedOff, afterOff }));
      }
      await send('Page.navigate', { url: url + '-pinned' });
      await waitFor(() => evaluate('typeof syncActiveSkillsFromConversation === "function"'), 'pinned reload after removal');
      await sleep(600);
      const stayedOff = await evaluate('activeSkillNames.slice()');
      if (JSON.stringify(stayedOff) !== JSON.stringify(afterOff.active)) {
        throw new Error('a skill turned off came back after a reload: ' + JSON.stringify(stayedOff));
      }
    }

    // The mode's tool surface, in the page as shipped. A mode that only asks
    // nicely in its prompt is not a mode: in Chat and Plan the write tools are
    // not offered, and a call that arrives anyway is refused by the runner --
    // which is what this drives, through the real dispatcher.
    const modes = await evaluate(`(async () => {
      const writes = ['github_commit_file', 'github_delete_file', 'workspace_write_file', 'workspace_edit_file', 'workspace_delete_file'];
      const args = { path: 'notes/probe.md', repo: 'o/r', content: 'x', message: 'm', old_text: 'a', new_text: 'b' };
      const before = selectedMode;
      const refused = {};
      for (const mode of ['chat', 'plan']) {
        selectedMode = mode;
        refused[mode] = [];
        for (const name of writes) {
          const reply = await runToolCall(name, args);
          if (/^Refused:/.test(reply) && /Nothing changed/.test(reply)) refused[mode].push(name);
        }
      }
      selectedMode = before;
      return {
        mode: before,
        refused,
        offered: writes.filter((n) => modeAllowsTool(before, n)).length,
        blocked: writes.map((n) => modeBlocksWrite(before, n)).filter(Boolean).length,
        workspaceEmpty: Object.keys(activeWorkspace() || {}).length === 0,
      };
    })()`);
    console.log('modes: ' + JSON.stringify(modes));
    const writeNames = ['github_commit_file', 'github_delete_file', 'workspace_write_file', 'workspace_edit_file', 'workspace_delete_file'];
    for (const mode of ['chat', 'plan']) {
      if (modes.refused[mode].length !== writeNames.length) {
        throw new Error(mode + ' mode did not refuse every write: ' + JSON.stringify(modes.refused[mode]));
      }
    }
    if (modes.workspaceEmpty !== true) throw new Error('a refused write still wrote to the workspace');
    // Whatever the page was left in has to agree with itself: Build offers every
    // write and blocks none, and the other two offer none and block every one.
    const writable = modes.mode === 'build';
    if (modes.offered !== (writable ? writeNames.length : 0) || modes.blocked !== (writable ? 0 : writeNames.length)) {
      throw new Error('the mode surface and the refusal disagree: ' + JSON.stringify(modes));
    }

    if (errors.length) throw new Error('browser reported errors: ' + errors.join('; '));
    console.log('browser smoke: PASS (' + version.Browser + ')');
    if (serverOutput) process.stderr.write(serverOutput);
  } finally {
    if (ws) try { ws.close(); } catch { /* already closed */ }
    if (browser && !browser.killed) browser.kill();
    if (app && !app.killed) app.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Windows may release the profile after exit */ }
  }
}

main().catch((error) => {
  console.error('browser smoke: FAIL — ' + error.message);
  process.exitCode = 1;
});
