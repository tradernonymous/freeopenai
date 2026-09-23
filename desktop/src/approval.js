// The composer row's two decisions: how much the agent asks, and which tools
// it is offered.
//
// APPROVAL. The app already has an approval mode -- `always | commands | never`
// in `freeai4u.code_approval` (project-config.js reads it, coding-agent.js
// obeys it) -- and an opt-in Docker sandbox for commands
// (`freeai4u.docker_sandbox`, docker-sandbox.js). The composer shows four
// levels, and each one is nothing more than a pair of those two existing
// facts:
//
//   ask      always   + no container   every mutation waits for a yes
//   delegate commands + no container   edits apply, commands still ask
//   sandbox  never    + container      no prompts; commands run in Docker
//   full     never    + no container   no prompts, no container
//
// Nothing new is stored, because both facts already have an owner, and one
// fact with two owners is a fact that can disagree with itself. Reading the
// level back therefore reads the machinery, not a remembered label: turning
// the Docker checkbox off in Code really does turn "Run in the sandbox" into
// "Full access", and the menu says so rather than pretending otherwise.
//
// THE RULE THAT SURVIVES ALL OF THIS: a folder's `.freeai4u.json` can only
// make the setting stricter. `effectiveLevel` does not re-implement that --
// it goes through project-config.merge, the one place the intersection lives,
// so the menu cannot become a second, laxer opinion about the same question.
//
// TOOL GROUPS. Which of Search / Code / MCP the next turn may use, kept in
// `freeai4u.composer_tools`. `groupOf` and `offered` are the pure filter over
// a tools.js catalogue.
//
// UMD like the repo's other shared modules, with project-config and
// docker-sandbox read the way evals.js reads recipes.js.
(function (root, factory) {
  // Real CommonJS only (see files/office.js): in a bundle `module` can exist
  // without `require`, and there the siblings are read off the globals they
  // publish.
  var isCjs = typeof module === 'object' && module.exports && typeof require === 'function';
  var config = isCjs ? require('./project-config.js') : null;
  var sandbox = isCjs ? require('./docker-sandbox.js') : null;
  var api = factory(
    function () { return config || (root && root.FreeAI4UProjectConfig) || null; },
    function () { return sandbox || (root && root.FreeAI4UDockerSandbox) || null; },
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UApproval = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (projectConfigLib, sandboxLib) {
  /** The person's own coding-agent settings (CodeScreen's CODE_APPROVAL_KEY). */
  var KEY = 'freeai4u.code_approval';
  /** Which tool groups the next turn may use. */
  var GROUPS_KEY = 'freeai4u.composer_tools';

  /**
   * The four levels, strictest first -- the order is the strictness rank, so
   * `rank` is an index and "never looser" is a comparison.
   *
   * `why` is the one line under the label. It says what will happen, in the
   * order it will happen, and never names a stored value.
   */
  var LEVELS = [
    {
      id: 'ask',
      label: 'Ask for approval',
      why: 'Nothing happens until you say yes: every file edit and every command is shown to you first.',
      mode: 'always',
      sandbox: false,
      risk: '',
    },
    {
      id: 'delegate',
      label: 'Approve for me',
      why: 'File edits apply as the agent makes them. Commands still wait for you, so anything destructive, anything needing a password and anything reaching for your credentials is shown first.',
      mode: 'commands',
      sandbox: false,
      risk: '',
    },
    {
      id: 'sandbox',
      label: 'Run in the sandbox',
      why: 'No prompts. Commands run in a throwaway Docker container with only this folder mounted, so the rest of your machine is out of reach. File edits still land in the folder. Needs Docker running.',
      mode: 'never',
      sandbox: true,
      risk: '',
    },
    {
      id: 'full',
      label: 'Full access',
      why: 'No prompts and no container. The agent edits files and runs commands on this PC as soon as it decides to.',
      mode: 'never',
      sandbox: false,
      risk: 'high',
    },
  ];

  /** The one a missing, unknown or unreadable value falls back to. */
  var STRICTEST = LEVELS[0].id;

  var GROUPS = [
    { id: 'search', label: 'Search', hint: 'Let the model search the web and read a page' },
    { id: 'code', label: 'Code', hint: 'Let the model read this folder and its repositories, write files and run commands' },
    { id: 'mcp', label: 'MCP', hint: 'Let the model call the tools on the MCP servers you added' },
  ];

  var CODE_TOOLS = ['list_files', 'read_file', 'write_file', 'edit_file', 'run_command'];

  function storage(given) {
    if (given) return given;
    try {
      var scope = typeof globalThis !== 'undefined' ? globalThis : {};
      return scope.localStorage || null;
    } catch {
      return null;
    }
  }

  function readJson(store, key) {
    var target = storage(store);
    if (!target) return null;
    try {
      var raw = target.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      // Unreadable or nonsense: every caller below treats null as "unset",
      // and unset is the strict end of every one of these settings.
      return null;
    }
  }

  function writeJson(store, key, value) {
    var target = storage(store);
    if (!target) return false;
    try {
      target.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  // --- the levels ---------------------------------------------------------

  /** The level with this id, or null. */
  function byId(id) {
    for (var i = 0; i < LEVELS.length; i += 1) {
      if (LEVELS[i].id === id) return LEVELS[i];
    }
    return null;
  }

  /** The level with this id, or the strictest one -- never undefined. */
  function levelOr(id) {
    return byId(id) || byId(STRICTEST);
  }

  /** How strict a level is: 0 is strictest, and bigger is looser. */
  function rank(id) {
    for (var i = 0; i < LEVELS.length; i += 1) {
      if (LEVELS[i].id === id) return i;
    }
    return 0;
  }

  /** The level a stored approval mode and a Docker setting add up to. */
  function levelFor(mode, sandboxOn) {
    if (mode === 'commands') return 'delegate';
    if (mode === 'never') return sandboxOn ? 'sandbox' : 'full';
    // 'always' and anything unrecognised: the strict end, which is also what
    // project-config falls back to for a value it does not know.
    return STRICTEST;
  }

  /** What this level asks the approval gate for. */
  function modeFor(id) {
    return levelOr(id).mode;
  }

  /** Whether this level wants commands wrapped in the Docker sandbox. */
  function sandboxFor(id) {
    return levelOr(id).sandbox;
  }

  /**
   * effectiveLevel(id, projectConfig) -> the level that will actually apply in
   * a folder whose `.freeai4u.json` parsed to `projectConfig`.
   *
   * The clamp is project-config.merge itself, so a project file can only ever
   * move this towards the strict end. A file that asks for less is ignored
   * there, and there is no second opinion here.
   */
  function effectiveLevel(id, projectConfig) {
    var pc = projectConfigLib();
    var chosen = levelOr(id);
    if (!pc) return STRICTEST;
    var merged = pc.merge({ approvalMode: chosen.mode, allowedCommands: [] }, projectConfig);
    return levelFor(merged.approvalMode, chosen.sandbox);
  }

  /**
   * The level in force right now, read from the two settings themselves. A
   * missing or broken value reads as the strictest level, because that is
   * what the agent would do with it.
   */
  function current(store) {
    var pc = projectConfigLib();
    var sb = sandboxLib();
    if (!pc) return STRICTEST;
    var mine = pc.globalSettings(readJson(store, KEY));
    var docker = sb ? sb.settings(storage(store)) : { enabled: false };
    return levelFor(mine.approvalMode, docker.enabled === true);
  }

  /**
   * choose(id) -> the id that is now in force.
   *
   * Writes the approval mode the person already owns and the Docker setting
   * they already own, and keeps the commands they allowed: picking a level is
   * a change of one decision, not a reset of the rest.
   */
  function choose(id, store) {
    var pc = projectConfigLib();
    var sb = sandboxLib();
    if (!pc) return STRICTEST;
    var level = levelOr(id);
    var mine = pc.globalSettings(readJson(store, KEY));
    writeJson(store, KEY, { approvalMode: level.mode, allowedCommands: mine.allowedCommands });
    if (sb) {
      var target = storage(store);
      sb.saveSettings({ enabled: level.sandbox, image: sb.settings(target).image }, target);
    }
    return current(store);
  }

  // --- the tool groups ----------------------------------------------------

  /** Every group id, in the order the chips are drawn. */
  function groupIds() {
    return GROUPS.map(function (group) { return group.id; });
  }

  /** The group a tool belongs to, or '' for one no chip governs. */
  function groupOf(name) {
    var n = String(name == null ? '' : name);
    if (n.indexOf('mcp__') === 0) return 'mcp';
    if (n === 'web_search' || n === 'web_fetch') return 'search';
    if (n.indexOf('github_') === 0) return 'code';
    return CODE_TOOLS.indexOf(n) >= 0 ? 'code' : '';
  }

  /** The groups that are on. Unset or broken means all of them. */
  function readGroups(store) {
    var stored = readJson(store, GROUPS_KEY);
    if (!Array.isArray(stored)) return groupIds();
    var known = groupIds();
    var on = [];
    for (var i = 0; i < stored.length; i += 1) {
      if (known.indexOf(stored[i]) >= 0 && on.indexOf(stored[i]) < 0) on.push(stored[i]);
    }
    // Order by the chips, not by the order they happened to be switched on.
    return known.filter(function (id) { return on.indexOf(id) >= 0; });
  }

  function saveGroups(ids, store) {
    var wanted = Array.isArray(ids) ? ids : [];
    var on = groupIds().filter(function (id) { return wanted.indexOf(id) >= 0; });
    return writeJson(store, GROUPS_KEY, on) ? on : readGroups(store);
  }

  /** `ids` with one group turned on or off -- the chips' whole behaviour. */
  function toggleGroup(ids, id) {
    var on = Array.isArray(ids) ? ids.slice() : [];
    var at = on.indexOf(id);
    if (at >= 0) on.splice(at, 1);
    else if (groupIds().indexOf(id) >= 0) on.push(id);
    return groupIds().filter(function (known) { return on.indexOf(known) >= 0; });
  }

  /**
   * offered(catalogue, ids) -> the tool definitions a turn with these groups
   * on may use. A tool no chip governs (delegation, say) is always offered:
   * a chip turns off what it names, not what it does not.
   */
  function offered(catalogue, ids) {
    var on = Array.isArray(ids) ? ids : groupIds();
    return (Array.isArray(catalogue) ? catalogue : []).filter(function (def) {
      var name = def && def.function ? def.function.name : (def && def.name);
      var group = groupOf(name);
      return !group || on.indexOf(group) >= 0;
    });
  }

  return {
    KEY: KEY,
    GROUPS_KEY: GROUPS_KEY,
    LEVELS: LEVELS,
    STRICTEST: STRICTEST,
    GROUPS: GROUPS,
    byId: byId,
    rank: rank,
    levelFor: levelFor,
    modeFor: modeFor,
    sandboxFor: sandboxFor,
    effectiveLevel: effectiveLevel,
    current: current,
    choose: choose,
    groupIds: groupIds,
    groupOf: groupOf,
    readGroups: readGroups,
    saveGroups: saveGroups,
    toggleGroup: toggleGroup,
    offered: offered,
  };
});
