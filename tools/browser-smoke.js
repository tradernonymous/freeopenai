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
      // The shell route is enabled for this run so the page's half of it can be
      // driven. It still refuses to run anything: this app has no login
      // configured (see `workspaceRunRefusal`), which is exactly the refusal the
      // smoke below asserts it gets.
      env: { ...process.env, PORT: String(appPort), WORKSPACE_RUN: '1' },
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
        // A refusal is an answer for the shell route, and the smoke asks for one
        // on purpose: a 403 there is the app working, not a page in trouble.
        const refusedShell = responseUrl.pathname === '/api/workspace/run' && message.params.response.status === 403;
        if (responseUrl.pathname !== '/favicon.ico' && !refusedShell) {
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
      const result = await evaluate(`(async () => {
        const el = (selector) => document.querySelector(selector);
        const rect = (selector) => { const node = el(selector); if (!node) return null; const box = node.getBoundingClientRect(); return { left: Math.round(box.left), right: Math.round(box.right), top: Math.round(box.top), bottom: Math.round(box.bottom), width: Math.round(box.width), height: Math.round(box.height) }; };
        const style = (selector, prop) => { const node = el(selector); return node ? getComputedStyle(node)[prop] : null; };
        // The two buttons every message needs -- attach and draw -- plus the
        // settings strip they sit beside. On a phone the strip scrolls and the
        // actions must not, which is a claim about the layout that only the
        // layout can answer.
        const composerControls = (() => {
          const row = el('.composer-controls');
          const actions = el('.composer-actions');
          const settings = el('.composer-settings');
          if (!row || !actions || !settings) return null;
          const box = (node) => { const r = node.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), width: Math.round(r.width) }; };
          const place = (node) => {
            if (!node) return null;
            const r = node.getBoundingClientRect();
            return {
              left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top),
              height: Math.round(r.height),
              inView: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1,
            };
          };
          return {
            actions: box(actions),
            settings: box(settings),
            settingsScrolls: settings.scrollWidth > settings.clientWidth + 1,
            actionsScrolls: actions.scrollWidth > actions.clientWidth + 1,
            attach: place(el('#attachTrigger')),
            attachTarget: (() => {
              const node = el('#attachTrigger');
              if (!node) return null;
              const after = getComputedStyle(node, '::after');
              return { w: Math.round(parseFloat(after.width) || 0), h: Math.round(parseFloat(after.height) || 0) };
            })(),
            sessionChip: place(el('#sessionChip')),
            // Every control in the strip, and whether it is actually on the
            // screen. Existence was all this used to check, which is how three
            // dead CSS clamps went unnoticed: the phone rules for the model name
            // and the effort picker were written at a lower specificity than the
            // desktop ones, so a 360px screen rendered desktop widths, the strip
            // overflowed by 80px, and the mode chip sat entirely past the right
            // edge with no scrollbar to suggest it was there.
            strip: ['#attachTrigger', '#sessionChip', '.model-trigger', '#providerSelect', '#effortChip', '#modeChip']
              .map((selector) => {
                const node = el(selector);
                if (!node || getComputedStyle(node).display === 'none') return null;
                const at = place(node);
                const r = node.getBoundingClientRect();
                return {
                  id: selector, inView: at.inView,
                  left: Math.round(r.left),
                  // Centre rather than top: attach draws smaller than the chips and
                  // is centred against them, so its top differs on the same line.
                  centreY: Math.round(r.top + r.height / 2),
                  width: Math.round(r.width), height: Math.round(r.height),
                };
              })
              .filter(Boolean),
            // The pickers that made this row too long are gone; one coming back
            // is the regression this notices.
            imageProviderSelect: !!el('#imageProviderSelect'),
            imageModeButton: !!el('#imageModeBtn'),
            skillToggles: !!el('#skillsToggle') || !!el('#skillTrigger'),
          };
        })();
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
        // The session surface is one pop-up with three sections, not two columns
        // and not three switches in the composer. That claim is only worth
        // anything if the conversation does not move when it opens, if it stays
        // off the composer, and if its sections really are one at a time -- so
        // all three are measured here rather than asserted in a stylesheet.
        //
        // Both states are measured after the 200ms slide has finished: read a
        // frame too early and an opening panel still reports the position and
        // opacity it is leaving, which is how a check like this passes while
        // the panel sits on top of Send.
        const session = await (async () => {
          const shell = el('#viewChat .chat-shell');
          if (!shell || typeof toggleSessionPanel !== 'function' || typeof showSessionTab !== 'function') return null;
          const settle = () => new Promise((done) => setTimeout(done, 300));
          const card = el('#viewChat .chat-card');
          const width = () => (card ? Math.round(card.getBoundingClientRect().width) : null);
          const isOpen = () => !shell.classList.contains('session-hidden');
          const box = (selector) => {
            const node = el(selector);
            if (!node) return null;
            const r = node.getBoundingClientRect();
            const cs = getComputedStyle(node);
            return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height), opacity: Number(cs.opacity), pointer: cs.pointerEvents, position: cs.position };
          };
          const overlaps = (a, b) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
          const composer = box('.composer');
          const bar = box('#viewChat .chat-bar');
          const sidebar = box('#historySidebar');
          const restore = isOpen();

          // Closed first: a panel that is merely transparent would still be
          // eating the clicks meant for the transcript.
          toggleSessionPanel(false, false);
          await settle();
          const shut = box('#sessionPanel');
          const closedWidth = width();

          // Then open. One surface means there is no fit rule left to consult and
          // nothing for it to land on, so all that is measured is where it is.
          toggleSessionPanel(true, false);
          await settle();
          const shown = box('#sessionPanel');
          // On a phone the panel is a takeover, and a takeover without a scrim is
          // a trap: the drawer covers most of the screen and what it leaves still
          // looks tappable.
          const scrim = box('#sessionScrim');
          const kept = isOpen();
          const openWidth = width();

          // One section at a time, and the tab that says so agrees with the
          // section that is painted.
          const sections = ['skills', 'tasks', 'image'];
          const tabs = sections.map((name) => {
            showSessionTab(name, false);
            const drawn = sections.filter((other) => {
              const node = el('#sessionSection' + other.charAt(0).toUpperCase() + other.slice(1));
              return !!node && getComputedStyle(node).display !== 'none';
            });
            const btn = el('#sessionTab' + name.charAt(0).toUpperCase() + name.slice(1));
            // The controls in this section, and whether they are actually on the
            // screen. A switch that decides whether a picture spends Puter credits
            // is only a decision if it can be reached.
            const controls = [...document.querySelectorAll('#sessionPanel .session-section.active input[type="checkbox"]')]
              .map((node) => {
                const r = node.getBoundingClientRect();
                return {
                  id: node.id || '?',
                  inView: r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1
                    && r.top >= -1 && r.bottom <= innerHeight + 1,
                };
              });
            return { tab: name, drawn, controls, pressed: btn ? btn.getAttribute('aria-pressed') : null };
          });

          toggleSessionPanel(!!restore, false);
          await settle();

          // The panel has two doors -- the chip in the composer and the button in
          // the bar -- and at least one of them has to be on screen at every
          // size, or the surface is unreachable and everything in it is dead.
          const doors = [el('#sessionChip'), el('#sessionToggle')].filter(Boolean).map((node) => {
            const r = node.getBoundingClientRect();
            return r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1;
          });

          return {
            closedWidth, openWidth, kept, restored: restore, bar, sidebar,
            hidden: shut, shown, scrim, tabs, doors,
            overComposer: overlaps(shown, composer),
            viewportWidth: innerWidth,
            viewportHeight: innerHeight,
          };
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
          composerControls,
          themeButton,
          appearance,
          session,
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

    // Attach is the control every message needs, and it now leads the row: hard
    // left, next to the model, where a thumb already is. It used to sit in a group
    // on a line of its own, which kept it from being pushed off the edge and spent
    // 44px of a phone's height on one button with the row empty beside it. What
    // replaces that guarantee is below -- the row cannot overflow, because the
    // model name gives up exactly the width the row is short by.
    for (const [name, shot] of Object.entries({ desktop, wideDesktop, portrait, landscape, small })) {
      const c = shot.composerControls;
      if (!c) throw new Error(name + ' has no composer controls at all');
      if (c.imageProviderSelect) throw new Error(name + ' still offers a second image provider picker');
      // The three controls the session panel absorbed are gone from the row. A
      // one-chip row is the point: fewer things to find, and the two every
      // message needs cannot be pushed off the edge by the ones nobody touches.
      if (c.imageModeButton) throw new Error(name + ' still has a draw button beside attach');
      if (c.skillToggles) throw new Error(name + ' still has the skill chips in the composer');
      if (!c.sessionChip) throw new Error(name + ' has no way to reach the session panel from the composer');
      // actionsScrolls is still measured and no longer asserted. The actions group
      // is one button with overflow: visible, so it cannot scroll -- and its
      // scrollWidth now reads 5px over on a phone because the 44px finger target
      // is a ::after box drawn wider than the 34px glyph, deliberately. The
      // concern this guarded -- attach being scrolled out of reach -- is covered
      // directly now: the row may not overflow, may not split over lines, and
      // every control in it must be on screen.
      // A control the layout has pushed off the screen is a control that is not
      // there. The strip may scroll, but nothing in it may be unreachable: at
      // 360px this caught the mode chip sitting wholly past the right edge.
      const stranded = c.strip.filter((control) => !control.inView);
      if (stranded.length) {
        throw new Error(name + ' pushes composer controls off the screen: ' + JSON.stringify(stranded));
      }
      // And each one stays a real target. 30px is under the 38px a landscape
      // phone uses and the 44px portrait does, so it only fires if a control has
      // collapsed rather than merely tightened.
      const tiny = c.strip.filter((control) => control.height < 30 || control.width < 24);
      if (tiny.length) throw new Error(name + ' collapses composer controls: ' + JSON.stringify(tiny));
      // Attach draws at 34px on a phone to buy the row its width back, so the
      // finger target is the ::after box rather than the button. A shrunken glyph
      // with a shrunken target would be the wrong trade. Only where a finger is
      // the pointer: the desktop layout has no ::after and does not need one.
      const [vw, vh] = shot.viewport.split('x').map(Number);
      const touchSized = vw <= 640 || vh <= 520;
      if (touchSized && c.attach.height < 44) {
        const target = c.attachTarget || { w: 0, h: 0 };
        if (target.w < 44 || target.h < 44) {
          throw new Error(name + ' shrank the attach button without keeping its 44px target: ' + JSON.stringify({ button: c.attach, target }));
        }
      }
      if (!c.attach) throw new Error(name + ' has no attach button');
      if (!c.attach.inView) throw new Error(name + ' puts the attach button off screen: ' + JSON.stringify(c.attach));
      // Attach leads the row. This is the layout, so it is asserted rather than
      // assumed: anything to the left of it means the order has been rearranged.
      const leftOfAttach = c.strip.filter((control) => control.id !== '#attachTrigger' && control.left < c.attach.left);
      if (leftOfAttach.length) {
        throw new Error(name + ' no longer leads the row with attach: ' + JSON.stringify(leftOfAttach));
      }
      // And one row, on one line. The old layout guaranteed attach stayed put by
      // giving it a line of its own; this one guarantees it by making the row
      // unable to overflow, so the guarantee has to be checked directly.
      if (c.settingsScrolls) {
        throw new Error(name + ' overflows the composer row instead of shrinking the model name: ' + JSON.stringify(c));
      }
      const lines = [...new Set(c.strip.map((control) => control.centreY))];
      if (lines.length > 1) {
        throw new Error(name + ' splits the composer row over ' + lines.length + ' lines: ' + JSON.stringify(c.strip));
      }
    }

    // The shape a prompt will be drawn at is shown while it can still be
    // changed, in the row that already exists. Driven through the real
    // textarea, so this is the shipped handler and not a description of it.
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: url + '-size-hint' });
    await waitFor(() => evaluate('!!document.getElementById("chatInput")'), 'size hint page');
    await sleep(300);
    const sizeHint = await evaluate(`(() => {
      // The mode is set, not toggled: two cases in a row that both want it on
      // would otherwise cancel each other out and the second would test a state
      // nobody asked for.
      const type = (text, wantMode) => {
        if (imageMode !== wantMode) toggleImageMode();
        chatInput.value = text;
        chatInput.dispatchEvent(new Event('input'));
        const hint = document.getElementById('sizeHint');
        const row = hint.getBoundingClientRect();
        const input = chatInput.getBoundingClientRect();
        return {
          hidden: hint.hidden, text: hint.textContent, title: hint.title,
          besideInput: Math.abs(row.top - input.top) < input.height,
          onScreen: row.left >= -1 && row.right <= innerWidth + 1,
        };
      };
      const out = {
        wide: type('draw a 16:9 banner for the shop front', true),
        spelled: type('a 1536x1024 photo of a harbour', true),
        plain: type('draw a fox', true),
        chat: type('a 16:9 banner for the shop front', false),
        cleared: type('', false),
      };
      // The one state the hint cannot resolve: a picture already on screen and
      // nothing attached, where the turn may edit that picture (shape word
      // dropped, its own shape kept) or draw a new one (shape word read). It
      // reads the word and says that reading is conditional -- here in a real
      // browser, because "the promise is hedged" is not something a unit test
      // proving the string exists can tell you is true on the page.
      out.conditional = (() => {
        const entry = { type: 'bot', content: '[Generated image: hint probe]', images: [{ url: 'data:image/png;base64,HINT', prompt: 'a fox' }] };
        messages.push(entry);
        if (imageMode !== true) toggleImageMode();
        chatInput.value = 'draw a wide banner';
        chatInput.dispatchEvent(new Event('input'));
        const hint = document.getElementById('sizeHint');
        const shape = document.getElementById('sessionImageShape');
        const said = {
          hidden: hint.hidden, text: hint.textContent, title: hint.title,
          aria: hint.getAttribute('aria-label') || '',
          panel: shape ? shape.textContent : '',
        };
        messages.pop();
        chatInput.value = 'draw a fox';
        chatInput.dispatchEvent(new Event('input'));
        said.afterWithdraw = document.getElementById('sizeHint').title;
        return said;
      })();
      // Put the page back the way it was found.
      chatInput.value = '';
      chatInput.dispatchEvent(new Event('input'));
      if (chatInput.placeholder !== 'Ask anything...') toggleImageMode();
      return out;
    })()`);
    console.log('size hint: ' + JSON.stringify(sizeHint));
    if (sizeHint.wide.hidden || sizeHint.wide.text !== '16:9') {
      throw new Error('a 16:9 prompt did not show 16:9: ' + JSON.stringify(sizeHint.wide));
    }
    if (!/1536x864/.test(sizeHint.wide.title)) {
      throw new Error('the hint did not say which pixels 16:9 means: ' + JSON.stringify(sizeHint.wide));
    }
    if (!sizeHint.wide.besideInput || !sizeHint.wide.onScreen) {
      throw new Error('the hint is not in the input row: ' + JSON.stringify(sizeHint.wide));
    }
    if (sizeHint.spelled.hidden || sizeHint.spelled.text !== '3:2') {
      throw new Error('a spelled-out size was not read: ' + JSON.stringify(sizeHint.spelled));
    }
    for (const quiet of ['plain', 'chat', 'cleared']) {
      if (!sizeHint[quiet].hidden) {
        throw new Error(quiet + ' promised a shape it will not send: ' + JSON.stringify(sizeHint[quiet]));
      }
    }
    if (sizeHint.conditional.hidden || sizeHint.conditional.text !== '16:9') {
      throw new Error('a shape word with a picture on screen is still the reading to show: ' + JSON.stringify(sizeHint.conditional));
    }
    if (!/if this makes a new picture/.test(sizeHint.conditional.title) || !/if this makes a new picture/.test(sizeHint.conditional.aria)) {
      throw new Error('the conditional shape word was promised outright: ' + JSON.stringify(sizeHint.conditional));
    }
    if (!/may edit it instead/.test(sizeHint.conditional.panel)) {
      throw new Error('the panel did not carry the same caveat in words: ' + JSON.stringify(sizeHint.conditional));
    }
    if (/if this makes a new picture/.test(sizeHint.conditional.afterWithdraw)) {
      throw new Error('the caveat outlived the picture that caused it: ' + JSON.stringify(sizeHint.conditional));
    }

    // The same hint on the screen with the least room for it: it sits in the
    // input row beside a textarea that has to keep typing room, so the row is the
    // thing to look at rather than the pill.
    await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 1, mobile: true });
    await send('Page.navigate', { url: url + '-size-hint-phone' });
    await waitFor(() => evaluate('!!document.getElementById("chatInput")'), 'phone size hint page');
    await sleep(300);
    const phoneHint = await evaluate(`(() => {
      if (imageMode !== true) toggleImageMode();
      chatInput.value = 'draw a 16:9 banner for the shop front';
      chatInput.dispatchEvent(new Event('input'));
      const hint = document.getElementById('sizeHint');
      const row = document.querySelector('.composer-input-row').getBoundingClientRect();
      const box = hint.getBoundingClientRect();
      const send = document.getElementById('sendButton').getBoundingClientRect();
      return {
        text: hint.textContent, hidden: hint.hidden,
        inRow: box.width > 0 && box.top >= row.top - 1 && box.bottom <= row.bottom + 1,
        typingRoom: Math.round(chatInput.getBoundingClientRect().width),
        sendInView: send.right <= innerWidth + 1 && send.left >= -1,
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
      };
    })()`);
    console.log('size hint on a 360px phone: ' + JSON.stringify(phoneHint));
    if (phoneHint.hidden || phoneHint.text !== '16:9') {
      throw new Error('the size hint is not shown on a phone: ' + JSON.stringify(phoneHint));
    }
    if (!phoneHint.inRow || !phoneHint.sendInView || phoneHint.overflow) {
      throw new Error('the size hint breaks the composer on a phone: ' + JSON.stringify(phoneHint));
    }
    if (phoneHint.typingRoom < 120) {
      throw new Error('the size hint leaves no room to type: ' + JSON.stringify(phoneHint));
    }

    // The shape that was asked for is cut out of the picture that came back.
    //
    // The unit tests decide the rectangle against a stubbed canvas; this is the
    // only place the bytes are really re-encoded, so it is the only place that
    // can catch a cut that plans the right rectangle and draws the wrong one.
    // The source is a square whose kept region is painted and whose dropped
    // edges are another colour, so a cut that took the wrong part of the picture
    // is visible rather than merely plausible.
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: url + '-image-shape' });
    await waitFor(() => evaluate('typeof reframeToRequestedShape === "function" && typeof imageSizeFromPrompt === "function"'), 'shape page');
    await sleep(250);
    const shapeCut = await evaluate(`(async () => {
      const source = document.createElement('canvas');
      source.width = 1024; source.height = 1024;
      const paint = source.getContext('2d');
      paint.fillStyle = '#00ff00';
      paint.fillRect(0, 0, 1024, 1024);
      paint.fillStyle = '#ff0000';
      paint.fillRect(0, 224, 1024, 576);
      paint.fillStyle = '#0000ff';
      paint.fillRect(224, 0, 576, 1024);
      const original = source.toDataURL('image/png');
      const read = async (dataUrl) => {
        const img = await new Promise((resolve) => {
          const probe = new Image();
          probe.onload = () => resolve(probe);
          probe.src = dataUrl;
        });
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const at = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3).join(',');
        return {
          w: img.naturalWidth,
          h: img.naturalHeight,
          topLeft: at(2, 2),
          topRight: at(img.naturalWidth - 3, 2),
          bottom: at(2, img.naturalHeight - 3),
        };
      };
      const cutTo = async (words) => {
        const outcome = { notes: [] };
        const cut = await reframeToRequestedShape(original, imageSizeFromPrompt(words, { words: true }), outcome);
        return { ...(await read(cut)), substituted: cut !== original, note: outcome.notes[0] || '' };
      };
      return { wide: await cutTo('a 16:9 banner'), tall: await cutTo('a 9:16 poster'), square: await cutTo('1:1') };
    })()`);
    console.log('shape cut: ' + JSON.stringify(shapeCut));
    // Red where the 16:9 cut keeps, green where it drops: a cut from the top of
    // the square would come back green, and one that kept the square would not
    // be 1024x576 at all.
    if (shapeCut.wide.w !== 1024 || shapeCut.wide.h !== 576 || shapeCut.wide.topLeft !== '255,0,0' || shapeCut.wide.topRight !== '255,0,0' || shapeCut.wide.bottom !== '255,0,0') {
      throw new Error('a 16:9 request was not cut to the middle of the picture: ' + JSON.stringify(shapeCut.wide));
    }
    if (!/cut to 16:9 \(1024×576\)/.test(shapeCut.wide.note)) {
      throw new Error('the cut was not reported on the outcome: ' + JSON.stringify(shapeCut.wide));
    }
    if (shapeCut.tall.w !== 576 || shapeCut.tall.h !== 1024 || shapeCut.tall.topLeft !== '0,0,255' || shapeCut.tall.bottom !== '0,0,255') {
      throw new Error('a 9:16 request was not cut to the middle columns: ' + JSON.stringify(shapeCut.tall));
    }
    if (shapeCut.square.substituted) {
      throw new Error('a square request was re-encoded for nothing: ' + JSON.stringify(shapeCut.square));
    }

    // The shell tool, driven through the real page: the dialog names the command,
    // and the answer comes back as a result.
    //
    // It cannot really run here. The route refuses to be a shell on an app with
    // no login configured -- every visitor would get one -- so what this proves is
    // the wiring: that the call is dispatched to the shell runner, that the
    // command is put to the user verbatim before the request is sent at all, and
    // that the refusal arrives as the model-visible result rather than as a
    // broken turn. The execution itself is proved against a real server in
    // test/workspace-run.test.js.
    await send('Page.navigate', { url: url + '-run-tool' });
    await waitFor(() => evaluate('typeof runCommandTool === "function" && !!document.getElementById("githubConfirmOverlay")'), 'run tool page');
    await sleep(200);
    const runTool = await evaluate(`(async () => {
      const opened = new Promise((resolve) => {
        const check = () => {
          const overlay = document.getElementById('githubConfirmOverlay');
          if (overlay && overlay.classList.contains('open')) resolve(document.getElementById('githubConfirmText').textContent);
          else setTimeout(check, 20);
        };
        check();
      });
      const pending = runCommandTool('run_command', { command: 'node make-pdf.js' });
      const asked = await opened;
      githubConfirmResolve('once');
      const result = await pending;
      return {
        asked,
        title: document.getElementById('githubConfirmTitle').textContent,
        result,
        buildOffered: toolsForMode('build', RUN_TOOLS).length,
        chatOffered: toolsForMode('chat', RUN_TOOLS).length,
      };
    })()`);
    console.log('run tool: ' + JSON.stringify(runTool));
    if (!/node make-pdf\.js/.test(runTool.asked)) {
      throw new Error('the command was not put to the user before it was sent: ' + JSON.stringify(runTool));
    }
    if (!/server/.test(runTool.title)) throw new Error('the dialog does not say where it runs: ' + runTool.title);
    // The reason that fires here is the login one, not the switch: this app has
    // WORKSPACE_RUN set and no accounts, which is the combination that would hand
    // a shell to any visitor.
    if (!/needs a login/.test(runTool.result)) {
      throw new Error('the refusal never reached the model: ' + JSON.stringify(runTool));
    }
    if (runTool.buildOffered !== 1 || runTool.chatOffered !== 0) {
      throw new Error('the shell is offered in the wrong modes: ' + JSON.stringify(runTool));
    }

    // And the settings surface for what the server workspace holds says the same
    // thing, in the same words, rather than loading forever.
    const serverFiles = await evaluate(`(async () => {
      switchView('settings');
      await renderServerWorkspaceFiles();
      return {
        status: document.getElementById('serverWorkspaceStatus').textContent,
        rows: document.getElementById('serverWorkspaceFileList').children.length,
      };
    })()`);
    console.log('server files: ' + JSON.stringify(serverFiles));
    if (!/login/.test(serverFiles.status)) {
      throw new Error('the server files list does not say why it is empty: ' + JSON.stringify(serverFiles));
    }

    // The session panel floats, so opening it must not resize the conversation
    // and must not sit on the composer. One surface means the overlap rule the
    // two cards needed has nothing left to arbitrate.
    for (const [name, shot] of Object.entries({ desktop, wideDesktop, portrait, landscape, small })) {
      const p = shot.session;
      const viewportWidth = Number(shot.viewport.split('x')[0]);
      const viewportHeight = Number(shot.viewport.split('x')[1]);
      if (!p) throw new Error(name + ' has no session panel at all');
      if (p.closedWidth !== p.openWidth) {
        throw new Error(name + ' resizes the conversation when the panel opens: ' + p.closedWidth + ' -> ' + p.openWidth);
      }
      // A pop-up or a takeover? The same breakpoint the stylesheet uses: a
      // small width or a short viewport turns the panel into a drawer.
      const desktopShaped = viewportWidth > 640 && viewportHeight > 520;
      if (!p.kept) throw new Error(name + ' refused to open the session panel');
      const imageTab = (p.tabs || []).find((tab) => tab.tab === 'image');
      const puterSwitch = imageTab && (imageTab.controls || []).some((c) => c.id === 'imagePuterSwitch');
      if (!puterSwitch) {
        throw new Error(name + ' has no Draw-with-Puter switch in the image section: ' + JSON.stringify(imageTab));
      }
      if (!p.doors.some(Boolean)) {
        throw new Error(name + ' leaves the session panel with nothing to open it: ' + JSON.stringify(p.doors));
      }
      const box = p.shown;
      if (!box || box.width < 180) throw new Error(name + ' draws an unusably small session panel: ' + JSON.stringify(box));
      if (box.opacity < 0.9) throw new Error(name + ' claims the panel is open but paints it at ' + box.opacity);
      if (box.pointer === 'none') throw new Error(name + ' opens the panel and then ignores clicks on it');
      if (box.left < -1 || box.right > viewportWidth + 1 || box.top < -1 || box.bottom > viewportHeight + 1) {
        throw new Error(name + ' puts the session panel off screen: ' + JSON.stringify(box));
      }
      // The three sections really are one at a time, and the pressed tab is the
      // one on screen. A surface whose tabs all draw at once is a column of
      // everything, which is what this consolidation was meant to end.
      for (const tab of p.tabs) {
        if (tab.drawn.length !== 1 || tab.drawn[0] !== tab.tab) {
          throw new Error(name + ' draws the wrong session sections for ' + tab.tab + ': ' + JSON.stringify(tab));
        }
        if (tab.pressed !== 'true') {
          throw new Error(name + ' leaves the ' + tab.tab + ' tab unpressed while showing it');
        }
        const unreachable = (tab.controls || []).filter((control) => !control.inView);
        if (unreachable.length) {
          throw new Error(name + ' puts ' + tab.tab + ' controls out of reach: ' + JSON.stringify(unreachable));
        }
      }
      // A panel that floats beside the chat must stop above the composer, so
      // Send stays reachable with a list open. A drawer is a different shape and
      // answers a different question -- it covers the composer on purpose,
      // behind a scrim that has to be there.
      if (desktopShaped) {
        if (p.overComposer) {
          throw new Error(name + ' runs the session panel into the composer: ' + JSON.stringify({ panelBottom: box.bottom, composerTop: shot.composer.top }));
        }
        // And it sits under the bar, never over it: the button that closes it
        // lives up there.
        if (box.top < p.bar.bottom - 1) {
          throw new Error(name + ' runs the session panel over the bar: ' + JSON.stringify({ panelTop: box.top, barBottom: p.bar.bottom }));
        }
      } else {
        const scrim = p.scrim;
        if (!scrim || scrim.opacity < 0.1 || scrim.pointer === 'none') {
          throw new Error(name + ' opens the drawer with nothing guarding the rest of the screen: ' + JSON.stringify(scrim));
        }
        if (scrim.width < viewportWidth * 0.5) {
          throw new Error(name + ' leaves most of the screen live behind the drawer: ' + JSON.stringify(scrim));
        }
        // A portrait phone has no room beside anything, so the drawer is a
        // takeover. A landscape one is wide enough for a narrower strip, which
        // is exactly what the landscape block narrows it to.
        if (viewportWidth <= 400 && box.width < viewportWidth * 0.6) {
          throw new Error(name + ' drawer is not a takeover: ' + JSON.stringify(box));
        }
      }
      // The closed state is gone, not merely faint, and out of reach.
      if (p.hidden) {
        const clear = p.hidden.opacity === 0 || p.hidden.right <= 0 || p.hidden.left >= viewportWidth;
        if (!clear || p.hidden.pointer !== 'none') {
          throw new Error(name + ' leaves the closed panel in the way: ' + JSON.stringify(p.hidden));
        }
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
      const gallery = {
        stored: !!(entry.images && entry.images.length),
        // The bytes went to the picture index and the entry is a name for them
        // rather than a copy of them, which is what keeps the picture the size
        // it was drawn.
        kept: !!(entry.images && entry.images[0] && entry.images[0].id),
        inline: !!(entry.images && entry.images[0] && entry.images[0].url),
        rendered: !!image,
      };

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
    if (!behavior.gallery.stored || !behavior.gallery.kept || behavior.gallery.inline || !behavior.gallery.rendered) {
      throw new Error('generated image did not survive into the Gallery as stored bytes: ' + JSON.stringify(behavior.gallery));
    }

    // The keyboard has to be able to see where it is. A real Tab, dispatched
    // through the browser rather than a scripted .focus(), because :focus-visible
    // is exactly what a scripted focus does not match -- so a test that focuses
    // an element by hand can pass while every ring in the app is invisible.
    await evaluate('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
    const focusRings = [];
    for (let i = 0; i < 4; i++) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      await sleep(60);
      focusRings.push(await evaluate(`(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return { focused: false };
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        return {
          focused: true,
          tag: el.tagName,
          id: el.id || el.className || '',
          ring: style.boxShadow !== 'none' || (style.outlineStyle !== 'none' && style.outlineWidth !== '0px'),
          onScreen: box.width > 0 && box.height > 0 && box.left >= -1 && box.right <= innerWidth + 1,
        };
      })()`));
    }
    console.log('focus rings: ' + JSON.stringify(focusRings));
    // A Tab past the last control in the document hands focus to the browser's
    // own chrome, and activeElement reads as the body. That is the browser's
    // cycle rather than a hole in the app, so those stops are counted but not
    // judged. What has to hold is that the app is keyboard-reachable at all,
    // that what it focuses is on screen, and that it draws a ring.
    const tabbable = focusRings.filter((stop) => stop.focused);
    if (tabbable.length < 2) throw new Error('the keyboard cannot reach the app: ' + JSON.stringify(focusRings));
    for (const stop of tabbable) {
      if (!stop.onScreen) throw new Error('Tab focused an element that is not on screen: ' + JSON.stringify(stop));
      if (!stop.ring) throw new Error('the focused element draws no focus ring: ' + JSON.stringify(stop));
    }

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

    // A picture survives a reload at the size it was drawn.
    //
    // This is the join the whole thing turns on: a conversation names its
    // pictures by id rather than carrying their bytes, so nothing but the index
    // can put one back -- and a 1536x864 drawing returning as a 1024px re-encode
    // is the bug that started this. Measured from the decoded <img> after a real
    // reload, because that is the only place the second half of it can be seen.
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: url + '-image-store' });
    await waitFor(() => evaluate('typeof storeGeneratedImages === "function" && !!document.getElementById("chatInput")'), 'picture index page');
    await sleep(300);
    const storedPicture = await evaluate(`(async () => {
      chatMessages.innerHTML = '';
      messages = [];
      const canvas = document.createElement('canvas');
      canvas.width = 1536; canvas.height = 864;
      canvas.getContext('2d').fillRect(0, 0, 1536, 864);
      const entry = { type: 'bot', content: '[Generated image: a 1536x864 picture]' };
      messages.push(entry);
      await storeGeneratedImages(entry, [canvas.toDataURL('image/png')], 'a 1536x864 picture');
      persistMessages();
      const saved = (entry.images && entry.images[0]) ? entry.images[0] : {};
      const raw = localStorage.getItem('puterChatConversations') || '';
      return { kept: !!saved.id, bytes: saved.bytes || 0, carriedBytes: raw.indexOf('data:image') !== -1 };
    })()`);
    console.log('picture index: ' + JSON.stringify(storedPicture));
    if (!storedPicture.kept) throw new Error('the picture was not kept in the index: ' + JSON.stringify(storedPicture));
    if (storedPicture.carriedBytes) throw new Error('the picture is still being carried inside localStorage: ' + JSON.stringify(storedPicture));
    if (storedPicture.bytes < 1) throw new Error('nothing was kept for the picture to come back as: ' + JSON.stringify(storedPicture));

    await send('Page.navigate', { url: url + '-image-store' });
    await waitFor(() => evaluate('!!document.querySelector("#chatMessages .message-image")'), 'restored picture');
    await sleep(200);
    const restoredPicture = await evaluate(`(async () => {
      const img = document.querySelector('#chatMessages .message-image');
      if (!img) return { found: false };
      if (!img.complete) await new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 2000);
      });
      return { found: true, w: img.naturalWidth, h: img.naturalHeight, tools: !!document.querySelector('#chatMessages .message-actions') };
    })()`);
    console.log('picture restored: ' + JSON.stringify(restoredPicture));
    if (!restoredPicture.found || restoredPicture.w !== 1536 || restoredPicture.h !== 864) {
      throw new Error('the picture came back at the wrong size: ' + JSON.stringify(restoredPicture));
    }
    if (!restoredPicture.tools) throw new Error('the restored picture has no Download beside it: ' + JSON.stringify(restoredPicture));

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
