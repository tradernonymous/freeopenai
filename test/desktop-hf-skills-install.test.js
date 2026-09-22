// NEURA-053: one-click skill install from the HF catalogue.
//
// The install rules live in desktop/src/hf-skills.js precisely so they can be
// run here, with no Tauri window and no network: the module is handed a fake
// fetch and a fake writer, and every assertion below is about what it decided
// to write -- or refused to.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const hfSkills = require('../desktop/src/hf-skills.js');

// A catalogue entry, shaped the way loadCatalog() returns them.
function entry(over) {
  return Object.assign({
    name: 'hf-mem',
    description: 'Estimate VRAM for a GGUF.',
    tags: [],
    files: [],
    content: 'body text',
    repo: 'huggingface/skills',
    path: 'hf-mem/SKILL.md',
  }, over || {});
}

// A fetch stand-in: `pages` maps a URL suffix to its text, anything else 404s.
// It also records the headers it was called with, so the token can be checked.
function fakeFetch(pages, calls) {
  return async function (url, init) {
    if (calls) calls.push({ url: url, init: init });
    const keys = Object.keys(pages);
    for (let i = 0; i < keys.length; i++) {
      if (url.endsWith(keys[i])) {
        return { ok: true, text: async () => pages[keys[i]] };
      }
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };
}

// A writer stand-in with the same shape as bridge.writeLocalFile bound to a
// root: (relativePath, text) => Promise.
function fakeWriter(written) {
  return async function (path, text) {
    written.push({ path: path, text: text });
    return { path: path, bytes: text.length };
  };
}

describe('hf-skills install: the plan', () => {
  it('puts a skill under the app folder, never loose in the project', () => {
    const plan = hfSkills.planInstall(entry());
    assert.equal(hfSkills.SKILLS_DIR, '.neuraos/skills');
    assert.equal(plan.error, undefined);
    assert.equal(plan.dir, '.neuraos/skills/hf-mem');
    assert.deepEqual(plan.files.map(f => f.target), ['.neuraos/skills/hf-mem/SKILL.md']);
  });

  it('resolves extra files against the skill folder inside the repo', () => {
    const plan = hfSkills.planInstall(entry({ files: ['references/table.md'] }));
    assert.deepEqual(plan.files.map(f => f.repoPath), [
      'hf-mem/SKILL.md',
      'hf-mem/references/table.md',
    ]);
    assert.deepEqual(plan.files.map(f => f.target), [
      '.neuraos/skills/hf-mem/SKILL.md',
      '.neuraos/skills/hf-mem/references/table.md',
    ]);
  });

  it('reduces the catalogue name to one path segment', () => {
    assert.equal(hfSkills.skillSlug('HF Mem'), 'hf-mem');
    assert.equal(hfSkills.skillSlug('../../evil'), 'evil');
    assert.equal(hfSkills.skillSlug('a/b'), 'a-b');
    assert.equal(hfSkills.skillSlug('  '), '');
    const plan = hfSkills.planInstall(entry({ name: '../../../etc' }));
    assert.equal(plan.dir, '.neuraos/skills/etc');
  });

  it('refuses an entry with no name and one with no repo, and says which', () => {
    assert.match(hfSkills.planInstall(entry({ name: '' })).error, /no usable name/);
    assert.match(hfSkills.planInstall(entry({ repo: '' })).error, /which repo/);
  });

  it('keeps the file list bounded, and says why it refused', () => {
    const many = [];
    for (let i = 0; i < hfSkills.LIMITS.files + 1; i++) many.push('f' + i + '.md');
    const plan = hfSkills.planInstall(entry({ files: many }));
    assert.match(plan.error, /past the 16-file limit/);
  });
});

describe('hf-skills install: paths that try to escape', () => {
  const escapes = [
    ['../../../../Windows/System32/evil.dll', /climbs out/],
    ['..\\..\\evil.bat', /climbs out/],
    ['nested/../../escape.md', /climbs out/],
    ['/etc/passwd', /absolute path/],
    ['C:/Windows/evil.dll', /names a drive/],
    ['ok.md:stream', /not a file name/],
    ['.git/config', /managed by git/],
    ['.env.local', /secrets files/],
    ['', /no name/],
  ];

  for (const [name, why] of escapes) {
    it('refuses ' + JSON.stringify(name) + ' before anything is fetched', async () => {
      const plan = hfSkills.planInstall(entry({ files: [name] }));
      assert.match(plan.error, why, 'the plan should refuse ' + name);

      // And the refusal is not advisory: the install must not touch the
      // network or the disk on the strength of a plan that already said no.
      const written = [];
      const calls = [];
      await assert.rejects(
        () => hfSkills.installSkill(entry({ files: [name] }), {
          fetchImpl: fakeFetch({}, calls),
          writeFile: fakeWriter(written),
        }),
        why,
      );
      assert.equal(calls.length, 0, 'nothing should have been fetched');
      assert.equal(written.length, 0, 'nothing should have been written');
    });
  }

  it('never lets a written path leave the skills folder', async () => {
    const written = [];
    await hfSkills.installSkill(entry({ files: ['references/./deep/note.md'] }), {
      fetchImpl: fakeFetch({
        'hf-mem/SKILL.md': '---\nname: hf-mem\n---\nbody',
        'hf-mem/references/deep/note.md': 'notes',
      }),
      writeFile: fakeWriter(written),
    });
    for (const row of written) {
      assert.ok(row.path.startsWith('.neuraos/skills/hf-mem/'), row.path + ' escaped');
      assert.ok(row.path.indexOf('..') < 0, row.path + ' contains ..');
    }
  });
});

describe('hf-skills install: the happy path', () => {
  it('fetches every planned file and writes it where the plan said', async () => {
    const written = [];
    const calls = [];
    const skill = entry({ files: ['references/table.md'] });
    const progress = [];
    const result = await hfSkills.installSkill(skill, {
      token: 'hf_secret_token',
      fetchImpl: fakeFetch({
        'hf-mem/SKILL.md': '---\nname: hf-mem\n---\nthe body',
        'hf-mem/references/table.md': '| a | b |',
      }, calls),
      writeFile: fakeWriter(written),
      onProgress: (p) => progress.push(p),
    });

    assert.equal(result.dir, '.neuraos/skills/hf-mem');
    assert.deepEqual(result.files, [
      '.neuraos/skills/hf-mem/SKILL.md',
      '.neuraos/skills/hf-mem/references/table.md',
    ]);
    assert.ok(result.bytes > 0);

    // The file on disk keeps its frontmatter: the engine's router reads it.
    assert.ok(written[0].text.startsWith('---\n'));
    assert.equal(written[1].text, '| a | b |');

    // The token travels as a header and nowhere else -- not in the URL, and
    // not into any file that was written.
    assert.equal(calls[0].init.headers.Authorization, 'Bearer hf_secret_token');
    for (const call of calls) assert.ok(call.url.indexOf('hf_secret_token') < 0);
    for (const row of written) assert.ok(row.text.indexOf('hf_secret_token') < 0);

    // Progress is reported per file, and ends with done.
    assert.deepEqual(progress.map(p => p.phase), ['fetch', 'write', 'fetch', 'write', 'done']);
    assert.equal(progress[progress.length - 1].total, 2);
  });

  it('sends no Authorization header when the user is signed out', async () => {
    const calls = [];
    await hfSkills.installSkill(entry(), {
      fetchImpl: fakeFetch({ 'hf-mem/SKILL.md': '---\nname: hf-mem\n---\nbody' }, calls),
      writeFile: fakeWriter([]),
    });
    assert.deepEqual(calls[0].init.headers, {});
  });

  it('asks the Hub for a real path, not a percent-encoded one', async () => {
    const calls = [];
    await hfSkills.installSkill(entry(), {
      fetchImpl: fakeFetch({ 'hf-mem/SKILL.md': '---\nname: hf-mem\n---\nbody' }, calls),
      writeFile: fakeWriter([]),
    });
    assert.equal(calls[0].url, 'https://huggingface.co/huggingface/skills/raw/main/hf-mem/SKILL.md');
  });

  it('refuses a file that is absurdly large, and names the limit', async () => {
    const written = [];
    const huge = 'x'.repeat(hfSkills.LIMITS.fileBytes + 1);
    await assert.rejects(
      () => hfSkills.installSkill(entry(), {
        fetchImpl: fakeFetch({ 'hf-mem/SKILL.md': huge }),
        writeFile: fakeWriter(written),
      }),
      /past the \d+ KB limit for one skill file/,
    );
    assert.equal(written.length, 0, 'an oversized file is never written');
  });

  it('refuses without a writer, because nothing installs into no folder', async () => {
    await assert.rejects(
      () => hfSkills.installSkill(entry(), {}),
      /open a folder/,
    );
  });
});

describe('hf-skills install: a download that fails', () => {
  it('rejects with the file and the repo that failed', async () => {
    const written = [];
    await assert.rejects(
      () => hfSkills.installSkill(entry(), {
        fetchImpl: fakeFetch({}),
        writeFile: fakeWriter(written),
      }),
      (err) => {
        assert.match(err.message, /Could not download hf-mem\/SKILL\.md from huggingface\/skills/);
        return true;
      },
    );
    assert.equal(written.length, 0, 'a failed download writes nothing');
  });

  it('stops at the file that failed instead of half-writing the rest', async () => {
    const written = [];
    await assert.rejects(
      () => hfSkills.installSkill(entry({ files: ['references/table.md', 'extra.md'] }), {
        // SKILL.md is there; the reference is not.
        fetchImpl: fakeFetch({ 'hf-mem/SKILL.md': '---\nname: hf-mem\n---\nbody' }),
        writeFile: fakeWriter(written),
      }),
      /Could not download hf-mem\/references\/table\.md/,
    );
    assert.deepEqual(written.map(w => w.path), ['.neuraos/skills/hf-mem/SKILL.md']);
  });

  it('surfaces a thrown fetch (offline) as a failed download, not a crash', async () => {
    await assert.rejects(
      () => hfSkills.installSkill(entry(), {
        fetchImpl: async () => { throw new Error('network down'); },
        writeFile: fakeWriter([]),
      }),
      /Could not download/,
    );
  });
});

describe('hf-skills install: what the button says afterwards', () => {
  function memoryStore() {
    const box = {};
    return {
      getItem: (k) => (k in box ? box[k] : null),
      setItem: (k, v) => { box[k] = v; },
    };
  }

  it('goes Install -> Installed -> Update as the catalogue moves on', () => {
    const store = memoryStore();
    const skill = entry({ content: 'version one' });
    assert.equal(hfSkills.installStatus(skill, hfSkills.readInstalled(store)), 'install');

    hfSkills.rememberInstalled(skill, { dir: '.neuraos/skills/hf-mem' }, store);
    assert.equal(hfSkills.installStatus(skill, hfSkills.readInstalled(store)), 'installed');

    const moved = entry({ content: 'version two' });
    assert.equal(hfSkills.installStatus(moved, hfSkills.readInstalled(store)), 'update');
  });

  it('records where the files went, so the row can say it', () => {
    const store = memoryStore();
    const records = hfSkills.rememberInstalled(entry(), { dir: '.neuraos/skills/hf-mem' }, store);
    assert.equal(records['hf-mem'].dir, '.neuraos/skills/hf-mem');
    assert.equal(records['hf-mem'].repo, 'huggingface/skills');
    assert.ok(records['hf-mem'].at > 0);
  });

  it('survives a storage that refuses to answer', () => {
    const broken = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    assert.deepEqual(hfSkills.readInstalled(broken), {});
    // The badge is lost, the install is not: this must not throw.
    hfSkills.rememberInstalled(entry(), { dir: 'x' }, broken);
  });
});

describe('hf-skills: the catalogue carries a skill files list', () => {
  it('parseSkillMd keeps `files:` so an install knows what else to fetch', () => {
    const md = [
      '---',
      'name: hf-mem',
      'description: Estimate VRAM.',
      'files:',
      '  - references/table.md',
      '  - scripts/run.md',
      '---',
      'body',
    ].join('\n');
    const skill = hfSkills.parseSkillMd(md);
    assert.deepEqual(skill.files, ['references/table.md', 'scripts/run.md']);
  });

  it('a skill without `files:` installs as SKILL.md alone', () => {
    const skill = hfSkills.parseSkillMd('---\nname: x\ndescription: y\n---\nbody');
    assert.deepEqual(skill.files, []);
  });
});
