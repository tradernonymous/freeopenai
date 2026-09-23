// NEURA-072: Add from Hugging Face for Images and Dictation.
//
// One downloader, three kinds: text (llama-server GGUF, unchanged), image
// (sd-server .safetensors/.gguf, never a .ckpt pickle) and voice (whisper.cpp
// ggml .bin). The rules live twice -- models.rs refuses, hf-models.js never
// offers -- and this file checks the JS copy directly and the Rust copy by
// reading it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const hf = require(path.join(ROOT, 'desktop', 'src', 'hf-models.js'));

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
const card = (id, files) => ({ id, siblings: files.map(([name, size]) => ({ rfilename: name, size })) });

test('each kind accepts its own formats and refuses the others', () => {
  assert.equal(hf.kindRefusal('image', 'v1-5-pruned-emaonly-fp16.safetensors'), '');
  assert.equal(hf.kindRefusal('image', 'split/diffusion_models/qwen-image-Q4_K_M.gguf'), '');
  assert.match(hf.kindRefusal('image', 'ggml-base.bin'), /not a \.safetensors or \.gguf file/);
  assert.match(hf.kindRefusal('image', 'model_index.json'), /not a \.safetensors or \.gguf file/);

  assert.equal(hf.kindRefusal('voice', 'ggml-base.en.bin'), '');
  assert.match(hf.kindRefusal('voice', 'ggml-base.en.gguf'), /not a ggml \.bin file/);
  assert.match(hf.kindRefusal('voice', 'model.safetensors'), /not a ggml \.bin file/);

  assert.deepEqual(hf.KINDS.image.extensions, ['safetensors', 'gguf']);
  assert.deepEqual(hf.KINDS.voice.extensions, ['bin']);
  assert.equal(hf.KINDS.image.folder, 'sd-models', 'where sd.rs looks');
  assert.equal(hf.KINDS.voice.folder, 'whisper-models', 'where whisper.rs looks');
});

test('a .ckpt is refused, and the refusal gives the reason', () => {
  for (const name of ['v1-5-pruned-emaonly.ckpt', 'sub/Model.CKPT', 'vae.pt', 'x.pth']) {
    assert.match(hf.kindRefusal('image', name), /pickled checkpoint.*arbitrary code/, name);
  }
  assert.match(hf.kindRefusal('voice', 'pytorch_model.bin'), /arbitrary code/, 'a transformers .bin is a pickle too');

  const only = hf.imageOffer(card('someone/old-sd', [['model.ckpt', 4 * GB], ['README.md', 1000]]));
  assert.equal(only.rows.length, 0, 'a pickle is never offered');
  assert.match(only.message, /\.ckpt.*run code/);
});

test('the text kind is unchanged: .gguf only, with the words it always had', () => {
  assert.equal(hf.kindRefusal('text', 'x-Q4_K_M.gguf'), '');
  assert.equal(hf.kindRefusal('text', 'x.safetensors'), 'x.safetensors is not a .gguf file');
  assert.equal(hf.kindRefusal(undefined, 'x.ckpt'), 'x.ckpt is not a .gguf file');
  assert.deepEqual(hf.KINDS.text, { extensions: ['gguf'], folder: 'models' });
});

test('a Flux-style split repo is one set per diffusion model, not a pile of files', () => {
  const offer = hf.imageOffer(card('someone/flux-split', [
    ['split/diffusion_models/flux1-schnell-Q4_K_S.gguf', 6.8 * GB],
    ['split/diffusion_models/flux1-schnell-Q8_0.gguf', 12.6 * GB],
    ['split/vae/ae.safetensors', 335 * MB],
    ['split/text_encoders/clip_l.safetensors', 246 * MB],
    ['split/text_encoders/t5xxl_fp16.safetensors', 9.8 * GB],
    ['split/text_encoders/t5xxl_fp8_e4m3fn.safetensors', 4.9 * GB],
    ['README.md', 2000],
  ]));
  assert.equal(offer.diffusers, false);
  assert.equal(offer.rows.length, 2, 'two diffusion quants, two sets, and no VAE or encoder on its own');
  const small = offer.rows[0];
  assert.deepEqual(small.files.map((f) => f.name), [
    'split/diffusion_models/flux1-schnell-Q4_K_S.gguf',
    'split/text_encoders/clip_l.safetensors',
    'split/text_encoders/t5xxl_fp8_e4m3fn.safetensors',
    'split/vae/ae.safetensors',
  ], 'the model first, then one of each part: both encoders (different stems), the smaller t5');
  assert.equal(small.set, 'flux1-schnell-Q4_K_S', 'the set gets a folder of its own');
  assert.equal(small.size, small.files.reduce((a, f) => a + f.size, 0), 'the row size is the whole set');
});

