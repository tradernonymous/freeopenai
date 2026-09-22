// Multi-part (split) GGUFs: …-00001-of-00003.gguf and its siblings.
//
// llama.cpp loads a whole set when handed part 1 with the others beside it,
// so the app treats a set as ONE model: offered as one row the size of all
// its parts, downloaded part by part through the shell's single-file download
// (each part keeps its own .part and resume), saved as part 1, listed and
// scanned as one model, and deleted all together.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const local = require('../desktop/src/local-models.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const GB = 1024 * 1024 * 1024;

test('a part names its place in the set, and part 1 names every part', () => {
  assert.deepEqual(local.splitInfo('UD-Q4_K_XL/x-UD-Q4_K_XL-00002-of-00003.gguf'), {
    index: 2,
    count: 3,
    stem: 'UD-Q4_K_XL/x-UD-Q4_K_XL',
  });
  assert.equal(local.splitInfo('x-UD-Q4_K_XL.gguf'), null);
  assert.equal(local.splitInfo('x-00004-of-00003.gguf'), null, 'a part past the count is not a part');
  assert.equal(local.isSplit('x-00001-of-00002.gguf'), true);
  assert.equal(local.isSplit('x.gguf'), false);

  assert.deepEqual(local.splitParts('UD-Q4_K_XL/x-UD-Q4_K_XL-00001-of-00003.gguf'), [
    'UD-Q4_K_XL/x-UD-Q4_K_XL-00001-of-00003.gguf',
    'UD-Q4_K_XL/x-UD-Q4_K_XL-00002-of-00003.gguf',
    'UD-Q4_K_XL/x-UD-Q4_K_XL-00003-of-00003.gguf',
  ]);
  // Any part gives the same set, part 1 first.
  assert.deepEqual(local.splitParts('x-00002-of-00002.gguf'), ['x-00001-of-00002.gguf', 'x-00002-of-00002.gguf']);
  assert.deepEqual(local.splitParts('single-Q4_K_M.gguf'), ['single-Q4_K_M.gguf'], 'a single file is a set of one');

  assert.equal(local.modelName('C:\\models\\x-UD-Q4_K_XL-00001-of-00003.gguf'), 'x-UD-Q4_K_XL');
  assert.equal(local.modelName('dir/y-Q4_K_M.gguf'), 'y-Q4_K_M');
});

test('a repo listing folds each set into one row the size of all its parts', () => {
  const rows = local.groupHubFiles([
    { name: 'm-Q4_K_M.gguf', size: 4 * GB, quant: 'Q4_K_M' },
    { name: 'Q8_0/m-Q8_0-00002-of-00002.gguf', size: 3 * GB, quant: 'Q8_0' },
    { name: 'Q8_0/m-Q8_0-00001-of-00002.gguf', size: 5 * GB, quant: 'Q8_0' },
    { name: 'BF16/m-BF16-00001-of-00003.gguf', size: 5 * GB, quant: 'BF16' },
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].parts, ['m-Q4_K_M.gguf']);
  assert.equal(rows[0].complete, true);

  const q8 = rows[1];
  assert.equal(q8.name, 'Q8_0/m-Q8_0-00001-of-00002.gguf', 'the set is named by part 1');
  assert.equal(q8.size, 8 * GB, 'size is the total');
  assert.deepEqual(q8.partSizes, [5 * GB, 3 * GB]);
  assert.equal(q8.quant, 'Q8_0');
  assert.equal(q8.complete, true);

  assert.equal(rows[2].complete, false, 'a set missing a part is shown, never offered');
  assert.equal(rows[2].parts.length, 3);

  // Grouping twice is harmless (pickDefaultFile groups what the card grouped).
  assert.deepEqual(local.groupHubFiles(rows), rows);
});

test('the default file can be a whole split set, but never an incomplete one', () => {
  const roomy = { ramGb: 64, ramKnown: true, cores: 8 };
  const files = [
    { name: 'm-Q8_0.gguf', size: 30 * GB },
    { name: 'UD-Q4_K_XL/m-UD-Q4_K_XL-00001-of-00002.gguf', size: 10 * GB },
    { name: 'UD-Q4_K_XL/m-UD-Q4_K_XL-00002-of-00002.gguf', size: 8 * GB },
  ];
  const chosen = local.pickDefaultFile(files, roomy);
  assert.equal(chosen.name, 'UD-Q4_K_XL/m-UD-Q4_K_XL-00001-of-00002.gguf');
  assert.equal(chosen.size, 18 * GB);
  // The fit check sees the total: on a 16 GB machine 18 GB of weights cannot load.
  assert.equal(local.fit({ sizeGb: chosen.size / GB, context: 16384 }, { ramGb: 16, ramKnown: true, cores: 8 }).fits, false);
  assert.equal(local.pickDefaultFile(files.slice(0, 2), roomy), null, 'part 2 missing: nothing to recommend');
});

