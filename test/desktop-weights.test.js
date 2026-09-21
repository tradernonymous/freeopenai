// Phase 0 of the desktop roadmap: the weights are the app's business.
//
// Before this, a model could only be started by `-hf`, which hands the
// download to llama.cpp -- no progress, no resume, no idea what is on disk.
// Now the app parses what a person pastes from Hugging Face, offers the right
// quant, downloads it with progress into its own folder (resuming a .part),
// runs it with -m, and finds GGUFs other tools already put on this machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const local = require('../desktop/src/local-models.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const GB = 1024 * 1024 * 1024;

test('the catalogue is Unsloth Dynamic quants that keep tool calling, one file each', () => {
  for (const entry of local.CATALOGUE) {
    assert.match(entry.id, /^unsloth\//, `${entry.id} is an Unsloth repo`);
    assert.match(entry.file, /\.gguf$/, `${entry.id} names its file`);
    assert.equal(local.parseQuant(entry.file), entry.quant, `${entry.file} carries the quant it claims`);
    assert.equal(local.toolRisk(entry.quant), '', `${entry.quant} must not weaken tool calling`);
    assert.ok(!local.isSplit(entry.file), 'one file, not a multi-part set');
  }
  const sizes = local.CATALOGUE.map((e) => e.sizeGb);
  assert.deepEqual(sizes, sizes.slice().sort((a, b) => a - b), 'smallest first, so a 4 GB machine sees a fit at the top');
});

test('anything a person pastes from Hugging Face becomes a repo, a file and a quant', () => {
  const repo = 'unsloth/gemma-4-E4B-it-GGUF';
  assert.deepEqual(local.parseHfRef(repo), { repo, file: '', quant: '' });
  assert.deepEqual(local.parseHfRef(`  https://huggingface.co/${repo}  `), { repo, file: '', quant: '' });
  assert.deepEqual(local.parseHfRef(`https://huggingface.co/${repo}/tree/main`), { repo, file: '', quant: '' });
  assert.deepEqual(
    local.parseHfRef(`https://huggingface.co/${repo}/blob/main/gemma-4-E4B-it-UD-Q4_K_XL.gguf`),
    { repo, file: 'gemma-4-E4B-it-UD-Q4_K_XL.gguf', quant: 'UD-Q4_K_XL' },
  );
  assert.deepEqual(
    local.parseHfRef('https://huggingface.co/unsloth/x-GGUF/resolve/main/UD-Q4_K_XL/x-UD-Q4_K_XL-00001-of-00002.gguf?download=true'),
    { repo: 'unsloth/x-GGUF', file: 'UD-Q4_K_XL/x-UD-Q4_K_XL-00001-of-00002.gguf', quant: 'UD-Q4_K_XL' },
  );
  assert.deepEqual(local.parseHfRef('hf.co/unsloth/Qwen3.8-27B-GGUF'), { repo: 'unsloth/Qwen3.8-27B-GGUF', file: '', quant: '' });
  assert.deepEqual(local.parseHfRef('unsloth/Qwen3.8-27B-GGUF:ud-q2_k_xl'), { repo: 'unsloth/Qwen3.8-27B-GGUF', file: '', quant: 'UD-Q2_K_XL' });
  assert.deepEqual(
    local.parseHfRef('neuraos://model?repo=unsloth/x-GGUF&file=x-Q4_K_M.gguf'),
    { repo: 'unsloth/x-GGUF', file: 'x-Q4_K_M.gguf', quant: 'Q4_K_M' },
  );
  for (const bad of ['', 'gemma', 'https://example.com/a/b', '../x/y', 'a/b/c', 'neuraos://model?nope=1']) {
    assert.equal(local.parseHfRef(bad), null, `${JSON.stringify(bad)} is not a model`);
  }
});

test('quant tags, split files and the tool-calling floor are read from the file name', () => {
  assert.equal(local.parseQuant('gemma-4-E4B-it-UD-Q4_K_XL.gguf'), 'UD-Q4_K_XL');
  assert.equal(local.parseQuant('model-Q4_K_M.gguf'), 'Q4_K_M');
  assert.equal(local.parseQuant('model-UD-IQ1_S.gguf'), 'UD-IQ1_S');
  assert.equal(local.parseQuant('model-BF16.gguf'), 'BF16');
  assert.equal(local.parseQuant('model.gguf'), '');
  assert.equal(local.isSplit('x-UD-Q4_K_XL-00001-of-00002.gguf'), true);
  assert.equal(local.isSplit('x-UD-Q4_K_XL.gguf'), false);
  // Unsloth's guide: 1-bit breaks tool calling, 2-bit is the floor.
  assert.match(local.toolRisk('UD-IQ1_M'), /breaks/);
  assert.match(local.toolRisk('IQ1_S'), /breaks/);
  assert.match(local.toolRisk('UD-Q2_K_XL'), /weaker/);
  assert.equal(local.toolRisk('UD-Q4_K_XL'), '');
  assert.equal(local.toolRisk('Q8_0'), '');
});

test('the default file skips split parts and 1-bit quants, and prefers what fits', () => {
  const files = [
    { name: 'm-UD-IQ1_S.gguf', size: 1 * GB },
    { name: 'm-UD-Q2_K_XL.gguf', size: 2 * GB },
    { name: 'm-UD-Q4_K_XL.gguf', size: 4 * GB },
    { name: 'm-Q4_K_M.gguf', size: 3.9 * GB },
    { name: 'm-Q8_0.gguf', size: 8 * GB },
    { name: 'UD-Q4_K_XL/m-UD-Q4_K_XL-00001-of-00002.gguf', size: 40 * GB },
  ];
  const roomy = { ramGb: 32, ramKnown: true, cores: 8 };
  const chosen = local.pickDefaultFile(files, roomy);
  assert.equal(chosen.name, 'm-UD-Q4_K_XL.gguf', "Unsloth's default wins when it fits");
  // The user's order: UD-Q4_K_XL, Q4_K_M, Q5/Q6, other Q4/Q3, 2-bit; Q8 and
  // full precision are never auto-picked, and a missing tag never is either.
  const ranks = ['UD-Q4_K_XL', 'Q4_K_M', 'Q5_K_M', 'UD-Q6_K_XL', 'IQ4_XS', 'UD-Q2_K_XL'].map(local.quantRank);
  assert.deepEqual(ranks, ranks.slice().sort((a, b) => a - b));
  assert.ok(local.quantRank('UD-Q4_K_XL') < local.quantRank('Q4_K_M'));
  assert.ok(local.quantRank('Q4_K_M') < local.quantRank('Q5_K_M'));
  for (const never of ['Q8_0', 'BF16', 'F16', 'F32', '']) assert.equal(local.quantRank(never), Infinity, `${never} is by hand only`);
  const noSmall = local.pickDefaultFile([{ name: 'm-Q8_0.gguf', size: 8 * GB }, { name: 'm-BF16.gguf', size: 16 * GB }], roomy);
  assert.equal(noSmall, null, 'a repo with only full-precision files gets no recommendation');
  // On an 8 GB machine only the 2-bit file passes the guard (weights + a 16k
  // cache + headroom against 80% of memory), so the ranking yields to the fit.
  const tight = local.pickDefaultFile(files, { ramGb: 8, ramKnown: true, cores: 4 });
  assert.equal(tight.name, 'm-UD-Q2_K_XL.gguf');
  // When nothing fits at all, the best-ranked file is still offered (the row
  // says why it cannot start); a person can then pick by hand.
  assert.equal(local.pickDefaultFile(files, { ramGb: 4, ramKnown: true, cores: 4 }).name, 'm-UD-Q4_K_XL.gguf');
  assert.equal(local.pickDefaultFile([{ name: 'README.md', size: 1 }], roomy), null);
});

test('a download is described in gigabytes and percent, and a pause or a stop says so', () => {
  assert.equal(local.downloadLabel({ received: 1.2 * GB, total: 4.8 * GB }), '1.2 of 4.8 GB \u00b7 25%');
  assert.equal(local.downloadLabel({ received: 0.5 * GB, total: 0 }), '0.50 GB so far');
  assert.equal(local.downloadLabel({ received: 4.8 * GB, total: 4.8 * GB, done: true }), '4.8 GB, done');
  assert.match(local.downloadLabel({ received: 1 * GB, cancelled: true }), /Paused at 1.0 GB/);
  assert.match(local.downloadLabel({ error: 'disk full' }), /Stopped: disk full/);
});

test('a running model carries the key the shell started it with, and a file name is a name', () => {
  const row = local.providerRow({ state: 'ready', repo: '', file: 'C:\\m\\gemma-4-E4B-it-UD-Q4_K_XL.gguf', base_url: 'http://127.0.0.1:8080', api_key: 'k3y' });
  assert.equal(row.apiKey, 'k3y');
  assert.equal(row.label, 'Local \u00b7 gemma-4-E4B-it-UD-Q4_K_XL');
  assert.equal(row.model, 'gemma-4-E4B-it-UD-Q4_K_XL');
  assert.match(local.statusLine({ state: 'ready', file: '/x/y.gguf', base_url: 'http://127.0.0.1:8080', uptime_ms: 1000 }), /^y ready/);
  // And the chat sends it.
  const api = read('desktop', 'src', 'api.ts');
  assert.match(api, /apiKey\?: string/);
  assert.match(api, /headers\.Authorization = `Bearer \$\{apiKey\}`/);
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.equal((chat.match(/localRow\?\.apiKey \|\| undefined/g) || []).length, 2, 'both local turns carry the key');
});

test('the shell starts the server for tool calling, keys its port, and owns the weights', () => {
  const shell = read('desktop', 'src-tauri', 'src', 'models.rs');
  assert.match(shell, /"--jinja"\.to_string\(\)/, 'without --jinja the tools field is ignored');
  assert.match(shell, /"--api-key"\.to_string\(\)/);
  assert.match(shell, /pub fn hub_file_url\(repo: &str, file: &str\)/);
  assert.match(shell, /format!\("\{\}\.part", name\)/, 'a download lands in a .part first');
  assert.match(shell, /std::fs::rename\(part, dest\)/, 'and is renamed only when whole');
  assert.match(shell, /Some\(have\), token/, 'a partial file is resumed with a Range');
  assert.match(shell, /app\.emit\("local-download"/);
  assert.match(shell, /fn known_model_dirs\(\)/);
  assert.match(shell, /"huggingface"\)\.join\("hub"\)/);
  const main = read('desktop', 'src-tauri', 'src', 'main.rs');
  for (const command of [
    'models::local_model_download',
    'models::local_model_download_cancel',
    'models::local_models_list',
    'models::local_model_delete',
    'models::local_models_scan',
    'net::open_url',
    'secrets::secret_get',
    'secrets::secret_set',
    'secrets::secret_delete',
  ]) {
    assert.ok(main.includes(command), `${command} must be in the invoke handler`);
  }
  // A token rides only to the Hub, never to the CDN a download redirects to.
  const net = read('desktop', 'src-tauri', 'src', 'net.rs');
  assert.match(net, /pub fn may_carry_token\(url: &str\)/);
  assert.match(net, /may_carry_token\(&current\)/);
  // neuraos:// is registered and handed to the frontend.
  const conf = JSON.parse(read('desktop', 'src-tauri', 'tauri.conf.json'));
  assert.deepEqual(conf.plugins['deep-link'].desktop.schemes, ['neuraos']);
  assert.match(main, /handle\.emit\("deep-link", urls\)/);
  const cargo = read('desktop', 'src-tauri', 'Cargo.toml');
  assert.match(cargo, /tauri-plugin-deep-link/);
  assert.match(cargo, /features = \["deep-link"\]/, 'single-instance forwards the argv link');
  assert.match(cargo, /^keyring = /m);
});

test('Settings lets a person paste a model, download it, resume it, and run what is already here', () => {
  const card = read('desktop', 'src', 'components', 'LocalModelsCard.tsx');
  assert.match(card, /localModels\.parseHfRef\(/);
  assert.match(card, /hfModels\.getModel\(ref\.repo/);
  assert.match(card, /localModels\.pickDefaultFile\(hub\.files, facts\)/);
  assert.match(card, /localModelDownload\(\{ repo, file/);
  assert.match(card, /localModelDownloadCancel\(\)/);
  assert.match(card, /onLocalDownload\(/);
  // Finding what is already on the PC moved to My models (the Unsloth toggle).
  const mine = read('desktop', 'src', 'components', 'MyModels.tsx');
  assert.match(mine, /localModelsScan\(/);
  assert.match(mine, /pickFolder\(\)/);
  assert.match(card, /<MyModels \/>/);
  assert.match(card, /PENDING_MODEL_KEY/);
  // A split file is shown but not offered; a 1-bit quant is labelled.
  assert.match(card, /localModels\.isSplit\(f\.name\)/);
  assert.match(card, /localModels\.toolRisk\(f\.quant\)/);
  // The deep link lands in Settings with the model pre-filled.
  const app = read('desktop', 'src', 'App.tsx');
  assert.match(app, /onDeepLink\(/);
  assert.match(app, /PENDING_MODEL_KEY/);
});
