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
// UMD like the repo's other shared modules.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UHfSkills = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var HF_RAW = 'https://huggingface.co';

  // --- fetch a SKILL.md from a repo ----------------------------------------

  /**
   * fetchSkill(repo, path, token)
   *
   * Fetches a file from a HF repo's main branch. Returns the raw text or
   * null on failure.
   */
  async function fetchSkill(repo, path, token) {
    var url = HF_RAW + '/' + repo + '/raw/main/' + encodeURIComponent(path);
    var headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    try {
      var res = await fetch(url, { headers });
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

  return {
    parseSkillMd: parseSkillMd,
    loadCatalog: loadCatalog,
  };
});