test('the models folder shows a set as one model, and a missing or partial part as incomplete', () => {
  const dir = 'C:\\Users\\me\\AppData\\models\\';
  const rows = local.groupLocalFiles([
    { file: 'a-Q4_K_M.gguf', path: dir + 'a-Q4_K_M.gguf', bytes: 4 * GB, partial: false },
    { file: 'b-Q4-00001-of-00002.gguf', path: dir + 'b-Q4-00001-of-00002.gguf', bytes: 10 * GB, partial: false },
    { file: 'b-Q4-00002-of-00002.gguf', path: dir + 'b-Q4-00002-of-00002.gguf.part', bytes: 2 * GB, partial: true },
    { file: 'c-00002-of-00002.gguf', path: dir + 'c-00002-of-00002.gguf', bytes: 1 * GB, partial: false },
    { file: 'c-00001-of-00002.gguf', path: dir + 'c-00001-of-00002.gguf', bytes: 9 * GB, partial: false },
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    file: 'a-Q4_K_M.gguf', path: dir + 'a-Q4_K_M.gguf', bytes: 4 * GB, partial: false,
    parts: ['a-Q4_K_M.gguf'], missing: [], complete: true,
  });
  assert.equal(rows[1].file, 'b-Q4-00001-of-00002.gguf');
  assert.equal(rows[1].path, dir + 'b-Q4-00001-of-00002.gguf', 'the set points at part 1, not a .part');
  assert.equal(rows[1].bytes, 12 * GB);
  assert.equal(rows[1].partial, true, 'a .part in the set makes it resumable, not runnable');
  assert.deepEqual(rows[1].missing, ['b-Q4-00002-of-00002.gguf']);
  assert.equal(rows[2].file, 'c-00001-of-00002.gguf');
  assert.equal(rows[2].path, dir + 'c-00001-of-00002.gguf');
  assert.equal(rows[2].bytes, 10 * GB);
  assert.equal(rows[2].complete, true);
  assert.equal(rows[2].partial, false);

  // The same names in two folders are two models.
  const two = local.groupLocalFiles([
    { file: 'd-00001-of-00001.gguf', path: '/one/d-00001-of-00001.gguf', bytes: 1, partial: false },
    { file: 'd-00001-of-00001.gguf', path: '/two/d-00001-of-00001.gguf', bytes: 1, partial: false },
  ]);
  assert.equal(two.length, 2);
});

test('progress through a set is the sum across parts, and done only on the last part', () => {
  const set = { file: 'x-00001-of-00003.gguf', index: 1, count: 3, before: 5 * GB, total: 15 * GB };
  const p = local.setProgress(set, { repo: 'u/x', file: 'x-00002-of-00003.gguf', received: 2 * GB, total: 5 * GB, done: false });
  assert.equal(p.file, 'x-00001-of-00003.gguf', 'the bar names the set');
  assert.equal(p.received, 7 * GB);
  assert.equal(p.total, 15 * GB);
  assert.equal(p.part, 2);
  assert.equal(p.parts, 3);
  assert.equal(local.downloadLabel(p), '7.0 of 15.0 GB \u00b7 46% \u00b7 part 2 of 3');

  assert.equal(local.setProgress(set, { received: 5 * GB, total: 5 * GB, done: true }).done, false, 'a middle part finishing is not the set finishing');
  assert.equal(local.setProgress({ ...set, index: 2, before: 10 * GB }, { received: 5 * GB, total: 5 * GB, done: true }).done, true);
  // No listing sizes: the part's own total stands in.
  assert.equal(local.setProgress({ ...set, total: 0 }, { received: 1 * GB, total: 5 * GB }).total, 10 * GB);
  assert.match(local.downloadLabel(local.setProgress(set, { received: 1 * GB, cancelled: true })), /^Paused at 6\.0 GB \u00b7 part 2 of 3$/);
  // A single file reads exactly as before.
  assert.equal(local.downloadLabel({ received: 1.2 * GB, total: 4.8 * GB }), '1.2 of 4.8 GB \u00b7 25%');
});

test('Settings downloads every part in turn, pauses the whole set, and deletes every part', () => {
  const card = read('desktop', 'src', 'components', 'LocalModelsCard.tsx');
  assert.match(card, /localModels\.groupHubFiles\(hfModels\.ggufFiles\(card\)/, 'the repo list folds sets into rows');
  assert.match(card, /const parts = localModels\.splitParts\(name\);/);
  assert.match(card, /for \(let i = 0; i < parts\.length; i\+\+\) \{/);
  assert.match(card, /await localModelDownload\(\{ repo, file, /, 'each part goes through the single-file download');
  assert.match(card, /if \(result\.cancelled\) \{/);
  assert.match(card, /pausedRef\.current = true;\n    localModelDownloadCancel\(\)/, 'pause stops the set, not just the part');
  assert.match(card, /localModels\.setProgress\(splitRef\.current, event\)/, 'the bar measures the whole set');
  assert.match(card, /path: firstPath,/, 'the saved model points at part 1');
  assert.match(card, /for \(const part of localModels\.splitParts\(file\)\) await localModelDelete\(part\);/);
  assert.match(card, /localModels\.groupLocalFiles\(downloaded\)/, 'the Downloaded list shows a set as one model');
  assert.match(card, /download\(hub\.repo, f\.name, f\.partSizes\)/);
  assert.match(card, /disabled=\{downloading \|\| !f\.complete\}/, 'a set is offered unless the repo is missing a part');
  assert.doesNotMatch(card, /not supported yet/);

  const mine = read('desktop', 'src', 'components', 'MyModels.tsx');
  assert.match(mine, /localModels\.groupLocalFiles\(result\.files\.filter\(under\)\)/, 'a scan shows a set as one model');
  assert.match(mine, /disabled=\{have \|\| !row\.complete\}/);

  // The last part of a set can be under the scan's 64 MB floor.
  const shell = read('desktop', 'src-tauri', 'src', 'models.rs');
  assert.match(shell, /fn is_split_part\(name: &str\) -> bool/);
  assert.match(shell, /f\.bytes >= SCAN_MIN_BYTES \|\| is_split_part\(&f\.file\)/);

  const types = read('desktop', 'src', 'local-models.d.ts');
  for (const name of ['splitInfo', 'splitParts', 'modelName', 'groupHubFiles', 'groupLocalFiles', 'setProgress']) {
    assert.match(types, new RegExp(`export declare function ${name}`), `${name} is typed`);
  }
});
