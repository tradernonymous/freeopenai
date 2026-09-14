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
        return {
          viewport: innerWidth + 'x' + innerHeight,
          documentWidth: document.documentElement.scrollWidth,
          chatViewPadding: style('#viewChat', 'padding'),
          card: rect('#viewChat .chat-card'),
          messages: rect('#chatMessages'),
          composer: rect('.composer'),
          model: rect('#modelTrigger'),
          attach: rect('#attachTrigger'),
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
