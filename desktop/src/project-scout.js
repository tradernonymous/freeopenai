// project-scout (NEURA-056): map the open folder ONCE, then answer "where is
// X?" from the map instead of walking the tree again on every turn.
//
// The coding agent's most expensive habit is rediscovery: it lists the root,
// lists src/, reads three files to find out what they export, and does the
// whole thing again on the next question. This module turns that walk into a
// small, storable index -- paths, sizes, the symbols a regex can see, the
// entry points, and which directory each area lives in -- and answers queries
// with paths and LINE NUMBERS, never file contents, so the agent still chooses
// what is worth reading.
//
// Honesty about what this is: there is NO PARSER here. Symbols are found with
// regexes over the text, so `extractSymbols` sees `export function foo`,
// `class Foo`, `def foo`, `pub fn foo` and Markdown headings, and it will miss
// anything clever (re-exports, decorators, generated code, a name built at
// runtime). Every index carries that caveat in `note`, and a query says so
// rather than pretending the map is complete.
//
// Bounded by construction: directories in SKIP_DIRS are never entered, binary
// extensions are never read, a file over MAX_FILE_BYTES is listed but not
// read, and the walk stops at MAX_FILES / MAX_TOTAL_BYTES with `truncated`
// saying which cap hit. A map that quietly covered half the repo would be
// worse than no map.
//
// Staleness: the index keeps a digest over `path:size:mtime` for every file it
// saw. `checkFresh` re-walks the tree (cheap -- names and sizes only, no file
// is read) and compares. A stale index answers with `stale: true` and what
// moved, rather than confidently pointing at an old map.
//
// Everything is pure and injectable: the lister and the reader are arguments,
// so the tests need no filesystem. UMD like the repo's other shared modules.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UProjectScout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var KEY = 'freeai4u.project-index';
  var CHANGED_EVENT = 'freeai4u:project-index-changed';
  /** AgentsScreen asks for a rebuild; whoever owns the open folder listens. */
  var REBUILD_EVENT = 'freeai4u:project-index-rebuild';
  var VERSION = 1;

  // --- the caps -----------------------------------------------------------
  // Chosen so a large repo still indexes in a few seconds and the stored index
  // stays well under a megabyte of JSON.

  /** Files recorded in one index. Beyond this the walk stops listing. */
  var MAX_FILES = 4000;
  /** Bytes actually read for symbols across the whole build. */
  var MAX_TOTAL_BYTES = 8 * 1024 * 1024;
  /** A single file over this is listed but never read. */
  var MAX_FILE_BYTES = 256 * 1024;
  /** Directory levels below the root. */
  var MAX_DEPTH = 12;
  /** Symbols kept per file; a generated file must not drown the index. */
  var MAX_SYMBOLS_PER_FILE = 40;
  /** Matches returned by one query unless the caller asks for fewer. */
  var MAX_QUERY_RESULTS = 20;

  /** Never entered: build output, dependencies and version control. */
  var SKIP_DIRS = ['node_modules', '.git', '.hg', '.svn', 'target', 'dist', 'build', 'out',
    '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.gradle', '.idea', '.cache',
    'coverage', 'vendor', '.worktrees', 'gen'];

  /** Never read: bytes a regex would only find noise in. */
  var BINARY_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'icns', 'bmp', 'tiff', 'svgz',
    'pdf', 'zip', 'gz', 'tar', 'xz', '7z', 'rar', 'jar', 'war',
    'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'lib', 'pdb', 'msi', 'apk', 'aab',
    'mp3', 'mp4', 'wav', 'ogg', 'webm', 'mov', 'avi', 'flac',
    'ttf', 'otf', 'woff', 'woff2', 'eot',
    'gguf', 'safetensors', 'onnx', 'pt', 'pth', 'db', 'sqlite', 'lock'];

  /** Filenames that mean "start reading here", with why they matter. */
  var ENTRY_FILES = {
    'package.json': 'npm manifest: scripts, dependencies, entry points',
    'cargo.toml': 'Rust crate manifest',
    'go.mod': 'Go module',
    'pyproject.toml': 'Python project',
    'setup.py': 'Python package',
    'pom.xml': 'Maven project',
    'build.gradle': 'Gradle project',
    'build.gradle.kts': 'Gradle project',
    'makefile': 'build entry point',
    'dockerfile': 'container entry point',
    'readme.md': 'what the project says it is',
    'agents.md': 'instructions for agents working here',
    'claude.md': 'instructions for agents working here',
    'main.rs': 'Rust binary entry point',
    'main.ts': 'application entry point',
    'main.tsx': 'application entry point',
    'main.js': 'application entry point',
    'main.py': 'application entry point',
    'index.js': 'module entry point',
    'index.ts': 'module entry point',
    'index.html': 'page entry point',
    'server.js': 'server entry point',
    'app.tsx': 'application root component',
    'app.py': 'application entry point',
  };

  var LANGS = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    rs: 'rust', py: 'python', go: 'go', rb: 'ruby', java: 'java', kt: 'kotlin', kts: 'kotlin',
    swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
    php: 'php', sh: 'shell', bash: 'shell', ps1: 'powershell',
    css: 'css', scss: 'css', html: 'html', md: 'markdown', mdx: 'markdown',
    json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml', sql: 'sql',
  };

  // --- small helpers ------------------------------------------------------

  function extOf(path) {
    var name = String(path || '').split('/').pop() || '';
    var dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  function baseOf(path) {
    return (String(path || '').split('/').pop() || '').toLowerCase();
  }

  function dirOf(path) {
    var parts = String(path || '').split('/');
    parts.pop();
    return parts.join('/');
  }

  /** A directory we never enter: dependencies, build output, version control. */
  function shouldSkipDir(name) {
    var lower = String(name || '').toLowerCase();
    if (!lower) return true;
    return SKIP_DIRS.indexOf(lower) >= 0;
  }

  /** Bytes, not text: never read for symbols. */
  function isBinaryPath(path) {
    return BINARY_EXTS.indexOf(extOf(path)) >= 0;
  }

  function languageOf(path) {
    return LANGS[extOf(path)] || 'unknown';
  }

  /** Why this file is an entry point, or ''. */
  function entryReason(path) {
    var base = baseOf(path);
    return Object.prototype.hasOwnProperty.call(ENTRY_FILES, base) ? ENTRY_FILES[base] : '';
  }

  function joinPath(dir, name) {
    return dir ? dir + '/' + name : String(name);
  }

  /** A cheap, stable hash of the tree's shape: same digest means same files. */
  function digestOf(files) {
    var rows = (files || []).map(function (f) {
      return f.path + ':' + (f.size || 0) + ':' + (f.mtime || 0);
    }).sort();
    var h = 2166136261;
    var joined = rows.join('\n');
    for (var i = 0; i < joined.length; i += 1) {
      h ^= joined.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return rows.length + '-' + h.toString(36);
  }

  // --- symbol extraction (regex only, and it says so) ---------------------

  // Each rule is [regex with a capturing group, kind]. They run per line, so a
  // name only ever costs one line number and nothing spans lines.
  var RULES = [
    [/^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
    [/^\s*export\s+declare\s+function\s+([A-Za-z_$][\w$]*)/, 'function'],
    [/^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
    [/^\s*export\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/, 'type'],
    [/^\s*export\s+(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, 'const'],
    [/^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/, 'function'],
    [/^\s*(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
    [/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>)/, 'function'],
    [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/, 'function'],
    [/^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_][\w]*)/, 'type'],
    [/^\s*impl(?:<[^>]*>)?\s+([A-Za-z_][\w]*)/, 'type'],
    [/^\s*def\s+([A-Za-z_][\w]*)\s*\(/, 'function'],
    [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/, 'function'],
    [/^\s*type\s+([A-Za-z_][\w]*)\s+(?:struct|interface)\b/, 'type'],
    [/^\s*(?:public\s+|private\s+|internal\s+|protected\s+)?(?:data\s+|sealed\s+)?(?:class|object|interface)\s+([A-Za-z_][\w]*)/, 'class'],
    [/^#{1,4}\s+(.+?)\s*$/, 'heading'],
  ];

  /**
   * The names a regex can see in `text`, with 1-based line numbers.
   * Not a parser: it finds declarations and headings, and misses the rest.
   */
  function extractSymbols(text, path, limit) {
    var cap = typeof limit === 'number' ? limit : MAX_SYMBOLS_PER_FILE;
    var markdown = languageOf(path) === 'markdown';
    var lines = String(text || '').split(/\r?\n/);
    var out = [];
    var seen = {};
    for (var i = 0; i < lines.length && out.length < cap; i += 1) {
      var line = lines[i];
      if (!line || line.length > 400) continue;
      for (var r = 0; r < RULES.length; r += 1) {
        var kind = RULES[r][1];
        // Markdown has headings and nothing else; code has everything else.
        if ((kind === 'heading') !== markdown) continue;
        var m = line.match(RULES[r][0]);
        if (!m) continue;
        var name = m[1];
        if (!name) continue;
        var key = kind + ':' + name;
        if (seen[key]) break;
        seen[key] = true;
        out.push({
          name: name,
          kind: kind,
          line: i + 1,
          exported: /^\s*(?:export|pub)\b/.test(line),
        });
        break;
      }
    }
    return out;
  }

  // --- walking ------------------------------------------------------------

  function emptyStats() {
    return {
      dirsSeen: 0,
      filesSeen: 0,
      filesIndexed: 0,
      filesRead: 0,
      bytesRead: 0,
      skippedDirs: 0,
      skippedBinary: 0,
      skippedTooBig: 0,
    };
  }

  function emptyTruncated() {
    return { files: false, bytes: false, depth: false, reasons: [] };
  }

  function normalizeEntries(listing) {
    var entries = listing && Array.isArray(listing.entries) ? listing.entries
      : (Array.isArray(listing) ? listing : []);
    return entries.filter(function (e) { return e && e.name; });
  }

  /**
   * Walk the tree for names and sizes only -- no file is read here.
   * `listFiles(relPath)` returns `{ entries: [{ name, dir, size, mtime }] }`.
   */
  async function scanTree(listFiles, options) {
    var opts = options || {};
    var maxFiles = opts.maxFiles || MAX_FILES;
    var maxDepth = typeof opts.maxDepth === 'number' ? opts.maxDepth : MAX_DEPTH;
    var stats = emptyStats();
    var files = [];
    var truncated = emptyTruncated();
    var queue = [{ path: '', depth: 0 }];

    while (queue.length) {
      var at = queue.shift();
      if (at.depth > maxDepth) {
        if (!truncated.depth) {
          truncated.depth = true;
          truncated.reasons.push('folders deeper than ' + maxDepth + ' levels');
        }
        continue;
      }
      var listing = null;
      try {
        listing = await listFiles(at.path);
      } catch {
        continue; // an unreadable folder is not a reason to lose the rest
      }
      stats.dirsSeen += 1;
      var entries = normalizeEntries(listing);
      for (var i = 0; i < entries.length; i += 1) {
        var entry = entries[i];
        var full = joinPath(at.path, entry.name);
        if (entry.dir) {
          if (shouldSkipDir(entry.name)) { stats.skippedDirs += 1; continue; }
          queue.push({ path: full, depth: at.depth + 1 });
          continue;
        }
        stats.filesSeen += 1;
        if (files.length >= maxFiles) {
          if (!truncated.files) {
            truncated.files = true;
            truncated.reasons.push('more than ' + maxFiles + ' files');
          }
          continue;
        }
        files.push({
          path: full,
          size: typeof entry.size === 'number' ? entry.size : 0,
          mtime: typeof entry.mtime === 'number' ? entry.mtime : 0,
        });
      }
    }
    files.sort(function (a, b) { return a.path < b.path ? -1 : (a.path > b.path ? 1 : 0); });
    stats.filesIndexed = files.length;
    return { files: files, stats: stats, truncated: truncated, digest: digestOf(files) };
  }

  // --- areas and entry points --------------------------------------------

  /** Where each area lives: the directories that hold the files, biggest first. */
  function areasOf(files) {
    var byDir = {};
    for (var i = 0; i < files.length; i += 1) {
      var dir = dirOf(files[i].path);
      // Two path segments are enough to name an area ("desktop/src").
      var name = dir ? dir.split('/').slice(0, 2).join('/') : '.';
      if (!byDir[name]) byDir[name] = { files: 0, languages: {} };
      byDir[name].files += 1;
      var lang = languageOf(files[i].path);
      if (lang !== 'unknown') byDir[name].languages[lang] = (byDir[name].languages[lang] || 0) + 1;
    }
    return Object.keys(byDir).map(function (dir) {
      var area = byDir[dir];
      var langs = Object.keys(area.languages).sort(function (a, b) {
        return area.languages[b] - area.languages[a] || (a < b ? -1 : 1);
      });
      return { dir: dir, files: area.files, languages: langs.slice(0, 3) };
    }).sort(function (a, b) { return b.files - a.files || (a.dir < b.dir ? -1 : 1); });
  }

  /** The files that mean "start reading here", shallowest first. */
  function entriesOf(files) {
    var out = [];
    for (var i = 0; i < files.length; i += 1) {
      var why = entryReason(files[i].path);
      if (!why) continue;
      out.push({ path: files[i].path, why: why, depth: files[i].path.split('/').length });
    }
    out.sort(function (a, b) { return a.depth - b.depth || (a.path < b.path ? -1 : 1); });
    return out.slice(0, 40).map(function (e) { return { path: e.path, why: e.why }; });
  }

  // --- building -----------------------------------------------------------

  var NO_PARSER_NOTE = 'No parser: symbols come from regexes over the text, so declarations and headings are found and '
    + 'anything indirect (re-exports, generated or runtime names) is missed. Paths and line numbers are reliable; the '
    + 'symbol list is not exhaustive.';

  function emptyIndex(root) {
    return {
      version: VERSION,
      root: String(root || ''),
      builtAt: 0,
      checkedAt: 0,
      parser: 'regex',
      note: NO_PARSER_NOTE,
      files: [],
      entries: [],
      areas: [],
      digest: digestOf([]),
      truncated: emptyTruncated(),
      stats: emptyStats(),
      stale: false,
      staleReason: '',
    };
  }

  /**
   * Build the index ONCE.
   *
   * `io.listFiles(relPath)` -> `{ entries: [{ name, dir, size, mtime }] }`
   * `io.readFile(relPath)`  -> `{ text, binary, bytes }` or a string
   *
   * Both are bound to the open folder by the caller, so this module never
   * joins a path against a root and never touches a filesystem itself.
   */
  async function buildIndex(root, io, options) {
    var opts = options || {};
    var listFiles = io && io.listFiles;
    var readFile = io && io.readFile;
    if (typeof listFiles !== 'function') throw new Error('project-scout needs a listFiles(path) function');
    var maxBytes = opts.maxTotalBytes || MAX_TOTAL_BYTES;
    var maxFileBytes = opts.maxFileBytes || MAX_FILE_BYTES;
    var maxSymbols = typeof opts.maxSymbols === 'number' ? opts.maxSymbols : MAX_SYMBOLS_PER_FILE;

    var scan = await scanTree(listFiles, opts);
    var index = emptyIndex(root);
    index.digest = scan.digest;
    index.truncated = scan.truncated;
    index.stats = scan.stats;

    var files = [];
    for (var i = 0; i < scan.files.length; i += 1) {
      var found = scan.files[i];
      var record = {
        path: found.path,
        size: found.size,
        mtime: found.mtime,
        lang: languageOf(found.path),
        symbols: [],
        read: false,
        why: '',
      };
      files.push(record);
      if (typeof readFile !== 'function') { record.why = 'no reader was given'; continue; }
      if (isBinaryPath(found.path)) {
        index.stats.skippedBinary += 1;
        record.why = 'binary';
        continue;
      }
      if (found.size > maxFileBytes) {
        index.stats.skippedTooBig += 1;
        record.why = 'over ' + maxFileBytes + ' bytes';
        continue;
      }
      if (index.stats.bytesRead >= maxBytes) {
        if (!index.truncated.bytes) {
          index.truncated.bytes = true;
          index.truncated.reasons.push('more than ' + maxBytes + ' bytes of source');
        }
        record.why = 'byte cap reached';
        continue;
      }
      var text = '';
      try {
        var raw = await readFile(found.path);
        if (raw && typeof raw === 'object') {
          if (raw.binary) { index.stats.skippedBinary += 1; record.why = 'binary'; continue; }
          text = typeof raw.text === 'string' ? raw.text : '';
        } else {
          text = typeof raw === 'string' ? raw : '';
        }
      } catch {
        record.why = 'unreadable';
        continue;
      }
      index.stats.filesRead += 1;
      index.stats.bytesRead += text.length;
      record.read = true;
      record.symbols = extractSymbols(text, found.path, maxSymbols);
    }

    index.files = files;
    index.entries = entriesOf(files);
    index.areas = areasOf(files);
    index.builtAt = typeof opts.now === 'number' ? opts.now : Date.now();
    index.checkedAt = index.builtAt;
    return index;
  }

  // --- staleness ----------------------------------------------------------

  /** What moved between the index and a fresh scan of the same tree. */
  function compare(index, scanned) {
    var before = {};
    (index && index.files ? index.files : []).forEach(function (f) { before[f.path] = f; });
    var after = {};
    (scanned || []).forEach(function (f) { after[f.path] = f; });
    var added = Object.keys(after).filter(function (p) { return !before[p]; }).sort();
    var removed = Object.keys(before).filter(function (p) { return !after[p]; }).sort();
    var changed = Object.keys(after).filter(function (p) {
      if (!before[p]) return false;
      return before[p].size !== after[p].size || (before[p].mtime || 0) !== (after[p].mtime || 0);
    }).sort();
    return { added: added, removed: removed, changed: changed };
  }

  function staleReason(diff) {
    var bits = [];
    if (diff.added.length) bits.push(diff.added.length + ' new file' + (diff.added.length === 1 ? '' : 's'));
    if (diff.removed.length) bits.push(diff.removed.length + ' file' + (diff.removed.length === 1 ? '' : 's') + ' gone');
    if (diff.changed.length) bits.push(diff.changed.length + ' file' + (diff.changed.length === 1 ? '' : 's') + ' edited');
    return bits.join(', ');
  }

  /**
   * Re-walk the tree (names and sizes only, no file is read) and say whether
   * the index still describes it. A stale index is never silently trusted.
   */
  async function checkFresh(index, io, options) {
    if (!index || !Array.isArray(index.files)) {
      return { stale: true, reason: 'no index has been built', added: [], removed: [], changed: [], digest: '' };
    }
    var listFiles = io && io.listFiles;
    if (typeof listFiles !== 'function') throw new Error('project-scout needs a listFiles(path) function');
    var scan = await scanTree(listFiles, options || {});
    if (scan.digest === index.digest) {
      return { stale: false, reason: '', added: [], removed: [], changed: [], digest: scan.digest };
    }
    var diff = compare(index, scan.files);
    return {
      stale: true,
      reason: staleReason(diff) || 'the folder no longer matches the index',
      added: diff.added.slice(0, 20),
      removed: diff.removed.slice(0, 20),
      changed: diff.changed.slice(0, 20),
      digest: scan.digest,
    };
  }

  /** The index with a freshness verdict written onto it, ready to store. */
  function markFresh(index, freshness, now) {
    if (!index) return index;
    var next = Object.assign({}, index);
    next.stale = !!(freshness && freshness.stale);
    next.staleReason = (freshness && freshness.reason) || '';
    next.checkedAt = typeof now === 'number' ? now : Date.now();
    return next;
  }

  // --- queries ------------------------------------------------------------

  function terms(query) {
    return String(query || '')
      .split(/[^A-Za-z0-9_$]+/)
      .filter(Boolean)
      .map(function (t) { return t.toLowerCase(); })
      .slice(0, 8);
  }

  /** How well `haystack` answers `term`: exact > prefix > contains > nothing. */
  function scoreTerm(haystack, term) {
    var lower = String(haystack || '').toLowerCase();
    if (!lower || !term) return 0;
    if (lower === term) return 10;
    if (lower.indexOf(term) === 0) return 6;
    if (lower.indexOf(term) >= 0) return 3;
    return 0;
  }

  function partial(index) {
    var t = index && index.truncated;
    return !!(t && (t.files || t.bytes || t.depth));
  }

  /**
   * "Where is X?" answered from the map: paths and LINE NUMBERS, never
   * contents. The caller decides what is worth reading.
   */
  function query(index, text, options) {
    var opts = options || {};
    var limit = opts.limit || MAX_QUERY_RESULTS;
    var words = terms(text);
    var answer = {
      ok: false,
      query: String(text || ''),
      matches: [],
      note: (index && index.note) || NO_PARSER_NOTE,
      stale: !!(index && index.stale),
      staleReason: (index && index.staleReason) || '',
    };
    if (!index || !Array.isArray(index.files) || !index.files.length) {
      answer.note = 'No index has been built for this folder yet.';
      return answer;
    }
    if (!words.length) {
      answer.note = 'Ask for a name, a filename or a word that would appear in one.';
      return answer;
    }

    var hits = [];
    for (var i = 0; i < index.files.length; i += 1) {
      var file = index.files[i];
      var base = baseOf(file.path);
      var symbols = Array.isArray(file.symbols) ? file.symbols : [];
      for (var s = 0; s < symbols.length; s += 1) {
        var sym = symbols[s];
        var symScore = 0;
        for (var w = 0; w < words.length; w += 1) symScore += scoreTerm(sym.name, words[w]);
        if (!symScore) continue;
        hits.push({
          path: file.path,
          line: sym.line,
          name: sym.name,
          kind: sym.kind,
          exported: !!sym.exported,
          score: symScore + (sym.exported ? 2 : 0),
          why: 'symbol',
        });
      }
      var pathScore = 0;
      for (var p = 0; p < words.length; p += 1) {
        pathScore += scoreTerm(base, words[p]) + (scoreTerm(file.path, words[p]) ? 1 : 0);
      }
      if (pathScore) {
        hits.push({
          path: file.path,
          line: 1,
          name: base,
          kind: 'file',
          exported: false,
          score: pathScore,
          why: 'filename',
        });
      }
    }
    hits.sort(function (a, b) {
      return b.score - a.score || (a.path < b.path ? -1 : (a.path > b.path ? 1 : a.line - b.line));
    });
    answer.matches = hits.slice(0, limit);
    answer.ok = answer.matches.length > 0;
    if (!answer.ok) {
      answer.note = 'Nothing in the index matches. The index is regex-level, so a name built at runtime or re-exported '
        + 'will not be in it -- search the files directly.';
    } else if (partial(index)) {
      answer.note = 'Partial index (' + (index.truncated.reasons || []).join('; ') + '). ' + answer.note;
    }
    return answer;
  }

  /** The map as a few compact lines for a prompt: size, entry points, areas. */
  function describe(index, options) {
    if (!index || !Array.isArray(index.files) || !index.files.length) {
      return 'No project index has been built yet.';
    }
    var opts = options || {};
    var maxAreas = opts.maxAreas || 12;
    var lines = [];
    lines.push('Project index for ' + (index.root || 'the open folder') + ': ' + index.files.length
      + ' files, ' + index.stats.filesRead + ' read for symbols.');
    if (index.stale) lines.push('STALE: ' + (index.staleReason || 'the folder changed since this map was built.'));
    if (partial(index)) lines.push('Partial: ' + (index.truncated.reasons || []).join('; ') + '.');
    if (index.entries.length) {
      lines.push('Entry points: ' + index.entries.slice(0, 8).map(function (e) { return e.path; }).join(', ') + '.');
    }
    lines.push('Areas:');
    index.areas.slice(0, maxAreas).forEach(function (a) {
      lines.push('  ' + a.dir + ' -- ' + a.files + ' files'
        + (a.languages.length ? ' (' + a.languages.join(', ') + ')' : ''));
    });
    lines.push(index.note || NO_PARSER_NOTE);
    return lines.join('\n');
  }

  /** none / building / built / stale, plus the numbers the UI shows. */
  function status(index, building) {
    if (building) {
      return { state: 'building', label: 'Building...', fileCount: 0, symbolCount: 0, builtAt: 0, root: '', reason: '' };
    }
    if (!index || !Array.isArray(index.files) || !index.files.length) {
      return { state: 'none', label: 'Not built', fileCount: 0, symbolCount: 0, builtAt: 0, root: '', reason: '' };
    }
    var symbols = index.files.reduce(function (n, f) {
      return n + (Array.isArray(f.symbols) ? f.symbols.length : 0);
    }, 0);
    return {
      state: index.stale ? 'stale' : 'built',
      label: index.stale ? 'Stale' : 'Built',
      fileCount: index.files.length,
      symbolCount: symbols,
      builtAt: index.builtAt || 0,
      root: index.root || '',
      reason: index.stale ? (index.staleReason || 'the folder changed') : '',
    };
  }

  // --- storage ------------------------------------------------------------

  function storage(given) {
    if (given) return given;
    try {
      var scope = typeof globalThis !== 'undefined' ? globalThis : {};
      return scope.localStorage || null;
    } catch {
      return null;
    }
  }

  function dispatch(name) {
    try {
      var scope = typeof globalThis !== 'undefined' ? globalThis : null;
      if (scope && typeof scope.dispatchEvent === 'function' && typeof scope.Event === 'function') {
        scope.dispatchEvent(new scope.Event(name));
      }
    } catch { /* a listener is a convenience */ }
  }

  /** The stored index, or null. An index for another root is not this one. */
  function load(root, store) {
    var s = storage(store);
    if (!s) return null;
    try {
      var raw = s.getItem(KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== VERSION || !Array.isArray(parsed.files)) return null;
      if (root && parsed.root && parsed.root !== root) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function save(index, store) {
    var s = storage(store);
    if (!s || !index) return false;
    try {
      s.setItem(KEY, JSON.stringify(index));
      dispatch(CHANGED_EVENT);
      return true;
    } catch {
      return false; // a full quota must not break the agent
    }
  }

  function clear(store) {
    var s = storage(store);
    if (!s) return false;
    try {
      s.removeItem(KEY);
      dispatch(CHANGED_EVENT);
      return true;
    } catch {
      return false;
    }
  }

  /** AgentsScreen's Rebuild button: whoever holds the open folder listens. */
  function requestRebuild() {
    dispatch(REBUILD_EVENT);
  }

  return {
    KEY: KEY,
    CHANGED_EVENT: CHANGED_EVENT,
    REBUILD_EVENT: REBUILD_EVENT,
    VERSION: VERSION,
    MAX_FILES: MAX_FILES,
    MAX_TOTAL_BYTES: MAX_TOTAL_BYTES,
    MAX_FILE_BYTES: MAX_FILE_BYTES,
    MAX_DEPTH: MAX_DEPTH,
    MAX_SYMBOLS_PER_FILE: MAX_SYMBOLS_PER_FILE,
    MAX_QUERY_RESULTS: MAX_QUERY_RESULTS,
    SKIP_DIRS: SKIP_DIRS,
    BINARY_EXTS: BINARY_EXTS,
    ENTRY_FILES: ENTRY_FILES,
    NO_PARSER_NOTE: NO_PARSER_NOTE,
    shouldSkipDir: shouldSkipDir,
    isBinaryPath: isBinaryPath,
    languageOf: languageOf,
    entryReason: entryReason,
    digestOf: digestOf,
    extractSymbols: extractSymbols,
    scanTree: scanTree,
    buildIndex: buildIndex,
    checkFresh: checkFresh,
    markFresh: markFresh,
    query: query,
    describe: describe,
    status: status,
    areasOf: areasOf,
    entriesOf: entriesOf,
    load: load,
    save: save,
    clear: clear,
    requestRebuild: requestRebuild,
  };
});
