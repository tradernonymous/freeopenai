// Pictures in Chat: /image, /edit, /redo, the picture actions, @picture, the
// palette rows, and the hand-off to the Images screen.
//
// The rules this file holds:
//   * Chat and Images reach a service through ONE runner (image-run.js), so a
//     fix to how a picture is sent cannot land in one screen and not the other;
//   * building a request sends nothing -- /edit with no picture is a note, and a
//     refused plan never touches the network;
//   * /edit changes the picture attached to THIS message before an older one;
//   * a picture handed to Images is taken once and never kept in storage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const composer = require('../desktop/src/composer.js');
const commands = require('../desktop/src/commands.js');
const images = require('../desktop/src/images.js');
const imageRun = require('../desktop/src/image-run.js');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const chat = () => read('desktop', 'src', 'screens', 'ChatScreen.tsx');
const imagesScreen = () => read('desktop', 'src', 'screens', 'ImagesScreen.tsx');
const runnerSrc = () => read('desktop', 'src', 'image-run.js');

const PNG_A = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_B = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_C = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const serverRow = (over) => Object.assign({
  id: 'openrouter', label: 'OpenRouter', kind: 'server', ready: true,
  model: 'google/gemini-2.5-flash-image', models: ['google/gemini-2.5-flash-image', 'other/model'],
  reason: '', note: '', edits: 'reference',
}, over || {});
const puterRow = () => images.providerChoices({}).find((r) => r.kind === 'browser');
const localRow = () => images.localRow({ found: true, binary: 'C:/sd/sd-server.exe', model: 'C:/sd/models/sd15.gguf' });

/** A fake of everything the runner may reach, recording each call. */
function fakes(over) {
  const calls = [];
  const log = (name) => (...args) => { calls.push([name, ...args]); return undefined; };
  const deps = Object.assign({
    api: {
      imageGenerate: (body) => { calls.push(['imageGenerate', body]); return Promise.resolve({ data: [{ url: 'https://img.example/drawn.png' }], provider: 'openrouter', providerLabel: 'OpenRouter', model: body.model }); },
      imageEdit: (body) => { calls.push(['imageEdit', body]); return Promise.resolve({ data: [{ b64_json: 'AAAA' }], providerLabel: 'OpenRouter', model: body.model, notes: ['kept the shape'] }); },
    },
    imageUrlFrom: (data) => {
      const first = data && data.data && data.data[0];
      if (!first) return null;
      return first.url || (first.b64_json ? 'data:image/png;base64,' + first.b64_json : null);
    },
    puter: {
      isSignedIn: () => true,
      draw: (prompt, options) => { calls.push(['puter.draw', prompt, options]); return Promise.resolve(PNG_C); },
    },
    call: (command, args) => {
      calls.push(['call', command, args]);
      if (command === 'sd_status') return Promise.resolve({ state: 'ready' });
      if (command === 'sd_generate') return Promise.resolve({ id: 'job-1' });
      if (command === 'sd_job') return Promise.resolve({ status: 'completed', result: { images: [{ b64_json: 'QUJD' }] } });
      return Promise.resolve(null);
    },
    wait: () => Promise.resolve(),
    onJob: log('onJob'),
  }, over || {});
  return { deps, calls };
}

// ---- the commands ---------------------------------------------------------

