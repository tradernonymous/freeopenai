// An engine run response, turned into what the terminal shows.
//
// This is the one piece of the terminal that is a decision rather than a
// render: what counts as output, what counts as an error, and which facts are
// worth a line ("exit 2", "timed out", "output truncated", the duration). It
// lived inside the component, where the only way to check it was to run a
// command against a live engine.
//
// UMD like the repo's other shared modules: node gets module.exports, the
// bundled app gets the global.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FreeAI4URunResult = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function formatRun(result) {
    var res = result || {};
    var stdout = String(res.stdout == null ? '' : res.stdout);
    var stderr = String(res.stderr == null ? '' : res.stderr);
    var notes = [];
    if (res.timedOut) notes.push('timed out');
    if (res.exitCode != null && res.exitCode !== 0) notes.push('exit ' + res.exitCode);
    if (res.stdoutTruncated || res.stderrTruncated) notes.push('output truncated');
    if (res.durationMs != null) notes.push(Math.round(Number(res.durationMs)) + 'ms');

    var text = [stdout.replace(/\s+$/, ''), stderr.replace(/\s+$/, '')].filter(Boolean).join('\n');
    var withNotes = notes.length ? [text, '— ' + notes.join(' · ')].filter(Boolean).join('\n') : text;
    var kind = (stderr && !stdout) || res.exitCode ? 'err' : 'out';
    return { out: withNotes || 'ok', kind: kind };
  }

  return { formatRun: formatRun };
});
