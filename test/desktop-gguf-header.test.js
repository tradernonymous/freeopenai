// Reading a GGUF's header before the first load, so the context and memory
// estimates for a local file are exact instead of guessed.
//
// The shell parses the header (src-tauri/src/gguf.rs, unit-tested there with
// headers built in memory -- it only compiles on CI); run-settings.js turns
// what it found into the same ModelLimits Ollama's /api/show gives; and
// run-model.ts asks for it before llama-server is ever started.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const run = require('../desktop/src/run-settings.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');

test('a Llama-3-8B header costs 128 KiB of f16 KV cache per token', () => {
  const limits = run.parseGgufInfo({
    architecture: 'llama',
    size_label: '8B',
    context_length: 8192,
    block_count: 32,
    embedding_length: 4096,
    head_count: 32,
    head_count_kv: 8,
    key_length: null,
    value_length: null,
  });
  // 2 (K and V) * 32 layers * 8 KV heads * 128 dims * 2 bytes.
  assert.equal(limits.kvBytesPerToken, 131072);
  assert.equal(limits.kvBytesPerToken, run.DEFAULT_KV_BYTES);
  assert.equal(limits.trainCtx, 8192);
  assert.equal(limits.source, 'gguf');
  assert.equal(limits.arch, 'llama');
  assert.equal(limits.layers, 32);
  assert.equal(limits.sizeLabel, '8B');
});

test('explicit key/value lengths win over embedding / heads', () => {
  // 5120 / 32 would be 160 dims; the header's key_length (128) is the truth.
  const limits = run.parseGgufInfo({
    architecture: 'qwen3',
    context_length: 40960,
    block_count: 36,
    embedding_length: 5120,
    head_count: 32,
    head_count_kv: 8,
    key_length: 128,
    value_length: 128,
  });
  assert.equal(limits.kvBytesPerToken, 36 * 8 * (128 + 128) * 2);
  // Unequal K and V (MLA-style models).
  const mla = run.parseGgufInfo({ architecture: 'x', block_count: 10, head_count: 16, head_count_kv: 16, key_length: 192, value_length: 128 });
  assert.equal(mla.kvBytesPerToken, 10 * 16 * (192 + 128) * 2);
  // Only a key length: the value is the same size.
  const kOnly = run.parseGgufInfo({ architecture: 'x', block_count: 4, head_count: 8, head_count_kv: 2, key_length: 64 });
  assert.equal(kOnly.kvBytesPerToken, 4 * 2 * (64 + 64) * 2);
});

test('GQA and the per-layer array case: the shell sends the max, no KV heads means MHA', () => {
  // gguf.rs collapses a per-layer head_count_kv array to its largest value.
  const gemma = run.parseGgufInfo({
    architecture: 'gemma3',
    context_length: 131072,
    block_count: 34,
    embedding_length: 2560,
    head_count: 8,
    head_count_kv: 4,
    key_length: 256,
    value_length: 256,
    sliding_window: 1024,
  });
  assert.equal(gemma.kvBytesPerToken, 34 * 4 * 512 * 2);
  assert.equal(gemma.slidingWindow, 1024);
  // No head_count_kv at all: every head has its own K and V.
  const mha = run.parseGgufInfo({ architecture: 'gpt2', block_count: 12, embedding_length: 768, head_count: 12 });
  assert.equal(mha.kvBytesPerToken, 12 * 12 * (64 + 64) * 2);
});

test('a header with nothing usable yields only the source, like parseOllamaShow', () => {
  assert.deepEqual(run.parseGgufInfo(null), { source: 'gguf' });
  assert.deepEqual(run.parseGgufInfo({ architecture: '' }), { source: 'gguf' });
  const partial = run.parseGgufInfo({ architecture: 'llama', context_length: 4096 });
  assert.deepEqual(partial, { source: 'gguf', trainCtx: 4096, arch: 'llama' });
  // Same keys as the Ollama parser for the same model shape.
  const ollama = run.parseOllamaShow({
    model_info: {
      'llama.context_length': 8192,
      'llama.block_count': 32,
      'llama.embedding_length': 4096,
      'llama.attention.head_count': 32,
      'llama.attention.head_count_kv': 8,
    },
  });
  const gguf = run.parseGgufInfo({ architecture: 'llama', context_length: 8192, block_count: 32, embedding_length: 4096, head_count: 32, head_count_kv: 8 });
  assert.equal(gguf.trainCtx, ollama.trainCtx);
  assert.equal(gguf.kvBytesPerToken, ollama.kvBytesPerToken);
});

test('the header makes Auto exact: a big-cache model gets a smaller context', () => {
  const machine = { ramGb: 16 };
  const model = { bytes: 4.5 * 1024 ** 3 };
  const guessed = run.autoCtx(null, model, machine);
  // A model with a 4x larger cache than the default guess.
  const heavy = run.parseGgufInfo({ architecture: 'x', context_length: 131072, block_count: 64, head_count: 64, head_count_kv: 16, key_length: 128 });
  assert.ok(run.autoCtx(heavy, model, machine) < guessed, 'the real KV cost lowers Auto');
  // A short-context model is never given more than it was trained for.
  const short = run.parseGgufInfo({ architecture: 'x', context_length: 4096, block_count: 32, head_count: 32, head_count_kv: 8, key_length: 128 });
  assert.equal(run.autoCtx(short, model, machine), 4096);
});

