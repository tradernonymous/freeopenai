// The update check: what version the release actually is, and whether it is
// newer than the build running here.
//
// The version used to be guessed by regexing the first "x.y.z" out of the
// joined asset names, and any difference -- including a DOWN-dated release --
// raised the banner. Both were wrong: a build-numbered file ("2.2.0.150") or a
// renamed asset misreport the version, and "different" is not "newer".
//
// Now the release publishes desktop-version.json (version + sha256 + size per
// artifact, written by CI from the files it actually built) and this module
// reads that. The URL is the release DOWNLOAD url, not api.github.com: a
// release asset is served by the CDN, so the 60-requests-per-hour API limit
// that could silently 403 the check no longer applies.
//
// Everything here is pure or injected (fetch, sleep, document), so node:test
// exercises the real rules.
//
// UMD like the repo's other shared modules: node gets module.exports, the
// bundled app gets the global.
(function (root, factory) {
  // Unconditional global publish -- see chats.js for why the traditional
  // fallback-branch UMD shape breaks in a Vite production bundle.
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UUpdate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var DEFAULT_REPO = 'tradernonymous/freeopenai';
  var VERSION_FILE = 'desktop-version.json';
  var DEFAULT_ATTEMPTS = 3;
  var DEFAULT_BASE_DELAY_MS = 1500;
  var MAX_DELAY_MS = 8000;

  function versionUrl(repo) {
    return 'https://github.com/' + (repo || DEFAULT_REPO) +
      '/releases/download/desktop-latest/' + VERSION_FILE;
  }

  function desktopUrl(repo) {
    return 'https://github.com/' + (repo || DEFAULT_REPO) + '/releases/tag/desktop-latest';
  }

  // Where one artifact of the latest release is downloaded from. Same host as
  // the metadata (github.com), which the shell's allowlist permits; the CDN it
  // redirects to is allowed too.
  function artifactUrl(repo, name) {
    var clean = String(name == null ? '' : name).trim();
    if (!clean) return '';
    return 'https://github.com/' + (repo || DEFAULT_REPO) +
      '/releases/download/desktop-latest/' + encodeURIComponent(clean);
  }

  // What an install would do, decided here so it is testable: the URL, the
  // digest we can actually check, and whether this download will be verified at
  // all. A release that publishes only a file name gets a download that is
  // recorded but never CLAIMED as verified.
  function installPlan(options) {
    var opts = options || {};
    var installer = opts.installer || null;
    if (!installer || !installer.name) return null;
    var digest = String(installer.sha256 || '').trim().toLowerCase();
    var usable = /^[0-9a-f]{64}$/.test(digest);
    return {
      name: installer.name,
      url: artifactUrl(opts.repo, installer.name),
      sha256: usable ? digest : '',
      size: Number(installer.size) || 0,
      verified: usable,
    };
  }

  // "2.2.1" -> [2,2,1]. A leading "v", a "-rc1" suffix and "+build" metadata
  // are tolerated; anything that is not numbers-and-dots is not a version.
  function parseVersion(value) {
    var raw = String(value == null ? '' : value).trim().replace(/^v/i, '');
    if (!raw) return null;
    var main = raw.split('+')[0].split('-')[0].trim();
    if (!/^\d+(\.\d+)*$/.test(main)) return null;
    return main.split('.').map(function (part) { return Number(part); });
  }

  // -1 when a is older, 1 when a is newer, 0 when equal, null when either side
  // is not a version. Missing parts count as zero, so 2.2 === 2.2.0.
  function compareVersions(a, b) {
    var left = parseVersion(a);
    var right = parseVersion(b);
    if (!left || !right) return null;
    var length = Math.max(left.length, right.length);
    for (var i = 0; i < length; i += 1) {
      var x = left[i] || 0;
      var y = right[i] || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  }

  // Only a strictly newer release is an update.
  function isNewer(remote, local) {
    return compareVersions(remote, local) === 1;
  }

  function artifactFrom(value) {
    if (typeof value === 'string') return { name: value, sha256: '', size: 0 };
    if (!value || typeof value !== 'object') return null;
    var name = String(value.name || value.browser_download_url || '').trim();
    if (!name) return null;
    return {
      name: name,
      sha256: String(value.sha256 || value.digest || '').replace(/^sha256:/i, ''),
      size: Number(value.size || value.bytes || 0) || 0,
    };
  }

  // The shape CI writes is { version, builtAt, commit, artifacts: [...] }, but
  // a plain version string or an older payload must not brick the banner.
  function readVersionPayload(payload) {
    if (!payload) return null;
    var version = '';
    var artifacts = [];
    if (typeof payload === 'string') {
      version = payload;
    } else if (typeof payload === 'object') {
      version = payload.version || payload.tag_name || '';
      var list = payload.artifacts || payload.assets || [];
      if (Array.isArray(list)) {
        list.forEach(function (entry) {
          var artifact = artifactFrom(entry);
          if (artifact) artifacts.push(artifact);
        });
      }
    }
    var clean = String(version).trim().replace(/^v/i, '');
    if (!parseVersion(clean)) return null;
    return {
      version: clean,
      builtAt: (payload && payload.builtAt) || '',
      commit: (payload && payload.commit) || '',
      artifacts: artifacts,
    };
  }

  function isSetupExe(a) { return /setup\.exe$/i.test(a.name); }
  function isMsi(a) { return /\.msi$/i.test(a.name); }
  // The portable build is the one .exe that is not an installer.
  function isPortable(a) { return /\.exe$/i.test(a.name) && !isSetupExe(a); }

  // The artifact that updates THIS copy. `kind` is how it was installed, as
  // the shell reports it (install_kind in net.rs): the same installer type
  // must be used again, because the NSIS setup run over an MSI install (or the
  // other way round) registers a second copy with Windows instead of
  // upgrading the first. A portable copy gets the portable exe, or nothing --
  // it is never handed an installer. An unknown kind keeps the old choice:
  // the first installer, else the first artifact.
  function installerFor(parsed, kind) {
    if (!parsed || !parsed.artifacts || !parsed.artifacts.length) return null;
    var list = parsed.artifacts;
    if (kind === 'portable') return list.filter(isPortable)[0] || null;
    var preferred = kind === 'msi' ? list.filter(isMsi)[0]
      : kind === 'nsis' ? list.filter(isSetupExe)[0]
        : null;
    if (preferred) return preferred;
    var setup = list.filter(function (a) { return isSetupExe(a) || isMsi(a); });
    return setup.length ? setup[0] : list[0];
  }

  function humanSize(bytes) {
    var size = Number(bytes) || 0;
    if (size <= 0) return '';
    if (size < 1024 * 1024) return Math.round(size / 1024) + ' KB';
    return (size / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function delayFor(attempt, baseDelayMs) {
    var base = Number(baseDelayMs) > 0 ? Number(baseDelayMs) : DEFAULT_BASE_DELAY_MS;
    return Math.min(base * Math.pow(2, attempt), MAX_DELAY_MS);
  }

  // A transient failure (offline, a 5xx, a rate-limit blip) is retried with
  // exponential backoff; a definitive one (404 -- the release is not there
  // yet) gives up immediately, because waiting will not create it. Resolves to
  // null rather than throwing: a missing update banner is not an error the
  // user should see.
  function fetchVersion(options) {
    var opts = options || {};
    var url = opts.url || versionUrl(opts.repo);
    var attempts = Number(opts.attempts) > 0 ? Number(opts.attempts) : DEFAULT_ATTEMPTS;
    var doFetch = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    var sleep = opts.sleep || wait;
    if (!doFetch) return Promise.resolve(null);

    function attempt(index) {
      return Promise.resolve(doFetch(url, { cache: 'no-store' }))
        .then(function (res) {
          if (!res) throw new Error('no response');
          if (res.status === 404 || res.status === 403) return null;
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json().then(function (data) { return readVersionPayload(data); });
        })
        .catch(function () {
          if (index + 1 >= attempts) return null;
          return sleep(delayFor(index, opts.baseDelayMs)).then(function () { return attempt(index + 1); });
        });
    }

    return attempt(0);
  }

  return {
    DEFAULT_REPO: DEFAULT_REPO,
    VERSION_FILE: VERSION_FILE,
    DEFAULT_ATTEMPTS: DEFAULT_ATTEMPTS,
    DEFAULT_BASE_DELAY_MS: DEFAULT_BASE_DELAY_MS,
    MAX_DELAY_MS: MAX_DELAY_MS,
    versionUrl: versionUrl,
    desktopUrl: desktopUrl,
    artifactUrl: artifactUrl,
    installPlan: installPlan,
    parseVersion: parseVersion,
    compareVersions: compareVersions,
    isNewer: isNewer,
    readVersionPayload: readVersionPayload,
    installerFor: installerFor,
    humanSize: humanSize,
    delayFor: delayFor,
    fetchVersion: fetchVersion,
  };
});
