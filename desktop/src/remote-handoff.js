// Remote handoff orchestrator: package a local workspace, push it to the
// engine's build endpoint, and stream the build status back via SSE.
//
// This bridges the gap between the local sandbox (the desktop's own files)
// and the engine's proven build loop: the user writes a plan, the app sends
// the workspace + plan to the engine, the engine runs its agent loop (which
// has more tools, longer timeouts, and can talk to GitHub), and the desktop
// watches the build in real time — approve/reject diffs just like a local
// build, but the heavy lifting runs on the engine.
//
// The actual packaging (tar/zip) happens in the Rust shell via a new command
// `remote_handoff_package` that tars the folder and uploads it. This module
// is the frontend orchestrator: it coordinates the upload, creates the build
// session on the engine, and manages the SSE stream.
//
// UMD like the repo's other shared modules.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4URemoteHandoff = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var HANDOFF_TIMEOUT_MS = 300_000; // 5 minutes for the upload

  // --- state --------------------------------------------------------------

  var _active = null; // { id, status, events, abort }

  function active() {
    return _active;
  }

  // --- upload + create session --------------------------------------------

  /**
   * startHandoff(root, plan, { api, onEvent })
   *
   * 1. Package the workspace (tar) via the Rust shell.
   * 2. Upload the tar to the engine's /api/build/handoff endpoint.
   * 3. Create a build session with the plan + uploaded workspace.
   * 4. Return the session for SSE watching.
   */
  async function startHandoff(root, plan, callbacks) {
    var c = callbacks;
    if (!c.api) throw new Error('startHandoff needs an api reference');

    // Step 1: Package the workspace.
    c.onEvent?.({ type: 'status', status: 'packaging' });
    var packageResult;
    try {
      packageResult = await c.packageWorkspace(root);
    } catch (err) {
      throw new Error('Could not package the workspace: ' + (err?.message || err));
    }

    // Step 2: Upload to the engine.
    c.onEvent?.({ type: 'status', status: 'uploading' });
    var uploadResult;
    try {
      uploadResult = await c.uploadToEngine(packageResult.path, packageResult.name);
    } catch (err) {
      throw new Error('Could not upload the workspace: ' + (err?.message || err));
    }

    // Step 3: Create the build session on the engine.
    c.onEvent?.({ type: 'status', status: 'creating' });
    var session;
    try {
      session = await c.createBuildSession(plan, uploadResult);
    } catch (err) {
      throw new Error('Could not create the build session: ' + (err?.message || err));
    }

    _active = {
      id: session.id,
      status: session.status,
      root: root,
      plan: plan,
      events: [],
      abort: null,
    };

    c.onEvent?.({ type: 'status', status: 'connected', sessionId: session.id });
    return session;
  }

  // --- SSE stream ---------------------------------------------------------

  /**
   * watchSession(sessionId, { sseUrl, onEvent })
   *
   * Open an SSE stream to the build events endpoint and feed each event to
   * the callback. Returns an abort function.
   */
  function watchSession(sessionId, callbacks) {
    var c = callbacks;
    if (!c.sseUrl) throw new Error('watchSession needs an SSE URL');

    var source = new EventSource(c.sseUrl, { withCredentials: true });
    var active2 = _active;

    source.onmessage = function (e) {
      try {
        var event = JSON.parse(e.data);
        active2?.events.push(event);
        c.onEvent?.(event);

        if (event.type === 'done' || event.type === 'failed') {
          source.close();
          if (active2) active2.status = event.type === 'done' ? 'done' : 'failed';
          c.onEvent?.({ type: 'stream_closed', status: event.type });
        }
      } catch { /* ignore bad frames */ }
    };

    source.onerror = function () {
      // EventSource auto-retries; if the stream closes server-side, the
      // 'done'/'failed' event will have already fired.
    };

    var abort = function () {
      source.close();
      if (active2) active2.status = 'aborted';
    };

    if (active2) active2.abort = abort;
    return abort;
  }

  // --- stop ---------------------------------------------------------------

  function stopHandoff() {
    if (_active?.abort) _active.abort();
    if (_active) _active.status = 'stopped';
    _active = null;
  }

  // --- status helpers -----------------------------------------------------

  function isActive() {
    return !!_active && _active.status !== 'done' && _active.status !== 'failed' && _active.status !== 'stopped';
  }

  function statusText() {
    if (!_active) return '';
    switch (_active.status) {
      case 'packaging': return 'Packaging workspace…';
      case 'uploading': return 'Uploading to engine…';
      case 'creating': return 'Creating build session…';
      case 'connected': return 'Connected — waiting for build events…';
      case 'running': return 'Build running on engine…';
      case 'waiting_approval': return 'Awaiting approval…';
      case 'done': return 'Build complete.';
      case 'failed': return 'Build failed.';
      case 'aborted': return 'Build aborted.';
      case 'stopped': return 'Build stopped.';
      default: return _active.status;
    }
  }

  return {
    startHandoff: startHandoff,
    watchSession: watchSession,
    stopHandoff: stopHandoff,
    active: active,
    isActive: isActive,
    statusText: statusText,
    HANDOFF_TIMEOUT_MS: HANDOFF_TIMEOUT_MS,
  };
});