test('a Qwen-Image-style set takes the encoder quant that matches the model', () => {
  const offer = hf.imageOffer(card('someone/qwen-image-GGUF', [
    ['split/diffusion_models/qwen-image-Q4_K_M.gguf', 13 * GB],
    ['split/text_encoders/Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf', 4.7 * GB],
    ['split/text_encoders/Qwen2.5-VL-7B-Instruct-Q8_0.gguf', 8.1 * GB],
    ['split/vae/qwen_image_vae.safetensors', 254 * MB],
  ]));
  assert.equal(offer.rows.length, 1);
  assert.ok(offer.rows[0].files.some((f) => f.name.endsWith('Instruct-Q4_K_M.gguf')));
  assert.ok(!offer.rows[0].files.some((f) => f.name.endsWith('Q8_0.gguf')), 'one encoder, not both quants');
});

test('a single-file repo offers its checkpoints, and not a stray VAE', () => {
  const offer = hf.imageOffer(card('Comfy-Org/stable-diffusion-v1-5-archive', [
    ['v1-5-pruned-emaonly-fp16.safetensors', 2.1 * GB],
    ['v1-5-pruned-emaonly.safetensors', 4.3 * GB],
    ['v1-5-pruned-emaonly.ckpt', 4.3 * GB],
    ['vae-ft-mse-840000-ema-pruned.safetensors', 335 * MB],
  ]));
  assert.deepEqual(offer.rows.map((r) => r.label), ['v1-5-pruned-emaonly-fp16.safetensors', 'v1-5-pruned-emaonly.safetensors']);
  assert.ok(offer.rows.every((r) => r.set === '' && r.files.length === 1));
});

test('a diffusers repo yields its merged root checkpoint, or says plainly it has none', () => {
  const withRoot = hf.imageOffer(card('someone/sd15-diffusers', [
    ['model_index.json', 600],
    ['unet/diffusion_pytorch_model.safetensors', 3.4 * GB],
    ['vae/diffusion_pytorch_model.safetensors', 335 * MB],
    ['text_encoder/model.safetensors', 492 * MB],
    ['v1-5-pruned-emaonly.safetensors', 4.3 * GB],
  ]));
  assert.equal(withRoot.diffusers, true);
  assert.deepEqual(withRoot.rows.map((r) => r.key), ['v1-5-pruned-emaonly.safetensors'], 'the root file, never the folders');
  assert.equal(withRoot.message, '');

  const bare = hf.imageOffer(card('someone/diffusers-only', [
    ['model_index.json', 600],
    ['unet/diffusion_pytorch_model.safetensors', 3.4 * GB],
    ['vae/diffusion_pytorch_model.safetensors', 335 * MB],
    ['text_encoder/model.safetensors', 492 * MB],
  ]));
  assert.equal(bare.rows.length, 0, 'a folder that will not run is never offered');
  assert.equal(bare.message, 'someone/diffusers-only is in the diffusers layout, which stable-diffusion.cpp cannot load, and it has no single-file checkpoint at its root.');
  assert.equal(bare.message.split('. ').length, 1, 'one plain sentence');
});

test('a whisper repo offers its ggml files, and a transformers repo is told what it is', () => {
  const offer = hf.voiceOffer(card('ggerganov/whisper.cpp', [
    ['ggml-small.bin', 466 * MB],
    ['ggml-base.en.bin', 142 * MB],
    ['ggml-base.en-encoder.mlmodelc.zip', 38 * MB],
  ]));
  assert.deepEqual(offer.rows.map((r) => r.label), ['ggml-base.en.bin', 'ggml-small.bin']);
  const tf = hf.voiceOffer(card('openai/whisper-small', [['pytorch_model.bin', 967 * MB], ['model.safetensors', 967 * MB]]));
  assert.equal(tf.rows.length, 0);
  assert.match(tf.message, /transformers checkpoint; whisper\.cpp needs ggml \.bin files/);
});