test('/image, /edit and /redo are in the /research registry, with hints in its voice', () => {
  for (const id of ['image', 'edit', 'redo']) {
    const row = composer.SLASH.find((c) => c.id === id);
    assert.ok(row, `/${id} is registered`);
    assert.ok(row.hint && row.hint.length > 12, `/${id} has a hint`);
    assert.equal(row.hint.charAt(0), row.hint.charAt(0).toUpperCase(), 'sentence case');
    assert.notEqual(row.hint, row.hint.toUpperCase(), 'no shouting');
  }
  // The same shape as /research: what it does, then an example after a dash.
  assert.match(composer.SLASH.find((c) => c.id === 'image').hint, / — \/image \S/);
  assert.match(composer.SLASH.find((c) => c.id === 'edit').hint, / — \/edit \S/);
  assert.match(composer.SLASH.find((c) => c.id === 'redo').hint, /new seed/);
  // Typed with words, each parses to itself.
  assert.equal(composer.parseSlash('/image a lighthouse at dusk').command.id, 'image');
  assert.equal(composer.parseSlash('/image a lighthouse at dusk').arg, 'a lighthouse at dusk');
  assert.equal(composer.parseSlash('/edit make the sky clear').command.id, 'edit');
  assert.equal(composer.parseSlash('/redo').command.id, 'redo');
  // /attach keeps `image` as a menu alias, but the command row wins the name.
  assert.equal(composer.slashMenu('/image')[0].id, 'image');
  assert.equal(composer.slashMenu('/ima')[0].id, 'image');
  // And the chat runs each one.
  const source = chat();
  assert.match(source, /case 'image': \{/);
  assert.match(source, /case 'edit': \{/);
  assert.match(source, /case 'redo': clear\(\); redoPicture\(\); return;/);
});

test('/edit changes the picture on THIS message before an older one', () => {
  const messages = [
    { role: 'user', content: 'look', images: [PNG_A] },
    { role: 'assistant', content: 'Drew: a boat', images: [PNG_B], picture: { kind: 'generate', prompt: 'a boat' } },
  ];
  // Attached to the message being written: that one, even with newer ones in the thread.
  const here = composer.pictureTarget({ attached: [PNG_C], messages });
  assert.equal(here.url, PNG_C);
  assert.equal(here.from, 'attached');
  assert.match(composer.targetLabel(here), /attached to this message/);
  // Nothing attached: the newest picture in the thread, a drawn reply included.
  const latest = composer.pictureTarget({ attached: [], messages });
  assert.equal(latest.url, PNG_B);
  assert.equal(latest.from, 'latest');
  assert.deepEqual([latest.index, latest.slot], [1, 0]);
  assert.match(composer.targetLabel(latest), /latest picture drawn/);
  // A picture's Edit button beats "latest" -- but only while it is still there.
  const picked = composer.pictureTarget({ attached: [], pinned: { url: PNG_A, index: 0, slot: 0 }, messages });
  assert.equal(picked.url, PNG_A);
  assert.equal(picked.from, 'picked');
  const stale = composer.pictureTarget({ attached: [], pinned: { url: PNG_C, index: 0, slot: 0 }, messages });
  assert.equal(stale.url, PNG_B, 'a pick that is no longer in the thread is not edited from a stale copy');
  // Attached still beats a pick.
  assert.equal(composer.pictureTarget({ attached: [PNG_C], pinned: { url: PNG_A, index: 0, slot: 0 }, messages }).url, PNG_C);
  // The chat asks exactly this, with the composer's staged pictures as "attached".
  assert.match(chat(), /grammar\.pictureTarget\(\{ attached: images, pinned: pinnedPicture, messages: active\.messages \}\)/);
});

test('/edit with no picture anywhere sends nothing and says how to attach one', async () => {
  assert.equal(composer.pictureTarget({ attached: [], messages: [{ role: 'user', content: 'hi' }] }), null);
  assert.equal(composer.latestPicture([]), null);
  const source = chat();
  const edit = source.slice(source.indexOf("case 'edit': {"), source.indexOf("case 'redo':"));
  const refuse = edit.indexOf('if (!target)');
  assert.ok(refuse > 0, 'the missing picture is checked');
  assert.ok(refuse < edit.indexOf('runPicture('), 'before anything could run');
  assert.match(edit.slice(refuse, edit.indexOf('runPicture(')), /pictureNote\([^)]*attach[\s\S]*?return;/i);

  // And the plan it would have made refuses on its own: the runner is never
  // reached with a request, so nothing leaves the machine.
  const plan = images.editRequest(serverRow(), { prompt: 'make it blue', source: '' });
  assert.ok(plan.error);
  const { deps, calls } = fakes();
  await assert.rejects(imageRun.runImage('edit', serverRow(), plan, deps));
  assert.deepEqual(calls, [], 'a refused plan calls nothing');
  // A refused plan in chat is a note, and the thread gets no turn.
  assert.match(source, /if \(!plan\.route \|\| !choice\) \{\s*\n\s*pictureNote\(`\*\*Nothing was sent\.\*\*/);
});

// ---- one dispatch ----------------------------------------------------------

test('the dispatch is shared: Images and Chat call the same runner, and neither sends on its own', () => {
  for (const [name, source] of [['ImagesScreen', imagesScreen()], ['ChatScreen', chat()]]) {
    assert.match(source, /imageRun\.runImage\(kind, choice, plan, /, `${name} carries a plan out through image-run.js`);
    assert.ok(!/api\.imageGenerate\(|api\.imageEdit\(/.test(source), `${name} does not call the images route itself`);
    assert.ok(!/'sd_generate'/.test(source), `${name} does not submit a local job itself`);
    assert.ok(!/puter\.draw\(/.test(source), `${name} does not draw on Puter itself`);
    assert.match(source, /import '\.\.\/image-run\.js';/);
  }
  // Both plan a draw the same way, and an edit through the pure images.editRequest.
  assert.match(imagesScreen(), /imageRun\.drawPlan\(choice, \{ prompt: text, size, model \}\)/);
  assert.match(chat(), /imageRun\.drawPlan\(choice, \{ prompt: words, size, model \}\)/);
  assert.match(imagesScreen(), /images\.editRequest\(choice, \{/);
  assert.match(chat(), /imagesLib\.editRequest\(choice, \{/);
  // One failure vocabulary for both.
  assert.match(imagesScreen(), /imageRun\.failureView\(kind, plan\.route, choice, err\)/);
  assert.match(chat(), /imageRun\.failureView\(kind, plan\.route, choice, err\)/);
});

test('the runner sends each route the way the Images screen always has', async () => {
  // Engine, draw: the service is named and the model rides along.
  let run = fakes();
  const draw = imageRun.drawPlan(serverRow(), { prompt: 'a lighthouse', size: 'square', model: 'other/model' });
  assert.equal(draw.route, 'server');
  const drawn = await imageRun.runImage('generate', serverRow(), draw, run.deps);
  assert.equal(run.calls[0][0], 'imageGenerate');
  assert.equal(run.calls[0][1].provider, 'openrouter');
  assert.equal(run.calls[0][1].model, 'other/model');
  assert.equal(drawn.url, 'https://img.example/drawn.png');
  assert.match(drawn.who, /OpenRouter/);

  // Engine, edit: the edits route, never the generations one.
  run = fakes();
  const edit = images.editRequest(serverRow(), { prompt: 'make it blue', source: PNG_A, size: 'square' });
  const changed = await imageRun.runImage('edit', serverRow(), edit, run.deps);
  assert.deepEqual(run.calls.map((c) => c[0]), ['imageEdit']);
  assert.equal(run.calls[0][1].image, PNG_A);
  assert.match(changed.url, /^data:image\/png;base64,/);
  assert.deepEqual(changed.notes, ['kept the shape']);

  // Puter: only when signed in, and never a request otherwise.
  run = fakes({ puter: { isSignedIn: () => false, draw: () => { throw new Error('must not draw'); } } });
  await assert.rejects(imageRun.runImage('generate', puterRow(), imageRun.drawPlan(puterRow(), { prompt: 'x', size: 'square' }), run.deps), /Sign in to Puter/);
  run = fakes();
  const byPuter = await imageRun.runImage('generate', puterRow(), imageRun.drawPlan(puterRow(), { prompt: 'x', size: 'square' }), run.deps);
  assert.equal(run.calls[0][0], 'puter.draw');
  assert.equal(run.calls[0][2].model, images.PUTER_GENERATE_MODELS[0]);
  assert.equal(byPuter.url, PNG_C);

  // This PC: submit, poll, bytes -- and a new seed on /redo.
  run = fakes();
  const local = imageRun.withSeed(imageRun.drawPlan(localRow(), { prompt: 'a cat', size: 'square' }), 1234);
  assert.equal(local.body.seed, 1234);
  const here = await imageRun.runImage('generate', localRow(), local, run.deps);
  const sent = run.calls.filter((c) => c[0] === 'call').map((c) => c[1]);
  assert.deepEqual(sent.slice(0, 3), ['sd_status', 'sd_generate', 'sd_job']);
  assert.equal(run.calls.find((c) => c[1] === 'sd_generate')[2].seed, 1234);
  assert.match(here.url, /^data:image\/png;base64,/);
  assert.match(here.who, /^This PC/);
  // The engine and Puter take no seed: asking again is the new seed, said as a note.
  const again = imageRun.withSeed(draw, 99);
  assert.equal(again.body.seed, undefined);
  assert.match(again.notes.join(' '), /new seed/);

  // A stopped local job resolves to nothing rather than a picture.
  run = fakes({ stopped: () => true });
  assert.equal(await imageRun.runImage('generate', localRow(), local, run.deps), null);
});

test('a draw plan refuses a service that is not ready, and sends nothing', () => {
  assert.match(imageRun.drawPlan(serverRow({ ready: false, reason: 'Set OPENROUTER_API_KEY.' }), { prompt: 'x' }).error, /not ready: Set OPENROUTER_API_KEY/);
  assert.match(imageRun.drawPlan(null, { prompt: 'x' }).error, /Open Images/);
  assert.match(imageRun.drawPlan(serverRow(), { prompt: '  ' }).error, /Say what to draw/);
});

// ---- the Images screen's choice ---------------------------------------------

test('/image draws with the choice the Images screen keeps, under one key', () => {
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  assert.deepEqual(imageRun.readChoice(storage), { choiceId: '', size: '', model: '', editModel: '' });
  imageRun.writeChoice({ choiceId: 'openrouter', model: 'other/model' }, storage);
  imageRun.writeChoice({ size: 'square' }, storage);
  assert.deepEqual([...store.keys()], [imageRun.CHOICE_KEY], 'one key');
  const kept = imageRun.readChoice(storage);
  assert.equal(kept.size, 'square');
  // The kept model wins for its own service, and means nothing for another.
  assert.equal(imageRun.modelFor(serverRow(), 'generate', kept), 'other/model');
  assert.equal(imageRun.modelFor(serverRow({ id: 'together' }), 'generate', kept), 'google/gemini-2.5-flash-image');
  // A broken value is a blank choice, not a crash.
  store.set(imageRun.CHOICE_KEY, '{nope');
  assert.equal(imageRun.readChoice(storage).choiceId, '');

  // Images writes it when the person picks; Chat only reads it.
  const screen = imagesScreen();
  assert.match(screen, /imageRun\.readChoice\(\)/);
  assert.match(screen, /imageRun\.writeChoice\(\{ choiceId: id/);
  assert.match(screen, /imageRun\.writeChoice\(\{ size: id \}\)/);
  assert.match(chat(), /const kept = imageRun\.readChoice\(\);/);
  assert.ok(!/writeChoice/.test(chat()), 'Chat does not keep a second set of settings');
  assert.ok(!/freeai4u\.images/.test(chat() + screen), 'the key is named once, in image-run.js');
});

// ---- the hand-off -----------------------------------------------------------

test('Open in Images hands the picture over once, and never through storage', () => {
  const heard = [];
  assert.equal(imageRun.handOff(PNG_A, (event) => heard.push(event)), true);
  assert.deepEqual(heard, [imageRun.HANDOFF_EVENT]);
  assert.equal(imageRun.takeHandoff(), PNG_A);
  assert.equal(imageRun.takeHandoff(), null, 'consumed exactly once');
  // The slot is memory: the runner never writes a picture to storage.
  const runner = runnerSrc();
  assert.ok(!/sessionStorage/.test(runner));
  assert.equal((runner.match(/setItem\(/g) || []).length, 1, 'the only write is the kept choice');
  assert.match(runner, /store\.setItem\(CHOICE_KEY,/);

  // Chat asks the shell to move with the app's own navigation event.
  const source = chat();
  const open = source.slice(source.indexOf('const openInImages'), source.indexOf('const editPicture'));
  assert.match(open, /imageRun\.handOff\(url,/);
  assert.match(open, /new CustomEvent\(NAVIGATE_EVENT, \{ detail: \{ view: 'images' \} \}\)/);
  // Images takes it on arrival, and when it is already open and hears the event.
  const screen = imagesScreen();
  assert.match(screen, /const url = imageRun\.takeHandoff\(\);/);
  assert.match(screen, /window\.addEventListener\(imageRun\.HANDOFF_EVENT, arrive\)/);
  assert.match(screen, /window\.removeEventListener\(imageRun\.HANDOFF_EVENT, arrive\)/);
  // It arrives as the source of a change.
  assert.match(screen, /setSource\(picked\); setMask\(null\); setMode\('edit'\)/);
});

// ---- the picture actions, @picture, persistence --------------------------------

test('every picture in the chat has Edit, Open in Images and Save, with the one Save', () => {
  const source = chat();
  const start = source.indexOf('className="message-images"');
  const end = source.indexOf('msg.tools && msg.tools.length > 0', start);
  assert.ok(start > 0 && end > start, 'the thread renders its pictures');
  const block = source.slice(start, end);
  assert.match(block, />Edit<\/button>/);
  assert.match(block, />Open in Images<\/button>/);
  assert.match(block, />Save<\/button>/);
  assert.match(block, /onClick=\{\(\) => editPicture\(url, i, j\)\}/);
  assert.match(block, /onClick=\{\(\) => openInImages\(url\)\}/);
  assert.match(block, /onClick=\{\(\) => imageRun\.savePicture\(url\)\}/);
  // Shown on hover AND on keyboard focus.
  assert.match(block, /onMouseEnter=/);
  assert.match(block, /onFocus=/);
  // Edit fills the composer with /edit and aims it at that picture.
  const edit = source.slice(source.indexOf('const editPicture'), source.indexOf('const send = async'));
  assert.match(edit, /setPinnedPicture\(\{ url, index, slot \}\)/);
  assert.match(edit, /draft: '\/edit '/);
  // The Images screen's Save is the same function, not a second one.
  assert.match(imagesScreen(), /const save = \(url: string\) => imageRun\.savePicture\(url\);/);
  let clicked = 0;
  const anchor = { click: () => { clicked += 1; }, remove: () => {} };
  const doc = { createElement: () => anchor, body: { appendChild: () => {} } };
  assert.equal(imageRun.savePicture(PNG_A, doc), true);
  assert.equal(anchor.href, PNG_A);
  assert.match(anchor.download, /^freeai4u-\d+\.png$/);
  assert.equal(clicked, 1);
});

test('@picture offers the latest picture the way @ offers a file', () => {
  const sources = [
    { kind: 'file', id: 'notes.md', label: 'notes.md' },
    { kind: 'picture', id: 'picture', label: 'picture', hint: 'attach the latest picture in this chat' },
  ];
  assert.equal(composer.mentionMenu('pic', sources)[0].kind, 'picture');
  assert.equal(composer.stripPictureMention('@picture make it blue'), 'make it blue');
  assert.equal(composer.stripPictureMention('make @picture blue'), 'make blue');
  assert.equal(composer.stripPictureMention('see @pictures'), 'see @pictures');
  const source = chat();
  assert.match(source, /kind: 'picture' as const, id: 'picture'/);
  // Picked, it attaches the picture to this message -- which /edit reads first.
  assert.match(source, /if \(source\.kind === 'picture'\) \{[\s\S]{0,200}addImage\(latestPicture\.url\)/);
});

test('a drawn picture is saved with the chat, trimmed like any other in browser storage', () => {
  const source = chat();
  const run = source.slice(source.indexOf('const runPicture'), source.indexOf('const redoPicture'));
  // It is the reply's `images`, the field saveSessions already persists and trims.
  assert.match(run, /images: \[done\.url\]/);
  assert.match(run, /saveSessions\(next\)/);
  assert.match(source, /const KEEP_IMAGES_LAST = 6;/);
  // The recipe points at its source rather than carrying a second copy of it.
  assert.match(run, /sourceAt = pictureAt\(history, sourceUrl\)/);
  assert.ok(!/source: sourceUrl,\s*\n\s*choice/.test(run));
  // /redo repeats the newest recipe.
  const messages = [
    { role: 'assistant', content: 'Drew: a', images: [PNG_A], picture: { kind: 'generate', prompt: 'a', choice: 'openrouter', model: 'm', size: 'square' } },
    { role: 'assistant', content: 'Changed', images: [PNG_B], picture: { kind: 'edit', prompt: 'b', choice: 'openrouter', model: 'm', size: 'square', sourceAt: [0, 0] } },
  ];
  assert.equal(composer.lastPictureRun(messages).picture.prompt, 'b');
  assert.equal(composer.lastPictureRun([]), null);
});

test('a paid route says so before its first picture', () => {
  assert.equal(imageRun.costNote(localRow()), '', 'this PC costs no account');
  assert.match(imageRun.costNote(puterRow()), /Puter account/);
  assert.match(imageRun.costNote(serverRow()), /billed/);
  const run = chat().slice(chat().indexOf('const runPicture'), chat().indexOf('const redoPicture'));
  assert.match(run, /const sayCost = !!cost && !costSaid\.has\(choice\.id\);/);
  // The note goes in ahead of the turn it is about.
  assert.match(run, /messages: \[\.\.\.history, \.\.\.lead, userMsg, reply\]/);
});

// ---- the palette ------------------------------------------------------------------

test('the palette has "Generate a picture" and "Edit the last picture", beside Images', () => {
  const ids = commands.COMMANDS.map((c) => c.id);
  const at = ids.indexOf('go-images');
  assert.deepEqual(ids.slice(at + 1, at + 3), ['image-generate', 'image-edit'], 'grouped with the Images entry');
  const generate = commands.COMMANDS[at + 1];
  const edit = commands.COMMANDS[at + 2];
  assert.equal(generate.title, 'Generate a picture');
  assert.equal(edit.title, 'Edit the last picture');
  assert.equal(generate.group, 'Images');
  assert.equal(edit.group, 'Images');
  assert.equal(generate.command, '/image');
  assert.equal(edit.command, '/edit');
  assert.equal(generate.palette, 'chat');
  // Their own words find them; a loose query still finds the screen first.
  assert.equal(commands.search('generate a picture')[0].id, 'image-generate');
  assert.equal(commands.search('edit the last')[0].id, 'image-edit');
  assert.equal(commands.search('gen pic')[0].id, 'go-images');
  assert.ok(commands.search('imag').some((c) => c.id === 'image-generate'), 'still listed under a loose query');
});

test('no bare TODO in what this change touched', () => {
  for (const file of [chat(), imagesScreen(), runnerSrc(), read('desktop', 'src', 'composer.js'), read('desktop', 'src', 'commands.js')]) {
    assert.ok(!/\bTODO\b(?!\(NEURA-\d+\))/.test(file));
  }
});
