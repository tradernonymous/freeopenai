// The text behind the app's "Copy diagnostics" button.
//
// Gathering the facts is Rust (src-tauri/src/diag.rs); turning them into
// something a person can paste into a report is here, where node:test can check
// it -- including the part that matters most: nothing that looks like a
// credential survives into the text, and no chat content is in it at all.
//
// UMD like the repo's other shared modules: node gets module.exports, the
// bundled app reads the global (see test/desktop-umd.test.js for why the global
// is published unconditionally).
(function (root, factory) {
  // Unconditional global publish -- see chats.js for why the traditional
  // fallback-branch UMD shape breaks in a Vite production bundle.
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UDiagnostics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // ---- cold start (NEURA-035) -------------------------------------------------
  //
  // Three performance marks against the "under 2 s" target, each in ms since
  // the window started loading (a mark's startTime is relative to timeOrigin):
  //   script-start  the entry bundle began running (main.tsx imports this
  //                 file first, and loading it sets the mark)
  //   first-commit  React committed the app for the first time (App)
  //   chat-ready    the first frame after that with Chat's composer on screen
  var STARTUP_MARKS = {
    'script-start': 'neura:script-start',
    'first-commit': 'neura:first-commit',
    'chat-ready': 'neura:chat-ready',
  };
  var STARTUP_TARGET_MS = 2000;

  function perfOf(given) {
    if (given) return given;
    var scope = typeof globalThis !== 'undefined' ? globalThis : null;
    return scope && scope.performance && typeof scope.performance.mark === 'function' ? scope.performance : null;
  }

  function markedAt(perf, stage) {
    var name = STARTUP_MARKS[stage];
    if (!perf || !name || typeof perf.getEntriesByName !== 'function') return null;
    var entries = perf.getEntriesByName(name, 'mark') || [];
    return entries.length ? Math.round(Number(entries[0].startTime) || 0) : null;
  }

  /** Sets a startup mark once; a later call for the same stage is ignored. */
  function markStartup(stage, given) {
    var perf = perfOf(given);
    var name = STARTUP_MARKS[stage];
    if (!perf || !name || markedAt(perf, stage) != null) return false;
    try {
      perf.mark(name);
      return true;
    } catch {
      return false;
    }
  }

  /** { scriptStart, firstCommit, chatReady } in ms since the load began; null = not reached. */
  function startupTimings(given) {
    var perf = perfOf(given);
    return {
      scriptStart: markedAt(perf, 'script-start'),
      firstCommit: markedAt(perf, 'first-commit'),
      chatReady: markedAt(perf, 'chat-ready'),
    };
  }

  /** One line: "script 180 ms · first commit 420 ms · chat ready 610 ms (target under 2000 ms: met)". */
  function startupLabel(timings, targetMs) {
    var t = timings || {};
    var target = Number(targetMs) > 0 ? Number(targetMs) : STARTUP_TARGET_MS;
    var parts = [];
    if (t.scriptStart != null) parts.push('script ' + t.scriptStart + ' ms');
    if (t.firstCommit != null) parts.push('first commit ' + t.firstCommit + ' ms');
    if (t.chatReady != null) parts.push('chat ready ' + t.chatReady + ' ms');
    if (!parts.length) return '';
    var verdict = t.chatReady == null
      ? 'chat not opened yet'
      : 'target under ' + target + ' ms: ' + (t.chatReady < target ? 'met' : 'missed');
    return parts.join(' · ') + ' (' + verdict + ')';
  }

  // Loading this file is the entry bundle starting (see above).
  markStartup('script-start');

  // Anything shaped like a Hub token, an OpenAI key or an Authorization header.
  function redact(text) {
    return String(text == null ? '' : text)
      .replace(/hf_[A-Za-z0-9]{8,}/g, 'hf_<redacted>')
      .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1<redacted>');
  }

  // An engine address can carry a token or a key in its query string; the
  // origin and path are enough to debug with.
  function redactUrl(value) {
    var raw = String(value == null ? '' : value).trim();
    if (!raw) return '';
    var cut = raw.split('#')[0];
    var queryAt = cut.indexOf('?');
    if (queryAt < 0) return redact(cut);
    return redact(cut.slice(0, queryAt)) + '?<redacted>';
  }

  function bytesLabel(bytes) {
    var size = Number(bytes) || 0;
    if (size <= 0) return '0 B';
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return Math.round(size / 1024) + ' KB';
    return (size / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function line(label, value) {
    var text = String(value == null ? '' : value).trim();
    if (!text) return null;
    return label + ' ' + text;
  }

  // `shell` is what Rust reported; `client` is what only the app knows (where
  // it is pointed, what the last engine answer meant, which backends exist).
  function buildReport(input) {
    var shell = (input && input.shell) || {};
    var client = (input && input.client) || {};
    var lines = [];

    lines.push('NeuraOS Desktop' + (shell.version ? ' ' + shell.version : ''));
    lines.push('');
    [
      line('engine    ', redactUrl(client.engine) || 'not set'),
      line('state     ', client.state || 'unknown'),
      line('account   ', client.account ? redact(client.account) : ''),
      line('shell     ', client.hasShell === false ? 'browser (no desktop shell)' : 'desktop'),
      line('os        ', [shell.os, shell.arch].filter(Boolean).join(' / ')),
      line('webview2  ', shell.webview2 || 'unknown'),
      line('backends  ', (client.backends || []).join(', ')),
      line('startup   ', client.startup ? startupLabel(client.startup) : ''),
      line('data      ', shell.data_dir),
      line('cache     ', shell.cache_dir),
      line('crash log ', shell.log_path
        ? shell.log_path + (Number(shell.log_bytes) > 0 ? ' (' + bytesLabel(shell.log_bytes) + ')' : ' (empty)')
        : ''),
    ].forEach(function (entry) {
      if (entry) lines.push(entry);
    });

    var tail = String(shell.log_tail == null ? '' : shell.log_tail).trim();
    if (tail) {
      lines.push('');
      lines.push('--- last log lines ---');
      lines.push(redact(tail));
    }

    return lines.join('\n');
  }

  return {
    buildReport: buildReport,
    redact: redact,
    redactUrl: redactUrl,
    bytesLabel: bytesLabel,
    STARTUP_MARKS: STARTUP_MARKS,
    STARTUP_TARGET_MS: STARTUP_TARGET_MS,
    markStartup: markStartup,
    startupTimings: startupTimings,
    startupLabel: startupLabel,
  };
});
