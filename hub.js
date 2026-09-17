// FreeAI4U hub: the Chat | Plan | Build switch, the Builds panel (remote build
// sessions with live steps and per-change approvals) and the Knowledges hub
// (skills, tools per mode, commands).
//
// Loaded by index.html after the main script, and kept out of that file on
// purpose: it talks to the page through a handful of globals the page already
// has (selectedMode, setChatMode, pinSkillForChat, showStatus...) and nothing
// else, so the 10,000-line page only gains a few one-line hooks.
//
// Everything a server or a model wrote is put on screen with textContent, never
// innerHTML: a build's output is model text, and model text is untrusted.
(function (root) {
  'use strict';

  // --- Pure helpers (also exported for the node tests) ---

  const WAITING = ['awaiting_approval', 'awaiting_input'];
  const RUNNING = ['queued', 'running'];
  const FINISHED = ['done', 'failed', 'cancelled', 'expired'];

  const STATUS_LABELS = {
    queued: 'Queued',
    running: 'Running',
    awaiting_approval: 'Needs approval',
    awaiting_input: 'Needs an answer',
    done: 'Done',
    failed: 'Failed',
    cancelled: 'Cancelled',
    expired: 'Expired',
  };

  function statusLabel(status) {
    return STATUS_LABELS[status] || String(status || '');
  }

  // A reply is worth offering to build when it reads like a plan: at least two
  // numbered steps, or at least three bullet lines.
  function looksLikePlan(text) {
    const lines = String(text || '').split(/\r?\n/);
    const numbered = lines.filter((l) => /^\s*(?:step\s*)?\d{1,3}[.):]\s+\S/i.test(l)).length;
    const bullets = lines.filter((l) => /^\s*[-*+]\s+(?:\[[ xX]?\]\s*)?\S/.test(l)).length;
    return numbered >= 2 || bullets >= 3;
  }

  // What the header badge shows: builds waiting on you outrank builds running.
  function badgeFor(sessions) {
    const list = Array.isArray(sessions) ? sessions : [];
    const waiting = list.filter((s) => WAITING.includes(s && s.status)).length;
    if (waiting) return { kind: 'waiting', text: String(waiting) };
    if (list.some((s) => RUNNING.includes(s && s.status))) return { kind: 'running', text: '' };
    return null;
  }

  // Diff text into lines tagged add / del / ctx, for colouring.
  function diffLines(patch) {
    return String(patch || '').split('\n').map((line) => ({
      kind: line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx',
      text: line,
    }));
  }

  function timeAgo(ts, now) {
    const secs = Math.max(0, Math.round(((now || Date.now()) - Number(ts || 0)) / 1000));
    if (secs < 60) return 'just now';
    if (secs < 3600) return Math.round(secs / 60) + ' min ago';
    if (secs < 86400) return Math.round(secs / 3600) + ' h ago';
    return Math.round(secs / 86400) + ' d ago';
  }

  // The first step and the progress, for a list row.
  function planTitle(session) {
    const steps = session && Array.isArray(session.steps) ? session.steps : [];
    const first = steps.length ? steps[0].title : '';
    const total = steps.length;
    const done = steps.filter((s) => s.status === 'done').length;
    return { title: first || 'Build', progress: total ? done + '/' + total + ' steps' : '' };
  }

  // The Windows app opens the page with ?app=desktop. The flag is remembered,
  // because the login redirect drops the query string on the first visit.
  function appModeFrom(search, stored) {
    const wanted = new URLSearchParams(String(search || '')).get('app');
    if (wanted === 'desktop' || wanted === 'web') return wanted === 'desktop' ? 'desktop' : '';
    return stored === 'desktop' ? 'desktop' : '';
  }

  // Keyboard shortcuts, the same in the browser and the desktop app:
  //   Alt+1 / Alt+2 / Alt+3   Chat / Plan / Build
  //   Ctrl+Shift+B            Builds panel
  //   Ctrl+Shift+K            Knowledges
  function shortcutFor(e) {
    if (!e) return null;
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const modes = { Digit1: 'chat', Digit2: 'plan', Digit3: 'build' };
      if (modes[e.code]) return { kind: 'mode', mode: modes[e.code] };
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
      if (e.code === 'KeyB') return { kind: 'panel', tab: 'builds' };
      if (e.code === 'KeyK') return { kind: 'panel', tab: 'knowledges' };
    }
    return null;
  }

  const SHORTCUTS = [
    ['Alt+1 · Alt+2 · Alt+3', 'Switch to Chat, Plan or Build'],
    ['Ctrl+Shift+B', 'Open or close the Builds panel'],
    ['Ctrl+Shift+K', 'Open Knowledges'],
    ['Esc', 'Close the panel'],
  ];

  const helpers = { statusLabel, looksLikePlan, badgeFor, diffLines, timeAgo, planTitle, appModeFrom, shortcutFor, SHORTCUTS, WAITING, RUNNING, FINISHED };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = helpers;
  }
  if (!root.document) return;

  // Browser globals, read off the global object so the file also loads (for its
  // helpers) under node, where none of these exist.
  const document = root.document;
  const requestAnimationFrame = (fn) => root.requestAnimationFrame(fn);

  // --- DOM plumbing ---

  const API = '/api/build/sessions';
  const DOCK_MIN_WIDTH = 1100;
  // Static markup only: these strings never contain data.
  const ICONS = {
    hammer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 12-8.5 8.5a2.12 2.12 0 1 1-3-3L12 9"/><path d="M17.64 15 22 10.64"/><path d="m20.91 11.7-1.25-1.25a1.9 1.9 0 0 1-.55-1.34V7.5l-2.46-2.46A6 6 0 0 0 12.5 3.3l-.9-.02 1.6 1.6c.4.4.6.93.6 1.47v1.3l1.8 1.8h1.3c.54 0 1.07.2 1.47.6l1.6 1.6"/></svg>',
    book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  };

  // el('div', { class: 'x', text: 'hi', onclick: fn, 'aria-label': '…' }, child, child)
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'icon') node.innerHTML = ICONS[value] || '';
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  async function api(path, options) {
    const opts = options || {};
    const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, init);
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error) || ('Request failed (' + res.status + ')'));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function status(kind, text) {
    if (typeof root.showStatus === 'function') root.showStatus(kind, text);
  }

  function remember(key, value) {
    try { root.localStorage.setItem(key, value); } catch { /* private mode */ }
  }

  function recall(key) {
    try { return root.localStorage.getItem(key); } catch { return null; }
  }

  // --- State ---

  const state = {
    tab: recall('freeai4uHubTab') === 'knowledges' ? 'knowledges' : 'builds',
    buildInfo: null,
    sessions: [],
    view: 'list',
    detail: null,
    source: null,
    pending: null,
    skills: null,
    skillFilter: '',
    kTab: 'skills',
    draft: { plan: '', repo: '', branch: '' },
    lastFocus: null,
    pollTimer: null,
    desktop: false,
  };

  let overlay = null;
  let body = null;
  let tabButtons = {};

  // --- The sheet ---

  function ensureSheet() {
    if (overlay) return;
    const tabs = el('div', { class: 'hub-tabs', role: 'tablist', 'aria-label': 'Hub sections' });
    tabButtons = {
      builds: el('button', { class: 'hub-tab', type: 'button', role: 'tab', id: 'hubTabBuilds', text: 'Builds', onclick: () => showTab('builds') }),
      knowledges: el('button', { class: 'hub-tab', type: 'button', role: 'tab', id: 'hubTabKnowledges', text: 'Knowledges', onclick: () => showTab('knowledges') }),
    };
    tabs.append(tabButtons.builds, tabButtons.knowledges);
    body = el('div', { class: 'hub-body', role: 'tabpanel', tabindex: '-1' });
    const sheet = el('aside', { class: 'hub-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'FreeAI4U hub' },
      el('div', { class: 'hub-head' },
        tabs,
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', title: 'Close (Esc)', icon: 'close', onclick: close })),
      body);
    overlay = el('div', { class: 'hub-overlay', id: 'hubOverlay', hidden: true, onclick: (e) => { if (e.target === overlay) close(); } }, sheet);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay && !overlay.hidden) {
        e.stopPropagation();
        close();
      }
    }, true);
  }

  // In the desktop app on a wide window the panel docks beside the chat instead
  // of covering it, so a build can be watched and approved while chatting.
  function dockable() {
    return state.desktop && root.innerWidth >= DOCK_MIN_WIDTH;
  }

  function open(tab) {
    ensureSheet();
    const docked = dockable();
    if (!docked) state.lastFocus = document.activeElement;
    overlay.hidden = false;
    overlay.querySelector('.hub-sheet').setAttribute('aria-modal', docked ? 'false' : 'true');
    if (docked) {
      document.documentElement.dataset.hubDocked = '1';
      remember('freeai4uDock', 'open');
    }
    requestAnimationFrame(() => overlay.classList.add('open'));
    showTab(tab || state.tab);
  }

  function close() {
    if (!overlay || overlay.hidden) return;
    overlay.classList.remove('open');
    disconnect();
    if (document.documentElement.dataset.hubDocked) {
      delete document.documentElement.dataset.hubDocked;
      remember('freeai4uDock', 'closed');
    }
    setTimeout(() => { overlay.hidden = true; }, 160);
    if (state.lastFocus && typeof state.lastFocus.focus === 'function') state.lastFocus.focus();
    state.lastFocus = null;
  }

  function isOpen() {
    return !!overlay && !overlay.hidden;
  }

  function showTab(tab) {
    state.tab = tab === 'knowledges' ? 'knowledges' : 'builds';
    remember('freeai4uHubTab', state.tab);
    for (const [name, btn] of Object.entries(tabButtons)) btn.setAttribute('aria-selected', String(name === state.tab));
    body.setAttribute('aria-labelledby', state.tab === 'builds' ? 'hubTabBuilds' : 'hubTabKnowledges');
    if (state.tab === 'builds') {
      if (state.view === 'detail' && state.detail) openBuild(state.detail.id);
      else if (state.view === 'new') renderNewBuild();
      else loadBuilds();
    } else {
      disconnect();
      renderKnowledges();
    }
  }

  function clearBody(...nodes) {
    body.replaceChildren(...nodes);
    body.scrollTop = 0;
  }

  // --- Builds: list ---

  async function refreshBuildInfo() {
    const info = await api(API);
    state.buildInfo = info;
    state.sessions = Array.isArray(info.sessions) ? info.sessions : [];
    updateBadge();
    return info;
  }

  async function loadBuilds() {
    state.view = 'list';
    disconnect();
    clearBody(el('p', { class: 'hub-sub', text: 'Loading builds…' }));
    let info;
    try {
      info = await refreshBuildInfo();
    } catch (err) {
      clearBody(el('div', { class: 'hub-notice bad', text: 'Could not load builds: ' + err.message }));
      return;
    }
    if (state.tab !== 'builds' || state.view !== 'list') return;
    const head = el('div', { class: 'hub-row spread' },
      el('div', null,
        el('h2', { class: 'hub-title', text: 'Builds' }),
        el('p', { class: 'hub-sub', text: 'Plans carried out on the server. Every change waits for your approval.' })),
      el('button', { class: 'hub-btn primary', type: 'button', text: 'New build', disabled: !info.enabled, onclick: () => renderNewBuild() }));
    const nodes = [head];
    if (!info.enabled) nodes.push(el('div', { class: 'hub-notice bad', text: info.reason || 'Builds are off on this server.' }));
    else if (!info.runEnabled) nodes.push(el('div', { class: 'hub-notice', text: 'Commands are off on this server, so builds can write files but cannot run tests. Set WORKSPACE_RUN=1 on Railway to allow commands (each one still asks you first).' }));
    if (info.enabled && !state.sessions.length) {
      nodes.push(el('div', { class: 'hub-notice ok', text: 'No builds yet. Write a plan in Plan mode, then press "Build" under the reply, or start one here. Builds started from the phone show up here too.' }));
    }
    const list = el('ul', { class: 'hub-list' });
    for (const s of state.sessions) {
      const { title, progress } = planTitle(s);
      list.appendChild(el('li', null,
        el('button', { class: 'hub-card', type: 'button', onclick: () => openBuild(s.id) },
          el('div', { class: 'hub-row spread' },
            el('span', { class: 'hub-pill', dataset: { status: s.status }, text: statusLabel(s.status) }),
            el('span', { class: 'hub-card-meta', text: timeAgo(s.startedAt) })),
          el('div', { class: 'hub-card-title', text: title }),
          el('div', { class: 'hub-card-meta', text: [progress, s.repo, s.model].filter(Boolean).join(' · ') }))));
    }
    if (state.sessions.length) nodes.push(list);
    clearBody(...nodes);
  }

  // --- Builds: new ---

  function lastPlanFromChat() {
    const bots = document.querySelectorAll('#chatMessages .message.bot');
    for (let i = bots.length - 1; i >= 0; i--) {
      const text = bots[i].dataset.rawContent || '';
      if (looksLikePlan(text)) return text;
    }
    return '';
  }

  function renderNewBuild(prefill) {
    state.view = 'new';
    disconnect();
    if (typeof prefill === 'string' && prefill.trim()) state.draft.plan = prefill.trim();
    const plan = el('textarea', { class: 'hub-textarea', id: 'hubPlan', rows: '10', placeholder: '1. Create index.html with a hello page\n2. Add a test\n3. Run the test', 'aria-label': 'Plan' });
    plan.value = state.draft.plan;
    plan.addEventListener('input', () => { state.draft.plan = plan.value; });
    const repo = el('input', { class: 'hub-input', id: 'hubRepo', placeholder: 'owner/name (optional)', autocomplete: 'off', spellcheck: 'false' });
    repo.value = state.draft.repo;
    repo.addEventListener('input', () => { state.draft.repo = repo.value; });
    const branch = el('input', { class: 'hub-input', id: 'hubBranch', placeholder: 'main (optional)', autocomplete: 'off', spellcheck: 'false' });
    branch.value = state.draft.branch;
    branch.addEventListener('input', () => { state.draft.branch = branch.value; });
    const error = el('div', { class: 'hub-notice bad', hidden: true, role: 'alert' });
    const submit = el('button', { class: 'hub-btn primary', type: 'submit', text: 'Start build' });

    const form = el('form', { class: 'hub-form', onsubmit: async (e) => {
      e.preventDefault();
      error.hidden = true;
      if (!plan.value.trim()) {
        error.textContent = 'Write the plan first, or use the last plan from this chat.';
        error.hidden = false;
        plan.focus();
        return;
      }
      submit.disabled = true;
      submit.textContent = 'Starting…';
      try {
        const chatId = root.FreeAI4UPage && typeof root.FreeAI4UPage.chatId === 'function' ? String(root.FreeAI4UPage.chatId() || '') : '';
        const created = await api(API, { method: 'POST', body: { plan: plan.value, repo: repo.value.trim() || undefined, branch: branch.value.trim() || undefined, chatId } });
        state.draft = { plan: '', repo: '', branch: '' };
        status('success', 'Build started');
        openBuild(created.id);
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        submit.disabled = false;
        submit.textContent = 'Start build';
      }
    } },
    el('div', null, el('label', { class: 'hub-label', for: 'hubPlan', text: 'Plan' }), plan),
    el('div', { class: 'hub-row' },
      el('button', { class: 'hub-btn ghost', type: 'button', text: 'Use last plan from this chat', onclick: () => {
        const found = lastPlanFromChat();
        if (!found) { status('info', 'No plan-shaped reply in this chat yet'); return; }
        plan.value = found;
        state.draft.plan = found;
      } })),
    el('div', { class: 'hub-grid-2' },
      el('div', null, el('label', { class: 'hub-label', for: 'hubRepo', text: 'GitHub repo' }), repo),
      el('div', null, el('label', { class: 'hub-label', for: 'hubBranch', text: 'Branch' }), branch)),
    error,
    el('div', { class: 'hub-row' }, submit, el('button', { class: 'hub-btn ghost', type: 'button', text: 'Back', onclick: loadBuilds })));

    clearBody(
      el('div', { class: 'hub-row' },
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back to builds', icon: 'back', onclick: loadBuilds }),
        el('h2', { class: 'hub-title', text: 'New build' })),
      el('p', { class: 'hub-sub', text: 'The build agent works through these steps in a private folder on the server. It asks before every file change and command.' }),
      form);
    plan.focus();
  }

  // --- Builds: detail ---

  let detailNodes = null;

  async function openBuild(id) {
    state.view = 'detail';
    disconnect();
    clearBody(el('p', { class: 'hub-sub', text: 'Opening build…' }));
    let view;
    try {
      view = await api(API + '/' + encodeURIComponent(id));
    } catch (err) {
      clearBody(el('div', { class: 'hub-notice bad', text: 'Could not open that build: ' + err.message }),
        el('button', { class: 'hub-btn', type: 'button', text: 'Back', onclick: loadBuilds }));
      return;
    }
    if (state.tab !== 'builds' || state.view !== 'detail') return;
    state.detail = view;
    state.pending = null;

    const pill = el('span', { class: 'hub-pill', dataset: { status: view.status }, text: statusLabel(view.status) });
    const cancelBtn = el('button', { class: 'hub-btn danger', type: 'button', text: 'Cancel build', hidden: FINISHED.includes(view.status), onclick: () => cancelBuild(view.id) });
    const steps = el('ol', { class: 'hub-steps', 'aria-label': 'Steps' });
    const ask = el('div', { 'aria-live': 'assertive' });
    const timeline = el('div', { class: 'hub-timeline', 'aria-live': 'polite' });
    detailNodes = { pill, cancelBtn, steps, ask, timeline };
    renderSteps(view.steps);

    clearBody(
      el('div', { class: 'hub-row spread' },
        el('div', { class: 'hub-row' },
          el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back to builds', icon: 'back', onclick: loadBuilds }),
          el('h2', { class: 'hub-title', text: 'Build' }),
          pill),
        cancelBtn),
      el('p', { class: 'hub-sub', text: [view.repo ? view.repo + (view.branch ? '@' + view.branch : '') : '', view.provider + ' · ' + view.model, 'started ' + timeAgo(view.startedAt)].filter(Boolean).join(' · ') }),
      steps,
      ask,
      timeline);
    connect(view.id);
  }

  function renderSteps(steps) {
    if (!detailNodes) return;
    detailNodes.steps.replaceChildren(...(steps || []).map((s) => el('li', { class: 'hub-step', dataset: { status: s.status, id: s.id } },
      el('span', null,
        el('span', { class: 'hub-step-title', text: s.title }),
        s.note ? el('span', { class: 'hub-step-note', text: s.note }) : null))));
  }

  function setDetailStatus(value) {
    if (!state.detail || !detailNodes) return;
    state.detail.status = value;
    detailNodes.pill.dataset.status = value;
    detailNodes.pill.textContent = statusLabel(value);
    detailNodes.cancelBtn.hidden = FINISHED.includes(value);
    const row = state.sessions.find((s) => s.id === state.detail.id);
    if (row) row.status = value;
    updateBadge();
  }

  function addToTimeline(node) {
    if (!detailNodes) return;
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 120;
    detailNodes.timeline.appendChild(node);
    if (nearBottom) body.scrollTop = body.scrollHeight;
  }

  function preBlock(title, text, link) {
    const pre = el('pre', { class: 'hub-pre' });
    for (const line of diffLines(text)) {
      pre.appendChild(line.kind === 'ctx' ? document.createTextNode(line.text + '\n') : el('span', { class: line.kind, text: line.text }));
    }
    return el('div', { class: 'hub-block hub-event' },
      el('div', { class: 'hub-block-head' }, el('span', { text: title }), link || null),
      pre);
  }

  function renderAsk(event) {
    if (!detailNodes) return;
    state.pending = event;
    if (event.type === 'question') {
      const answer = el('textarea', { class: 'hub-input', rows: '2', 'aria-label': 'Your answer' });
      const send = el('button', { class: 'hub-btn primary', type: 'button', text: 'Send answer', onclick: () => {
        if (!answer.value.trim()) { answer.focus(); return; }
        sendInput({ requestId: event.requestId, text: answer.value.trim() }, send);
      } });
      detailNodes.ask.replaceChildren(el('div', { class: 'hub-ask' },
        el('p', { class: 'hub-ask-title', text: 'The build agent asks' }),
        el('div', { class: 'hub-say', text: event.question }),
        answer,
        el('div', { class: 'hub-row' }, send)));
      answer.focus();
      return;
    }
    const reason = el('input', { class: 'hub-input', placeholder: 'Why not? (optional, the agent reads this)', 'aria-label': 'Reason for rejecting' });
    const approve = el('button', { class: 'hub-btn primary', type: 'button', text: event.tool === 'run_command' ? 'Approve & run' : 'Approve', onclick: () => sendInput({ requestId: event.requestId, decision: 'approve' }, approve) });
    const reject = el('button', { class: 'hub-btn danger', type: 'button', text: 'Reject', onclick: () => sendInput({ requestId: event.requestId, decision: 'reject', text: reason.value.trim() || undefined }, reject) });
    detailNodes.ask.replaceChildren(el('div', { class: 'hub-ask' },
      el('p', { class: 'hub-ask-title', text: 'Approve: ' + (event.summary || event.tool) }),
      preBlock(event.tool, event.preview || ''),
      reason,
      el('div', { class: 'hub-row' }, approve, reject)));
    approve.focus();
  }

  function clearAsk() {
    state.pending = null;
    if (detailNodes) detailNodes.ask.replaceChildren();
  }

  async function sendInput(payload, button) {
    if (!state.detail) return;
    if (button) button.disabled = true;
    try {
      await api(API + '/' + encodeURIComponent(state.detail.id) + '/input', { method: 'POST', body: payload });
      // The stream often delivers the *next* question before this response
      // lands; only the card that was answered may be cleared.
      if (state.pending && state.pending.requestId === payload.requestId) clearAsk();
    } catch (err) {
      status('error', err.message);
      if (err.status === 409) openBuild(state.detail.id);
      else if (button) button.disabled = false;
    }
  }

  async function cancelBuild(id) {
    if (!root.confirm('Cancel this build? Changes already approved stay in its folder.')) return;
    try {
      const view = await api(API + '/' + encodeURIComponent(id) + '/cancel', { method: 'POST', body: {} });
      setDetailStatus(view.status);
      clearAsk();
    } catch (err) {
      status('error', err.message);
    }
  }

  function handleEvent(event) {
    if (!state.detail || !detailNodes) return;
    const d = state.detail;
    switch (event.type) {
      case 'status':
        setDetailStatus(event.status);
        if (!WAITING.includes(event.status)) clearAsk();
        break;
      case 'step': {
        if (event.phase === 'output') {
          addToTimeline(preBlock(event.title || 'output', event.text || ''));
          break;
        }
        const step = (d.steps || []).find((s) => s.id === event.id);
        if (step) {
          step.status = event.phase === 'started' ? 'in_progress' : event.phase;
          step.note = event.text || '';
          renderSteps(d.steps);
        }
        break;
      }
      case 'diff': {
        const link = state.buildInfo && state.buildInfo.runEnabled
          ? el('a', { href: '/api/workspace/file?path=' + encodeURIComponent(d.dir + '/' + event.path), target: '_blank', rel: 'noopener', text: 'Open' })
          : null;
        addToTimeline(preBlock((event.created ? 'Created ' : 'Changed ') + event.path + ' · ' + event.bytes + ' bytes', event.patch || '', link));
        break;
      }
      case 'approval':
      case 'question':
        renderAsk(event);
        notifyWaiting();
        break;
      case 'answer':
        addToTimeline(el('div', { class: 'hub-event hub-event-line', text: event.decision === 'approve' ? '✓ You approved it.' : event.decision === 'answer' ? '↩ You answered: ' + event.text : '✕ You rejected it' + (event.text ? ': ' + event.text : '.') }));
        break;
      case 'message':
        addToTimeline(el('div', { class: 'hub-event hub-say', text: event.text }));
        break;
      case 'done': {
        clearAsk();
        // The summary usually arrived a moment ago as the agent's last message;
        // show it once, as the result.
        const last = detailNodes.timeline.lastElementChild;
        if (last && last.classList.contains('hub-say') && last.textContent === event.summary) last.remove();
        addToTimeline(el('div', { class: 'hub-event hub-done', text: event.summary || 'Build finished.' }));
        disconnect();
        break;
      }
      case 'failed':
        clearAsk();
        addToTimeline(el('div', { class: 'hub-event hub-fail', text: event.error || 'Build stopped.' }));
        disconnect();
        break;
      case 'gap':
        openBuild(d.id);
        break;
      default:
        break;
    }
  }

  function connect(id) {
    disconnect();
    if (typeof root.EventSource !== 'function') return;
    const source = new root.EventSource(API + '/' + encodeURIComponent(id) + '/events');
    state.source = source;
    const types = ['status', 'step', 'diff', 'approval', 'question', 'answer', 'message', 'done', 'failed', 'gap'];
    for (const type of types) {
      source.addEventListener(type, (e) => {
        let event;
        try { event = JSON.parse(e.data); } catch { return; }
        if (state.source !== source) return;
        handleEvent(event);
      });
    }
  }

  function disconnect() {
    if (state.source) {
      state.source.close();
      state.source = null;
    }
  }

  function notifyWaiting() {
    if (document.hidden && !/^\(!\) /.test(document.title)) {
      document.title = '(!) ' + document.title;
      const restore = () => {
        document.title = document.title.replace(/^\(!\) /, '');
        document.removeEventListener('visibilitychange', restore);
      };
      document.addEventListener('visibilitychange', restore);
    }
  }

  // --- Badge + background poll ---

  let badge = null;

  function updateBadge() {
    if (!badge) return;
    const info = badgeFor(state.sessions);
    badge.hidden = !info;
    if (!info) return;
    badge.dataset.kind = info.kind;
    badge.textContent = info.text;
  }

  function startPolling() {
    const tick = async () => {
      if (!document.hidden) {
        try {
          const info = await refreshBuildInfo();
          if (!info.enabled) return;
        } catch { /* signed out or offline: try again later */ }
      }
      state.pollTimer = setTimeout(tick, 30000);
    };
    state.pollTimer = setTimeout(tick, 1500);
  }

  // --- Knowledges ---

  async function loadSkills() {
    if (state.skills) return state.skills;
    const data = await api('/api/skills');
    state.skills = Array.isArray(data) ? data : [];
    return state.skills;
  }

  function renderKnowledges() {
    const chips = el('div', { class: 'hub-subtabs', role: 'group', 'aria-label': 'Knowledge type' },
      ...[['skills', 'Skills'], ['tools', 'Tools'], ['commands', 'Commands']].map(([id, label]) =>
        el('button', { class: 'hub-chip', type: 'button', 'aria-pressed': String(state.kTab === id), text: label, onclick: () => { state.kTab = id; renderKnowledges(); } })));
    const content = el('div');
    clearBody(
      el('div', null,
        el('h2', { class: 'hub-title', text: 'Knowledges' }),
        el('p', { class: 'hub-sub', text: 'What the assistant can use: installed skills, the tools each mode is allowed, and the commands you can type.' })),
      chips,
      content);
    if (state.kTab === 'tools') renderTools(content);
    else if (state.kTab === 'commands') renderCommands(content);
    else renderSkills(content);
  }

  async function renderSkills(container) {
    container.replaceChildren(el('p', { class: 'hub-sub', text: 'Loading skills…' }));
    let skills;
    try {
      skills = await loadSkills();
    } catch (err) {
      container.replaceChildren(el('div', { class: 'hub-notice bad', text: 'Skill library unreachable: ' + err.message }));
      return;
    }
    const search = el('input', { class: 'hub-input', type: 'search', placeholder: 'Filter ' + skills.length + ' skills…', 'aria-label': 'Filter skills' });
    search.value = state.skillFilter;
    const grid = el('div', { class: 'hub-cards' });
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      state.skillFilter = search.value;
      const rows = skills.filter((s) => !q || String(s.name).toLowerCase().includes(q) || String(s.description || '').toLowerCase().includes(q));
      grid.replaceChildren(...rows.slice(0, 120).map((s) => el('button', { class: 'hub-card hub-kcard', type: 'button', onclick: () => openSkill(s) },
        el('div', { class: 'hub-card-title', text: s.name }),
        el('p', { text: s.description || '' }),
        s.source ? el('span', { class: 'hub-tag', text: String(s.source).split('/').slice(-2).join('/') }) : null)));
      if (!rows.length) grid.replaceChildren(el('p', { class: 'hub-sub', text: 'No skill matches "' + search.value + '".' }));
    };
    search.addEventListener('input', draw);
    container.replaceChildren(search, grid);
    draw();
  }

  async function openSkill(skill) {
    const pre = el('pre', { class: 'hub-pre hub-pre-wrap', text: 'Loading…' });
    clearBody(
      el('div', { class: 'hub-row spread' },
        el('div', { class: 'hub-row' },
          el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back to skills', icon: 'back', onclick: renderKnowledges }),
          el('h2', { class: 'hub-title', text: skill.name })),
        el('button', { class: 'hub-btn primary', type: 'button', text: 'Use in this chat', onclick: () => useSkill(skill.name) })),
      el('p', { class: 'hub-sub', text: skill.description || '' }),
      el('div', { class: 'hub-block' }, pre));
    try {
      const res = await fetch('/api/skills/content?name=' + encodeURIComponent(skill.name), { credentials: 'same-origin' });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || 'failed');
      pre.textContent = typeof data === 'string' ? data : (data && (data.content || data.text)) || JSON.stringify(data, null, 2);
    } catch (err) {
      pre.textContent = 'Could not load this skill: ' + err.message;
    }
  }

  async function useSkill(name) {
    try {
      if (typeof root.ensureSkillsLoaded === 'function') await root.ensureSkillsLoaded();
      if (typeof root.pinSkillForChat === 'function') {
        const message = root.pinSkillForChat(name);
        if (typeof message === 'string' && /No installed skill/.test(message)) status('error', message);
      } else {
        insertIntoComposer('/skill ' + name);
      }
      close();
    } catch (err) {
      status('error', err.message);
    }
  }

  function insertIntoComposer(text) {
    const input = document.getElementById('chatInput');
    if (!input) return;
    input.value = text;
    input.dispatchEvent(new root.Event('input', { bubbles: true }));
    input.focus();
  }

  function renderTools(container) {
    const groups = root.FreeAI4UPage && root.FreeAI4UPage.toolGroups;
    const byMode = root.FreeAI4UPage && root.FreeAI4UPage.modeToolGroups;
    const writes = (root.FreeAI4UPage && root.FreeAI4UPage.writeToolGroups) || [];
    const nodes = [];
    if (groups && byMode) {
      const modes = ['chat', 'plan', 'build'];
      const table = el('table', { class: 'hub-table' },
        el('thead', null, el('tr', null, el('th', { text: 'Tool' }), ...modes.map((m) => el('th', { text: m[0].toUpperCase() + m.slice(1) })))));
      const tbody = el('tbody');
      for (const [group, names] of Object.entries(groups)) {
        for (const name of names) {
          tbody.appendChild(el('tr', null,
            el('td', null, el('code', { text: name }), writes.includes(group) ? el('span', { class: 'hub-ask-tag', text: ' · asks first' }) : null),
            ...modes.map((m) => {
              const on = (byMode[m] || []).includes(group);
              return el('td', { class: on ? 'hub-yes' : 'hub-no', text: on ? '✓' : '—', 'aria-label': on ? 'allowed' : 'not allowed' });
            })));
        }
      }
      table.appendChild(tbody);
      nodes.push(el('h3', { class: 'hub-title', text: 'In this browser' }), table);
    }
    const buildTools = state.buildInfo && Array.isArray(state.buildInfo.tools) ? state.buildInfo.tools : null;
    nodes.push(el('h3', { class: 'hub-title', text: 'Remote build agent' }));
    if (buildTools) {
      nodes.push(el('table', { class: 'hub-table' },
        el('tbody', null, ...buildTools.map((t) => el('tr', null,
          el('td', null, el('code', { text: t.name }), t.approval ? el('span', { class: 'hub-ask-tag', text: ' · asks first' }) : null),
          el('td', { text: t.description }))))));
    } else {
      nodes.push(el('p', { class: 'hub-sub', text: 'Loading the build agent tools…' }));
      refreshBuildInfo().then(() => { if (state.tab === 'knowledges' && state.kTab === 'tools') renderTools(container); }).catch(() => {});
    }
    container.replaceChildren(...nodes);
  }

  function renderCommands(container) {
    const commands = (root.FreeAI4UPage && root.FreeAI4UPage.chatCommands) || [];
    container.replaceChildren(
      el('p', { class: 'hub-sub', text: 'Type these in the message box. Tap one to put it there.' }),
      el('div', { class: 'hub-cards' }, ...commands.map((c) => el('button', { class: 'hub-card hub-kcard', type: 'button', onclick: () => { insertIntoComposer('/' + c.name + ' '); close(); } },
        el('div', { class: 'hub-card-title', text: c.usage }),
        el('p', { text: c.desc })))),
      el('h3', { class: 'hub-title', text: 'Keyboard shortcuts' }),
      el('table', { class: 'hub-table' },
        el('tbody', null, ...SHORTCUTS.map(([keys, what]) => el('tr', null,
          el('td', null, el('code', { text: keys })),
          el('td', { text: what }))))));
  }

  function handleShortcut(e) {
    const action = shortcutFor(e);
    if (!action) return;
    e.preventDefault();
    if (action.kind === 'mode') {
      setMode(action.mode);
    } else if (isOpen() && state.tab === action.tab) {
      close();
    } else {
      open(action.tab);
    }
  }

  // --- Page hooks ---

  function pageModes() {
    const modes = root.FreeAI4UPage && root.FreeAI4UPage.modes;
    return Array.isArray(modes) && modes.length ? modes : [{ id: 'chat', label: 'Chat' }, { id: 'plan', label: 'Plan' }, { id: 'build', label: 'Build' }];
  }

  function setMode(id) {
    if (root.FreeAI4UPage && typeof root.FreeAI4UPage.setMode === 'function') root.FreeAI4UPage.setMode(id);
  }

  function mountModeSegment() {
    const chip = document.getElementById('modeChip');
    if (!chip || document.getElementById('modeSegment')) return;
    const modes = pageModes();
    const segment = el('div', { class: 'mode-segment', id: 'modeSegment', role: 'radiogroup', 'aria-label': 'Mode' },
      ...modes.map((m) => el('button', {
        type: 'button', role: 'radio', 'aria-checked': 'false', dataset: { mode: m.id }, text: m.label, title: m.desc || m.label,
        onclick: () => setMode(m.id),
      })));
    segment.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const ids = modes.map((m) => m.id);
      const current = ids.indexOf(segment.dataset.mode);
      const next = ids[(current + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
      setMode(next);
      const btn = segment.querySelector('[data-mode="' + next + '"]');
      if (btn) btn.focus();
    });
    chip.parentNode.insertBefore(segment, chip);
    document.body.classList.add('has-mode-segment');
    syncMode(root.FreeAI4UPage && typeof root.FreeAI4UPage.mode === 'function' ? root.FreeAI4UPage.mode() : 'chat');
  }

  function syncMode(mode) {
    const id = ['chat', 'plan', 'build'].includes(mode) ? mode : 'chat';
    document.documentElement.dataset.chatMode = id;
    const segment = document.getElementById('modeSegment');
    if (!segment) return;
    segment.dataset.mode = id;
    for (const btn of segment.querySelectorAll('button')) btn.setAttribute('aria-checked', String(btn.dataset.mode === id));
  }

  function mountHeaderButton() {
    const anchor = document.getElementById('sessionToggle');
    if (!anchor || document.getElementById('buildsToggle')) return;
    badge = el('span', { class: 'hub-badge', hidden: true, 'aria-hidden': 'true' });
    const btn = el('button', { class: 'icon-btn hub-head-btn', id: 'buildsToggle', type: 'button', title: 'Builds and knowledges', 'aria-label': 'Open builds', icon: 'hammer', onclick: () => open('builds') });
    btn.appendChild(badge);
    anchor.parentNode.insertBefore(btn, anchor);
  }

  function mountDrawerItems() {
    const nav = document.querySelector('.drawer-nav');
    if (!nav || nav.querySelector('[data-hub]')) return;
    const item = (tab, label, icon) => {
      const btn = el('button', { class: 'drawer-nav-btn', type: 'button', dataset: { hub: tab }, icon, onclick: () => {
        if (typeof root.closeDrawer === 'function') root.closeDrawer();
        open(tab);
      } });
      btn.appendChild(document.createTextNode(label));
      return btn;
    };
    const chatItem = nav.querySelector('[data-view="chat"]');
    const builds = item('builds', 'Builds', 'hammer');
    const knowledges = item('knowledges', 'Knowledges', 'book');
    if (chatItem) chatItem.after(builds, knowledges);
    else nav.append(builds, knowledges);
  }

  // Called by the page's buildMessageActions(): a "Build" action under replies
  // that read like a plan. The reply text lands on the message after the bar is
  // built, so the check waits a frame (and again for streamed replies).
  function decorateActions(bar) {
    if (!bar || bar.querySelector('.hub-build-action')) return;
    const btn = el('button', { class: 'msg-action-btn hub-build-action', type: 'button', hidden: true, title: 'Build this plan on the server', 'aria-label': 'Build this plan', icon: 'hammer' });
    btn.appendChild(document.createTextNode('Build'));
    btn.addEventListener('click', () => {
      const message = btn.closest('.message');
      open('builds');
      renderNewBuild(message ? message.dataset.rawContent || '' : '');
    });
    bar.appendChild(btn);
    const reveal = () => {
      const message = btn.closest('.message');
      if (!message || !message.classList.contains('bot')) return;
      btn.hidden = !looksLikePlan(message.dataset.rawContent || '');
    };
    requestAnimationFrame(() => requestAnimationFrame(reveal));
    setTimeout(reveal, 1500);
  }

  function init() {
    state.desktop = appModeFrom(root.location.search, recall('freeai4uApp')) === 'desktop';
    if (state.desktop) {
      remember('freeai4uApp', 'desktop');
      document.documentElement.dataset.app = 'desktop';
    } else if (new URLSearchParams(root.location.search).get('app') === 'web') {
      remember('freeai4uApp', '');
    }
    mountModeSegment();
    mountHeaderButton();
    mountDrawerItems();
    for (const bar of document.querySelectorAll('#chatMessages .message.bot .message-actions')) decorateActions(bar);
    document.addEventListener('keydown', handleShortcut);
    const params = new URLSearchParams(root.location.search);
    const wanted = params.get('hub');
    if (wanted === 'builds' || wanted === 'knowledges') open(wanted);
    else if (dockable() && recall('freeai4uDock') !== 'closed') open('builds');
    // Leaving a wide window narrow turns the docked panel back into an overlay.
    root.addEventListener('resize', () => {
      if (!isOpen()) return;
      const docked = !!document.documentElement.dataset.hubDocked;
      if (docked && !dockable()) delete document.documentElement.dataset.hubDocked;
      else if (!docked && dockable()) document.documentElement.dataset.hubDocked = '1';
    });
    startPolling();
  }

  root.FreeAI4UHub = {
    open,
    close,
    syncMode,
    decorateActions,
    openBuild: (id) => { open('builds'); openBuild(id); },
    newBuild: (plan) => { open('builds'); renderNewBuild(plan); },
    helpers,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(globalThis);
