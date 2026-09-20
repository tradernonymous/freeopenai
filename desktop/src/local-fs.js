// The local folder, as rules rather than as a screen.
//
// src-tauri/src/local.rs is where these rules are ENFORCED -- this file is the
// frontend's copy of them, so a path or a command can be refused with a
// readable message before anything crosses into the shell, and so node:test can
// exercise the rules without a Rust toolchain. The important part is that the
// two copies cannot drift: test/desktop-local.test.js reads the Rust constants
// and asserts this file's lists are identical (the same trick
// test/desktop-net.test.js uses for the host allowlist).
//
// Beyond the mirror, this is where the two decisions a terminal needs live:
// what `cd` means (a live cwd is what makes the dock worth having) and which
// file a row is, so the tree can label it honestly.
//
// UMD like the repo's other shared modules: node gets module.exports, the
// bundled app gets the global.
(function (root, factory) {
  // Unconditional global publish -- see chats.js for why the traditional
  // fallback-branch UMD shape breaks in a Vite production bundle.
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4ULocalFs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // --- The engine's protected_path() list (local.rs must agree) -----------
  var PROTECTED_DIRS = ['.git'];
  var PROTECTED_FILES = ['.env'];

  // --- Commands that are destructive by nature (local.rs must agree) ------
  var RISKY = [
    ['git push', 'pushes commits to a remote'],
    ['git reset --hard', 'throws away uncommitted work'],
    ['git clean -', 'deletes untracked files'],
    ['git checkout --', 'discards local edits'],
    ['gh release delete', 'deletes a published release'],
    ['gh repo delete', 'deletes a repository'],
    ['npm publish', 'publishes a package'],
    ['cargo publish', 'publishes a crate'],
    ['rm -rf', 'deletes a tree recursively'],
    ['rm -r ', 'deletes a tree recursively'],
    ['rmdir /s', 'deletes a tree recursively'],
    ['del /f', 'force-deletes files'],
    ['remove-item -recurse', 'deletes a tree recursively'],
    ['format ', 'formats a disk'],
    ['diskpart', 'edits disk partitions'],
    ['bcdedit', 'edits the boot configuration'],
    ['cipher /w', 'wipes free space'],
    ['takeown', 'takes ownership of files'],
    ['reg delete', 'deletes registry keys'],
    ['shutdown', 'powers the machine off'],
    ['drop table', 'drops a database table'],
    ['truncate table', 'empties a database table'],
    ['curl | sh', 'pipes a download into a shell'],
    ['curl | bash', 'pipes a download into a shell'],
    ['iwr | iex', 'pipes a download into a shell'],
    ['start-process -verb runas', 'asks for administrator rights'],
  ];

  function isDriveAbsolute(value) {
    return value.length >= 2 && /[a-zA-Z]/.test(value.charAt(0)) && value.charAt(1) === ':';
  }

  function parts(value) {
    return String(value == null ? '' : value)
      .replace(/\\/g, '/')
      .split('/')
      .filter(function (p) { return p && p !== '.'; });
  }

  // The lexical half of local.rs resolve_inside(): a path joined under `root`,
  // or null when it would leave. What it cannot do is the symlink check, which
  // needs the filesystem -- the shell does that half.
  function joinInside(root, rel) {
    var wanted = String(rel == null ? '' : rel).trim().replace(/\\/g, '/');
    if (wanted.indexOf('\0') >= 0) return null;
    if (wanted.charAt(0) === '/' || isDriveAbsolute(wanted)) return null;
    var base = parts(root);
    var out = base.slice();
    var segments = wanted.split('/');
    for (var i = 0; i < segments.length; i++) {
      var part = segments[i];
      if (!part || part === '.') continue;
      if (part === '..') {
        if (out.length <= base.length) return null;
        out.pop();
        continue;
      }
      if (part.indexOf(':') >= 0) return null;
      out.push(part);
    }
    return out.join('/');
  }

  // The same path, expressed relative to the folder -- the only form that
  // crosses the boundary. '' IS the folder itself, everywhere a cwd is spoken:
  // it is what local_run reads as "the root", and the tree already knows where
  // the root is. The absolute form exists only to be shown (pwd, the header).
  function relativeWithin(root, absolute) {
    var base = parts(root);
    var full = parts(absolute);
    if (full.length < base.length) return absolute == null ? '' : String(absolute);
    return full.slice(base.length).join('/');
  }

  function protectedPath(rel) {
    var segments = String(rel == null ? '' : rel).split('/');
    for (var i = 0; i < segments.length; i++) {
      if (PROTECTED_DIRS.indexOf(segments[i]) >= 0) {
        return 'Refused: files inside .git are managed by git; use run_command with git instead.';
      }
    }
    var base = (segments[segments.length - 1] || '').toLowerCase();
    var secret = PROTECTED_FILES.indexOf(base) >= 0 ||
      (base.indexOf('.env.') === 0 && base !== '.env.example');
    if (secret) return 'Refused: secrets files (.env) are never written.';
    return '';
  }

  // Why a command needs a human's yes, or null when it is ordinary.
  function riskOf(command) {
    var lowered = String(command == null ? '' : command).toLowerCase();
    for (var i = 0; i < RISKY.length; i++) {
      if (lowered.indexOf(RISKY[i][0]) >= 0) {
        return "'" + RISKY[i][0].trim() + "' " + RISKY[i][1];
      }
    }
    return null;
  }

  function stripQuotes(value) {
    var text = String(value == null ? '' : value).trim();
    if (text.length >= 2) {
      var first = text.charAt(0);
      if ((first === '"' && text.charAt(text.length - 1) === '"') ||
          (first === "'" && text.charAt(text.length - 1) === "'")) {
        return text.slice(1, -1);
      }
    }
    return text;
  }

  // A cwd that survives commands is what makes this a terminal and not a
  // submit button, so `cd` is handled here and never sent to the shell (a
  // child process could not carry the change back anyway).
  //
  // Returns { handled, cwd, run, out, err }. When `handled` is true and `run` is
  // set, the caller should execute `run` with the new cwd -- that is what makes
  // `cd src && npm test` work as one line.
  function applyCd(root, cwd, command) {
    var line = String(command == null ? '' : command).trim();
    var current = cwd ? String(cwd) : '';
    if (line === 'pwd') {
      // The absolute folder, the way a real pwd answers -- not the relative
      // form this file speaks in.
      return {
        handled: true,
        cwd: current,
        run: null,
        out: joinInside(root, current) || String(root || ''),
        err: '',
      };
    }
    if (!/^cd(\s|$)/i.test(line)) return { handled: false, cwd: current, run: null };

    // `cd <where> [&& <rest>]`
    var rest = '';
    var match = line.match(/^cd((?:\s+[^&|]+)?)\s*&&\s*([\s\S]+)$/i);
    var where;
    if (match) {
      where = match[1];
      rest = match[2].trim();
    } else {
      where = line.slice(2);
    }
    // /d is how cmd.exe spells "also change drive"; it means nothing here,
    // where there is only ever one folder.
    where = where.replace(/^\s*\/d(\s|$)/i, ' ').trim();
    var target = stripQuotes(where);
    if (!target || target === '.' || target === '~' || target === '/' || target === '\\') {
      return { handled: true, cwd: '', run: rest || null, out: '', err: '' };
    }
    // `cd ..` from the root is the root: the folder is the floor, not an error.
    if (target === '..' && !current) {
      return { handled: true, cwd: '', run: rest || null, out: '', err: '' };
    }
    var absolute = target.charAt(0) === '/' || target.charAt(0) === '\\';
    var joined = absolute
      ? joinInside(root, target)
      : joinInside(root, (current ? current + '/' : '') + target);
    if (joined === null) {
      return {
        handled: true,
        cwd: current,
        run: null,
        out: '',
        err: 'Refused: that path climbs out of the open folder.',
      };
    }
    return {
      handled: true,
      cwd: relativeWithin(root, joined),
      run: rest || null,
      out: '',
      err: '',
    };
  }

  var CODE_EXT = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'rs', 'go', 'py', 'rb', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'swift', 'kt', 'sh', 'ps1', 'sql', 'lua', 'zig', 'toml', 'yml', 'yaml'];
  var DOC_EXT = ['md', 'mdx', 'txt', 'pdf', 'doc', 'docx', 'rtf', 'odt'];
  var DATA_EXT = ['json', 'csv', 'tsv', 'xml', 'html', 'htm', 'xlsx', 'xls', 'parquet'];
  var IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'];

  // What a row IS, so the tree can say it with the right glyph and colour
  // instead of colouring every file the same.
  function kindOf(entry) {
    var row = entry || {};
    if (row.dir) return 'folder';
    var ext = String(row.ext || '').toLowerCase();
    if (CODE_EXT.indexOf(ext) >= 0) return 'code';
    if (IMAGE_EXT.indexOf(ext) >= 0) return 'image';
    if (DATA_EXT.indexOf(ext) >= 0) return 'data';
    if (DOC_EXT.indexOf(ext) >= 0) return 'doc';
    return 'unknown';
  }

  function formatBytes(bytes) {
    var n = Number(bytes || 0);
    if (!isFinite(n) || n <= 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  function rootLabel(path) {
    var segments = parts(path);
    if (!segments.length) return '';
    return segments[segments.length - 1];
  }

  // The folder above `path`, relative to the open folder; '' is the root.
  function parentOf(path) {
    var segments = parts(path);
    if (segments.length <= 1) return '';
    return segments.slice(0, -1).join('/');
  }

  return {
    PROTECTED_DIRS: PROTECTED_DIRS,
    PROTECTED_FILES: PROTECTED_FILES,
    RISKY: RISKY,
    isDriveAbsolute: isDriveAbsolute,
    joinInside: joinInside,
    relativeWithin: relativeWithin,
    protectedPath: protectedPath,
    riskOf: riskOf,
    applyCd: applyCd,
    kindOf: kindOf,
    formatBytes: formatBytes,
    rootLabel: rootLabel,
    parentOf: parentOf,
  };
});
