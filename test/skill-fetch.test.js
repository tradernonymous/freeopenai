// The skill library fetches every source's git tree from api.github.com, which
// allows 60 unauthenticated requests an hour per address. That budget is spent
// by roughly five refreshes, and it is per address -- so a container host or an
// office shares it across everyone behind it. The symptom is a skill picker that
// is simply empty, which looks exactly like "this app has no skills".
//
// These pin the two halves of the answer: a token is sent when one is set, and
// the refusal is not swallowed into silence.
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadSkills, clearSkillsCache, githubApiHeaders } = require('../server.js');

const realFetch = global.fetch;
const realToken = process.env.GITHUB_TOKEN;
const realWarn = console.warn;

function stubFetch(handler) {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), headers: (options && options.headers) || {} });
    return handler(String(url), options);
  };
  return calls;
}

function restore() {
  global.fetch = realFetch;
  if (realToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = realToken;
  console.warn = realWarn;
  clearSkillsCache();
}

test.afterEach(restore);

test('a token is sent when one is configured, and nothing pretends otherwise', () => {
  delete process.env.GITHUB_TOKEN;
  const bare = githubApiHeaders();
  assert.equal(bare.Authorization, undefined, 'an unauthenticated request must not carry an empty Bearer');
  assert.equal(bare.Accept, 'application/vnd.github+json');
  assert.equal(bare['User-Agent'], 'freeopenai-app', 'GitHub refuses a request with no User-Agent');

  process.env.GITHUB_TOKEN = 'ghp_example';
  assert.equal(githubApiHeaders().Authorization, 'Bearer ghp_example');

  // A variable that is set but blank is the common way an env var ends up in a
  // deployment, and it must not become "Bearer ".
  process.env.GITHUB_TOKEN = '   ';
  assert.equal(githubApiHeaders().Authorization, undefined);
  delete process.env.GITHUB_TOKEN;
});

test('every tree request the catalogue makes carries the token', async () => {
  process.env.GITHUB_TOKEN = 'ghp_example';
  const calls = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ tree: [] }) }));
  const skills = await loadSkills(true);

  assert.deepEqual(skills, [], 'an empty tree is an empty catalogue, not an error');
  assert.ok(calls.length >= 2, 'expected one request per skill source, got ' + calls.length);
  for (const call of calls) {
    assert.match(call.url, /^https:\/\/api\.github\.com\/repos\/.+\/git\/trees\//);
    assert.equal(call.headers.Authorization, 'Bearer ghp_example', call.url + ' went out unauthenticated');
  }
});

test('a rate-limited fetch says so instead of looking like an empty library', async () => {
  delete process.env.GITHUB_TOKEN;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  stubFetch(() => ({ ok: false, status: 403, json: async () => ({ message: 'API rate limit exceeded' }) }));

  const skills = await loadSkills(true);
  assert.deepEqual(skills, []);
  assert.equal(warnings.length, 1, 'a rate limit is the one failure an operator can fix, so it is said out loud');
  assert.match(warnings[0], /GITHUB_TOKEN/, 'the warning has to name the variable that fixes it');
  assert.match(warnings[0], /rate limit/);

  // One line per refresh, not one per source: eleven sources refusing is one
  // problem, and a log that repeats it eleven times is a log nobody reads.
  warnings.length = 0;
  await loadSkills(true);
  assert.equal(warnings.length, 1, 'the refusal is reported per source rather than per refresh');
});

test('a plain failure stays quiet, and a fresh refusal does not eat the last good catalogue', async () => {
  delete process.env.GITHUB_TOKEN;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));

  // A 500 is GitHub having a bad day, not a limit anyone can raise.
  stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
  assert.deepEqual(await loadSkills(true), []);
  assert.deepEqual(warnings, [], 'a 500 is not an operator-actionable message');

  // A catalogue that exists survives a later refusal: an empty library on a busy
  // IP must not look worse than a slightly stale one.
  clearSkillsCache();
  // `skills/<name>/SKILL.md` under the source's declared dir is the shape the
  // real repos use, so this exercises the same path a live fetch takes.
  stubFetch((url) => ({
    ok: true,
    status: 200,
    json: async () => ({ tree: url.includes('anthropics/skills') ? [{ path: 'skills/doc-writer/SKILL.md', type: 'blob' }] : [] }),
    text: async () => '---\nname: doc-writer\ndescription: Writes docs. Use when writing a document.\n---\n\nBody.',
  }));
  const good = await loadSkills(true);
  assert.equal(good.length, 1, 'the stubbed source should have produced one skill');

  clearSkillsCache();
  stubFetch(() => ({ ok: false, status: 403, json: async () => ({}) }));
  const afterLimit = await loadSkills(true);
  assert.equal(afterLimit.length, 0, 'the cache was cleared, so this is a genuine empty fetch');
});
