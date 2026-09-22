// HuggingFace Skills knowledge pack.
//
// The engine already parses SKILL.md (frontmatter + auto-router + pinning in
// chatlib.js). This module brings the same skills to the desktop by fetching
// them from the HuggingFace Hub — the huggingface/skills catalog. The most
// useful skills for a local coding agent are:
//
//   - huggingface-local-models: the catalog for "pick a GGUF to run"
//   - hf-mem: estimate VRAM/RAM for a GGUF file
//   - hf-cli: Hub operations inside an agent
//   - huggingface-llm-trainer: Unsloth + TRL (Phase 5, stretch)
//
// The skills are fetched as raw SKILL.md content and surfaced in the
// Knowledge panel (right side) and in the Library screen, so the coding
// agent and the user can both see them.
//
// NEURA-053 adds the other half: installing one. Reading a skill in a panel is
// not the same as having it -- the agent only picks up a skill that is on disk
// -- and copying the files by hand is the step everybody skipped. The install
// rules live here rather than in the screen so node:test can exercise them
// without a Tauri window: the screen supplies the two things this module will
// not invent, a fetch and a writer, and everything else (what may be written,
// where, and how much) is decided by the pure functions below.
//
// UMD like the repo's other shared modules.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UHfSkills = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var HF_RAW = 'https://huggingface.co';

  // Where an installed skill lands, relative to the open folder. `.neuraos` is
  // already this app's own corner of a project (docker-sandbox.js, worktrees.js
  // write there), so a skill arrives out of the way of the user's own tree and
  // out of `git status`.
  var SKILLS_DIR = '.neuraos/skills';

  // A skill is a handful of small markdown files. These ceilings are not a
  // guess at what skills need, they are the point past which a catalogue entry
  // is describing something other than a skill -- and the app should say so
  // rather than stream a few hundred megabytes into somebody's project.
  var LIMITS = {
    files: 16,
    fileBytes: 256 * 1024,
    totalBytes: 1024 * 1024,
  };

  // --- fetch a SKILL.md from a repo ----------------------------------------

  // Each segment is encoded on its own: encodeURIComponent() over the whole
  // path would turn the '/' of `hf-mem/SKILL.md` into %2F, which is a different
  // file as far as the Hub is concerned.
  function rawUrl(repo, path) {
    var segments = String(path == null ? '' : path).split('/');
    var encoded = [];
    for (var i = 0; i < segments.length; i++) {
      if (segments[i]) encoded.push(encodeURIComponent(segments[i]));
    }
    return HF_RAW + '/' + repo + '/raw/main/' + encoded.join('/');
  }

  // The one place this module talks to the Hub. `fetchImpl` exists so a test
  // (and only a test) can stand in for the network -- the token is passed as a
  // header and is never logged, never put in the URL, and never written to a
  // file we install.
  function hfFetch(fetchImpl) {
    return typeof fetchImpl === 'function' ? fetchImpl : fetch;
  }

  /**
   * fetchSkill(repo, path, token, fetchImpl)
   *
   * Fetches a file from a HF repo's main branch. Returns the raw text or
   * null on failure.
   */
  async function fetchSkill(repo, path, token, fetchImpl) {
    var headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    try {
      var res = await hfFetch(fetchImpl)(rawUrl(repo, path), { headers });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }

  // --- parse SKILL.md frontmatter ------------------------------------------

  /**
   * parseSkillMd(text)
   *
   * Extracts YAML frontmatter and body from a SKILL.md file.
   * Returns { name, description, content, tags } or null on parse failure.
   */
  function parseSkillMd(text) {
    if (!text || typeof text !== 'string') return null;
    var match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!match) return null;
    var frontmatter = match[1];
    var body = match[2].trim();
    var meta = {};
    var listKey = null; // the key currently collecting a YAML list
    var lines = frontmatter.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      // A YAML list item:  "  - value"
      var listMatch = line.match(/^\s+-\s+(.+)/);
      if (listMatch && listKey && Array.isArray(meta[listKey])) {
        meta[listKey].push(listMatch[1].trim());
        continue;
      }
      // A key with a value on the same line:  key: value
      var kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (kv) {
        var key = kv[1].trim();
        var val = kv[2].trim();
        listKey = null;
        if (!val) {
          // Bare key: the next lines may be a YAML list.
          meta[key] = [];
          listKey = key;
          continue;
        }
        // Strip quotes.
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        meta[key] = val;
      }
    }
    return {
      name: meta.name || '',
      description: meta.description || '',
      tags: Array.isArray(meta.tags) ? meta.tags : (meta.tags ? [meta.tags] : []),
      // A skill that ships references (`files:` in its frontmatter) is only
      // half-installed without them, so the list is carried through instead of
      // being dropped with the rest of the frontmatter.
      files: Array.isArray(meta.files) ? meta.files : (meta.files ? [meta.files] : []),
      content: body,
    };
  }

  // --- load all skills from the catalog ------------------------------------

  /**
   * loadCatalog(token)
   *
   * Fetches the skill catalog from the HF repos. Returns an array of
   * parsed skill objects. Each skill has { name, description, tags, content, source, repo }.
   */
  async function loadCatalog(token) {
    var skills = [];
    // The huggingface/skills repo lays skills out as <name>/SKILL.md; these
    // four are the ones a local coding agent actually uses.
    var repo = 'huggingface/skills';
    var knownSkills = [
      'huggingface-local-models/SKILL.md',
      'hf-mem/SKILL.md',
      'hf-cli/SKILL.md',
      'huggingface-llm-trainer/SKILL.md',
    ];
    for (var i = 0; i < knownSkills.length; i++) {
      var text = await fetchSkill(repo, knownSkills[i], token);
      if (text) {
        var parsed = parseSkillMd(text);
        if (parsed && parsed.name) {
          parsed.repo = repo;
          parsed.path = knownSkills[i];
          skills.push(parsed);
        }
      }
    }
    return skills;
  }

  // --- installing a skill --------------------------------------------------
  //
  // Everything from here down assumes the catalogue is hostile. It is fetched
  // from a repository this app does not own, and every name in it -- the skill's
  // own name, the files it says it ships -- is about to become part of a path on
  // somebody's disk. local.rs would refuse a climb-out anyway, but a refusal
  // that arrives as a Rust error after three files have already landed is not an
  // answer; the whole plan is checked before a single byte is written, and the
  // reason is said in words the screen can show.

  // The lexical rule, deliberately the same shape as local-fs.js joinInside():
  // a name may descend, never climb, and never name a drive or an absolute root.
  function safeName(raw) {
    var wanted = String(raw == null ? '' : raw).trim().replace(/\\/g, '/');
    if (!wanted) return { error: 'Refused: a file in this skill has no name.' };
    if (wanted.indexOf('\0') >= 0) return { error: 'Refused: "' + wanted + '" is not a file name.' };
    if (wanted.charAt(0) === '/') return { error: 'Refused: "' + wanted + '" is an absolute path.' };
    if (wanted.length >= 2 && /[a-zA-Z]/.test(wanted.charAt(0)) && wanted.charAt(1) === ':') {
      return { error: 'Refused: "' + wanted + '" names a drive.' };
    }
    if (wanted.length > 200) return { error: 'Refused: "' + wanted.slice(0, 40) + '…" is too long a path.' };
    var segments = wanted.split('/');
    var kept = [];
    for (var i = 0; i < segments.length; i++) {
      var part = segments[i];
      if (!part || part === '.') continue;
      if (part === '..') {
        return { error: 'Refused: "' + wanted + '" climbs out of the skills folder.' };
      }
      // A colon is an NTFS alternate data stream, which is a second file
      // hiding behind the one we agreed to write.
      if (part.indexOf(':') >= 0) return { error: 'Refused: "' + wanted + '" is not a file name.' };
      if (part === '.git') return { error: 'Refused: files inside .git are managed by git.' };
      if (part === '.env' || part.indexOf('.env.') === 0) {
        return { error: 'Refused: secrets files (.env) are never written.' };
      }
      kept.push(part);
    }
    if (!kept.length) return { error: 'Refused: a file in this skill has no name.' };
    return { name: kept.join('/') };
  }

  /**
   * skillSlug(name)
   *
   * The folder a skill installs into. The catalogue's name is a label, not a
   * path, so it is reduced to something that can only ever be one segment.
   */
  function skillSlug(name) {
    var slug = String(name == null ? '' : name)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '')
      .slice(0, 64);
    return slug;
  }

  /**
   * planInstall(skill)
   *
   * What installing `skill` would write, decided before anything is fetched.
   * Returns { slug, dir, files: [{ repoPath, name, target }] }, or
   * { error } with the reason it will not happen.
   */
  function planInstall(skill) {
    var entry = skill || {};
    var slug = skillSlug(entry.name);
    if (!slug) return { error: 'Refused: this catalogue entry has no usable name.' };
    if (!entry.repo) return { error: 'Refused: this catalogue entry does not say which repo it came from.' };
    var source = String(entry.path || 'SKILL.md');
    // The skill's folder inside the repo: `hf-mem/SKILL.md` ships its
    // references as `hf-mem/references/...`.
    var base = source.indexOf('/') >= 0 ? source.slice(0, source.lastIndexOf('/')) : '';
    var dir = SKILLS_DIR + '/' + slug;

    var extra = Array.isArray(entry.files) ? entry.files : [];
    if (1 + extra.length > LIMITS.files) {
      return {
        error: 'Refused: this skill lists ' + (1 + extra.length) + ' files, past the ' +
          LIMITS.files + '-file limit for one skill.',
      };
    }

    var files = [{ repoPath: source, name: 'SKILL.md', target: dir + '/SKILL.md' }];
    var seen = { 'SKILL.md': true };
    for (var i = 0; i < extra.length; i++) {
      var checked = safeName(extra[i]);
      if (checked.error) return { error: checked.error };
      if (seen[checked.name]) continue;
      seen[checked.name] = true;
      files.push({
        repoPath: (base ? base + '/' : '') + checked.name,
        name: checked.name,
        target: dir + '/' + checked.name,
      });
    }
    return { slug: slug, dir: dir, files: files };
  }

  function byteLength(text) {
    try {
      return new TextEncoder().encode(text).length;
    } catch {
      return String(text == null ? '' : text).length;
    }
  }

  /**
   * installSkill(skill, opts)
   *
   * Fetches a catalogue entry's files and hands each one to `opts.writeFile`.
   * Never called on its own: it is what the user's click on Install runs.
   *
   *   opts.token      HF access token, sent as a header, never written out
   *   opts.fetchImpl  stand-in for fetch (tests)
   *   opts.writeFile  (relativePath, text) => Promise -- the only way out to disk
   *   opts.onProgress ({ phase, file, index, total }) => void
   *
   * Resolves to { dir, files, bytes }; rejects with a message that says which
   * file failed and why.
   */
  async function installSkill(skill, opts) {
    var options = opts || {};
    if (typeof options.writeFile !== 'function') {
      throw new Error('Refused: no writer — open a folder before installing a skill.');
    }
    var plan = planInstall(skill);
    if (plan.error) throw new Error(plan.error);

    var report = typeof options.onProgress === 'function' ? options.onProgress : function () {};
    var total = plan.files.length;
    var bytes = 0;
    var written = [];

    for (var i = 0; i < total; i++) {
      var file = plan.files[i];
      report({ phase: 'fetch', file: file.name, index: i, total: total });
      var text = await fetchSkill(skill.repo, file.repoPath, options.token, options.fetchImpl);
      if (text == null) {
        throw new Error('Could not download ' + file.repoPath + ' from ' + skill.repo + '.');
      }
      var size = byteLength(text);
      if (size > LIMITS.fileBytes) {
        throw new Error(
          'Refused: ' + file.name + ' is ' + Math.round(size / 1024) + ' KB, past the ' +
          Math.round(LIMITS.fileBytes / 1024) + ' KB limit for one skill file.'
        );
      }
      bytes += size;
      if (bytes > LIMITS.totalBytes) {
        throw new Error(
          'Refused: this skill is over the ' + Math.round(LIMITS.totalBytes / 1024) +
          ' KB limit for one install.'
        );
      }
      report({ phase: 'write', file: file.name, index: i, total: total });
      await options.writeFile(file.target, text);
      written.push(file.target);
    }

    report({ phase: 'done', file: '', index: total, total: total });
    return { dir: plan.dir, files: written, bytes: bytes };
  }

  // --- what is already installed -------------------------------------------
  //
  // The record is a note on this machine, not a source of truth: the files on
  // disk are. It exists so the button can say Installed instead of offering the
  // same install again, and Update when the catalogue has moved on since.

  var INSTALLED_KEY = 'freeai4u.hfSkills.installed';

  // FNV-1a over the skill body. Not a security hash -- it only has to change
  // when the text changes, which is the whole question "is there an update?".
  function contentStamp(text) {
    var hash = 0x811c9dc5;
    var body = String(text == null ? '' : text);
    for (var i = 0; i < body.length; i++) {
      hash ^= body.charCodeAt(i);
      hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
    }
    return hash.toString(16);
  }

  function store(storage) {
    if (storage) return storage;
    try {
      return globalThis.localStorage || null;
    } catch {
      return null;
    }
  }

  function readInstalled(storage) {
    var box = store(storage);
    if (!box) return {};
    try {
      var parsed = JSON.parse(box.getItem(INSTALLED_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function rememberInstalled(skill, result, storage) {
    var records = readInstalled(storage);
    var slug = skillSlug((skill || {}).name);
    if (!slug) return records;
    records[slug] = {
      name: (skill || {}).name || '',
      repo: (skill || {}).repo || '',
      dir: (result || {}).dir || '',
      stamp: contentStamp((skill || {}).content),
      at: Date.now(),
    };
    var box = store(storage);
    if (box) {
      try {
        box.setItem(INSTALLED_KEY, JSON.stringify(records));
      } catch { /* a full or blocked store only costs the badge, not the files */ }
    }
    return records;
  }

  /**
   * installStatus(skill, records)
   *
   * 'install' when this machine has never installed it, 'installed' when the
   * catalogue still says what was installed, 'update' when it has changed.
   */
  function installStatus(skill, records) {
    var slug = skillSlug((skill || {}).name);
    var record = (records || {})[slug];
    if (!record) return 'install';
    return record.stamp === contentStamp((skill || {}).content) ? 'installed' : 'update';
  }

  return {
    SKILLS_DIR: SKILLS_DIR,
    LIMITS: LIMITS,
    parseSkillMd: parseSkillMd,
    loadCatalog: loadCatalog,
    skillSlug: skillSlug,
    planInstall: planInstall,
    installSkill: installSkill,
    readInstalled: readInstalled,
    rememberInstalled: rememberInstalled,
    installStatus: installStatus,
  };
});