test('gguf.rs reads only the header: arrays skipped without allocating, reads capped', () => {
  const rs = read('desktop', 'src-tauri', 'src', 'gguf.rs');
  assert.match(rs, /pub fn read_header\(path: &Path\) -> Result<GgufInfo, String>/);
  assert.match(rs, /pub fn gguf_info\(path: String\) -> Result<serde_json::Value, String>/);
  assert.match(rs, /const MAGIC: u32 = 0x4655_4747;/);
  assert.match(rs, /const MAX_KV: u64 = 100_000;/);
  assert.match(rs, /const MAX_KEEP_STR: u64 = 1024 \* 1024;/);
  assert.match(rs, /const MAX_READ: u64 = 64 \* 1024 \* 1024;/);
  assert.match(rs, /BufReader::with_capacity/);
  // Skipping goes through a fixed scratch buffer or a seek -- never a Vec.
  const skip = rs.match(/fn skip\(&mut self, n: u64\)[\s\S]*?\n {4}\}\n/);
  assert.ok(skip, 'there is a skip()');
  assert.doesNotMatch(skip[0], /vec!|Vec::|String::/, 'skip allocates nothing');
  assert.match(skip[0], /self\.scratch/);
  assert.match(skip[0], /SeekFrom::Current/);
  // Every consumed byte is counted against the cap first.
  assert.match(rs, /fn advance\(&mut self, n: u64\)[\s\S]*?if next > MAX_READ/);
  // Strings are kept only when wanted and small; array elements are never kept.
  assert.match(rs, /if want && len <= MAX_KEEP_STR/);
  assert.match(rs, /self\.value\(elem, false, depth \+ 1\)/);
  assert.match(rs, /checked_mul\(size\)/);
  // Per-layer head_count_kv: the max, with no allocation.
  assert.match(rs, /max = Some\(max\.map_or\(v, \|m\| m\.max\(v\)\)\)/);
  // Confined: a .gguf that exists; split sets read part 1.
  assert.match(rs, /eq_ignore_ascii_case\("gguf"\)/);
  assert.match(rs, /is_file\(\)/);
  assert.match(rs, /pub fn first_part\(path: &Path\) -> PathBuf/);
  // Unit tests that build a GGUF in memory.
  assert.match(rs, /#\[cfg\(test\)\]/);
  assert.match(rs, /Cursor::new\(llama\(\)\.bytes\(3\)\)/);
  // Nothing is written.
  assert.doesNotMatch(rs, /OpenOptions|fs::write\(&?p|File::create/);
});

test('main.rs declares the module and registers gguf_info; the bridge wraps it', () => {
  const main = read('desktop', 'src-tauri', 'src', 'main.rs');
  assert.match(main, /^mod gguf;$/m);
  assert.match(main, /gguf::gguf_info,/);
  const bridge = read('desktop', 'src', 'bridge.ts');
  assert.match(bridge, /export async function ggufInfo\(path: string\)/);
  assert.match(bridge, /call<[^>]*>\('gguf_info', \{ path \}\)/);
});

test('detectLimits reads the header before anything is loaded', () => {
  const src = read('desktop', 'src', 'run-model.ts');
  const body = src.match(/export async function detectLimits[\s\S]*?\n\}\n/)[0];
  const header = body.indexOf('ggufInfo(entry.path)');
  assert.ok(header > 0, 'detectLimits asks the shell for the header');
  assert.ok(header < body.indexOf('/v1/models'), 'the header comes before the loaded server');
  assert.match(body, /runSettings\.parseGgufInfo\(/);
  // ensureUnsloth: the header is read BEFORE local_model_start.
  const ensure = src.match(/export async function ensureUnsloth[\s\S]*?\n\}\n/)[0];
  const before = ensure.indexOf('await detectLimits(entry)');
  assert.ok(before > 0 && before < ensure.indexOf('localModelStart('), 'limits are known before the load');
  assert.match(ensure, /loadArgs\(resolvedValues\(entry\), cores\)/, 'the exact context is what is sent');
  // A model added anywhere has its header read in the background.
  assert.match(src, /export function learnLimits\(\)/);
  assert.match(src, /addEventListener\(savedModels\.CHANGED_EVENT, learnLimits\)/);
});

test('the drawer shows the header facts and reads a file without loading it', () => {
  const drawer = read('desktop', 'src', 'components', 'RunSettings.tsx');
  assert.match(drawer, /limits\.arch/);
  assert.match(drawer, /layers/);
  assert.match(drawer, /of cache per 1k tokens/);
  assert.match(drawer, /Read from model/);
  // Local files: detectLimits (the header) first; loading only as a fallback.
  assert.match(drawer, /detectLimits\(entry\)\.then\(\(found\) => found\?\.trainCtx/);
});