test('the fit note is honest about a 4 GB card: fits, runs from RAM, or may not load', () => {
  const pc = { ramGb: 16, vramGb: 4 };
  assert.equal(hf.fitNote(2.1 * GB, 'image', pc).text, 'Fits your 4 GB GPU.');
  const big = hf.fitNote(4.3 * GB, 'image', pc);
  assert.equal(big.text, 'Larger than your 4 GB GPU: it will run from RAM, and slowly.', 'not hidden, just said');
  assert.equal(big.fitsRam, true);
  assert.equal(big.fitsVram, false);
  assert.match(hf.fitNote(24 * GB, 'image', pc).text, /^Needs about 25\.0 GB; this PC reports 16 GB of memory, so it may not load at all\.$/);
  assert.match(hf.fitNote(2 * GB, 'image', { ramGb: 16, vramGb: 0 }).text, /Set your GPU memory in Run settings/);
  assert.ok(hf.fitNote(142 * MB, 'voice', pc).neededGb < 1, 'a small whisper model needs well under a gigabyte');
});

test('a pasted file link names the file', () => {
  assert.equal(hf.pastedFile('https://huggingface.co/a/b/blob/main/split/vae/ae.safetensors'), 'split/vae/ae.safetensors');
  assert.equal(hf.pastedFile('https://huggingface.co/a/b/resolve/main/ggml-base.bin?download=true'), 'ggml-base.bin');
  assert.equal(hf.pastedFile('a/b'), '');
});

test('the shell holds the same kinds, keeps text exactly, and lands each where its tool looks', () => {
  const rust = read('desktop', 'src-tauri', 'src', 'models.rs');
  assert.match(rust, /pub fn hub_file_url\(repo: &str, file: &str\) -> Result<String, String> \{\n    hub_file_url_for\(Kind::Text, repo, file\)/);
  assert.match(rust, /Kind::Text => &\["gguf"\]/);
  assert.match(rust, /Kind::Image => &\["safetensors", "gguf"\]/);
  assert.match(rust, /Kind::Voice => &\["bin"\]/);
  assert.match(rust, /Kind::Image => crate::sd::models_dir\(app\)/);
  assert.match(rust, /Kind::Voice => crate::whisper::models_dir\(app\)/);
  assert.match(rust, /"" \| "text" => Ok\(Kind::Text\)/, 'a call that names no kind is text');
  assert.match(rust, /Kind::Text => "local-download"/, 'the Local models card still hears its own events');
  assert.match(rust, /\.ckpt/);
  assert.match(rust, /arbitrary code/);
  assert.match(rust, /fn a_pickle_is_refused_and_the_refusal_says_why\(\)/);
  // The path rules were not loosened for the new kinds.
  assert.match(rust, /const MAX_FILE_DEPTH: usize = 6;/);
  for (const src of ['LocalImagesCard.tsx', 'DictationCard.tsx']) {
    assert.ok(!/token=/.test(read('desktop', 'src', 'components', src)), `${src}: the token never rides a URL`);
  }
  assert.ok(!/token/.test(hf.fileUrl('a/b', 'ggml-base.bin')));
  // And the folders they land in are the ones the tools already scan.
  assert.match(read('desktop', 'src-tauri', 'src', 'sd.rs'), /\.join\("sd-models"\)/);
  assert.match(read('desktop', 'src-tauri', 'src', 'whisper.rs'), /\.join\("whisper-models"\)/);
});

test('both cards carry the downloader, and the existing call sites are untouched', () => {
  const images = read('desktop', 'src', 'components', 'LocalImagesCard.tsx');
  const dictation = read('desktop', 'src', 'components', 'DictationCard.tsx');
  assert.match(images, /export function HubDownloader/);
  assert.match(images, /<HubDownloader\s+kind="image"/);
  assert.match(images, /call\('sd_use_model', \{ path \}\)/, 'a downloaded checkpoint is the model at once');
  assert.match(dictation, /<HubDownloader\s+kind="voice"/);
  assert.match(dictation, /chooseModel\(path\)/);
  assert.match(images, /localModelDelete\(name, \{ kind/, 'cancel takes back the set');
  const bridge = read('desktop', 'src', 'bridge.ts');
  assert.match(bridge, /kind: args\.kind \?\? null/);
  const text = read('desktop', 'src', 'components', 'LocalModelsCard.tsx');
  assert.match(text, /localModelDownload\(\{ repo, file, \.\.\.\(token \? \{ token \} : \{\}\) \}\)/, 'the text call names no kind');
});
