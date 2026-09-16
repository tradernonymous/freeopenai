// One-shot vendoring assembly for the mermaid branch. Downloads every
// /npm/ spec reachable from the entry until the closure is fixed, saves each
// under a descriptive name, verifies the mapping covers all specs found in
// all saved files, syntax-checks each file, and emits the import map JSON.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');

// Re-vendors mermaid from the jsdelivr +esm closure: downloads every /npm/
// spec reachable from the entry until the set is fixed, rewrites each spec
// to its vendored relative file (so the page needs no import map), and
// verifies coverage, syntax, and the final byte hashes in SOURCES.json.
// Run from the repo root: node tools/assemble-mermaid.js
// To move versions: download the new +esm entry to vendor/mermaid-12.0.0.mjs
// (renamed for the version), wipe vendor/mermaid/, then run.
const OUT = path.join(__dirname, '..', 'vendor', 'mermaid');
const ENTRY = path.join(__dirname, '..', 'vendor', 'mermaid-12.0.0.mjs');
fs.mkdirSync(OUT, { recursive: true });

function fileFor(spec) {
  // /npm/d3-array@3.2.4/+esm -> d3-array-3.2.4.mjs
  // /npm/mermaid@12.0.0/dist/chunks/mermaid.core/dagre-6A5THRUB.mjs/+esm
  //   -> mermaid-12.0.0-chunk-dagre-6A5THRUB.mjs
  const m = /^\/npm\/(.+)\/\+esm$/.exec(spec);
  if (!m) throw new Error('cannot name file for spec: ' + spec);
  const inner = m[1];
  const chunk = /^(.*)\/dist\/chunks\/[^/]+\/([^/]+)\.mjs$/.exec(inner);
  if (chunk) return chunk[1].replace(/[@/]/g, '-').replace(/^-/, '') + '-chunk-' + chunk[2] + '.mjs';
  const p = /^((?:@[^/]+\/)?[^/]+)@([^/]+)$/.exec(inner);
  if (p) return p[1].replace('/', '-').replace(/^@/, '') + '-' + p[2] + '.mjs';
  const q = /^((?:@[^/]+\/)?[^/]+)@([^/]+)\/(.+)$/.exec(inner);
  if (q) return q[1].replace('/', '-').replace(/^@/, '') + '-' + q[2] + '-' + q[3].replace(/\//g, '-') + '.mjs';
  throw new Error('cannot name file for spec: ' + spec);
}

function specsIn(src) {
  const out = new Set();
  for (const m of src.matchAll(/from"(\/npm\/[^"]+)"/g)) out.add(m[1]);
  for (const m of src.matchAll(/import\("(\/npm\/[^"]+)"\)/g)) out.add(m[1]);
  return out;
}

function fetch(url, dest) {
  execSync(`powershell -NoProfile -Command "Invoke-WebRequest -Uri '${url}' -OutFile '${dest}' -TimeoutSec 120"`, { stdio: 'pipe' });
}

const entrySrc = fs.readFileSync(ENTRY, 'utf8');
const entryFile = 'mermaid-12.0.0.mjs';
fs.copyFileSync(ENTRY, path.join(OUT, entryFile));

const pending = new Map(); // spec -> filename
for (const s of specsIn(entrySrc)) pending.set(s, fileFor(s));

const mapping = {};
let rounds = 0;
while (pending.size && rounds < 6) {
  rounds++;
  const batch = [...pending.entries()];
  pending.clear();
  for (const [spec, file] of batch) {
    const dest = path.join(OUT, file);
    if (!fs.existsSync(dest)) {
      fetch('https://cdn.jsdelivr.net' + spec, dest);
      console.log('got ' + spec + ' -> ' + file);
    }
    mapping[spec] = './vendor/mermaid/' + file;
    for (const s of specsIn(fs.readFileSync(dest, 'utf8'))) {
      if (!mapping[s] && ![...pending.keys()].includes(s)) pending.set(s, fileFor(s));
    }
  }
}
if (pending.size) {
  console.log('CLOSURE NOT REACHED, remaining: ' + [...pending.keys()].join(', '));
  process.exit(1);
}

// Verify: every spec found in every saved file has a mapping.
const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.mjs'));
let uncovered = 0;
for (const f of files) {
  for (const s of specsIn(fs.readFileSync(path.join(OUT, f), 'utf8'))) {
    if (!mapping[s]) { console.log('UNCOVERED: ' + s + ' (in ' + f + ')'); uncovered++; }
  }
}
console.log('files: ' + files.length + ', mapped specs: ' + Object.keys(mapping).length + ', uncovered: ' + uncovered);

// Syntax-check every file as ESM.
for (const f of files) {
  try {
    execSync(`node --check "${path.join(OUT, f)}"`, { stdio: 'pipe' });
  } catch {
    console.log('SYNTAX FAIL: ' + f);
    process.exit(1);
  }
}
console.log('all files parse as ESM');

// Total weight + entry hash for the code comment.
let bytes = 0;
for (const f of files) bytes += fs.statSync(path.join(OUT, f)).size;
console.log('total vendored bytes: ' + bytes);
const entryHash = crypto.createHash('sha384').update(fs.readFileSync(path.join(OUT, entryFile))).digest('base64');
console.log('entry sha384: ' + entryHash);

const importmap = { imports: Object.fromEntries(Object.entries(mapping).sort()) };
fs.writeFileSync(path.join(OUT, 'importmap.json'), JSON.stringify(importmap, null, 2) + '\n');
console.log('importmap.json written');

// Rewrite every /npm/ specifier to its vendored relative file, so the page
// needs no import map: the directory becomes a self-contained ESM graph.
// Then re-verify: no /npm/ reference may remain, and every file must parse.
for (const f of files) {
  const dest = path.join(OUT, f);
  let src = fs.readFileSync(dest, 'utf8');
  for (const [spec, target] of Object.entries(mapping)) {
    const local = './' + target.split('/').pop();
    src = src.split('"' + spec + '"').join('"' + local + '"');
  }
  fs.writeFileSync(dest, src);
}
let leftover = 0;
for (const f of files) {
  const src = fs.readFileSync(path.join(OUT, f), 'utf8');
  const hits = [...src.matchAll(/from"(\/npm\/[^"]+)"/g), ...src.matchAll(/import\("(\/npm\/[^"]+)"\)/g)];
  if (hits.length) { console.log('LEFTOVER /npm/ in ' + f + ': ' + hits[0][1]); leftover++; }
  try {
    execSync(`node --check "${path.join(OUT, f)}"`, { stdio: 'pipe' });
  } catch {
    console.log('SYNTAX FAIL after rewrite: ' + f);
    process.exit(1);
  }
}
console.log(leftover === 0 ? 'rewrite clean: no /npm/ references remain, all files parse' : 'REWRITE DIRTY');
if (leftover) process.exit(1);

// Provenance record: what was vendored, from where, with hashes.
const manifest = {
  package: 'mermaid@12.0.0',
  source: 'https://cdn.jsdelivr.net/npm/mermaid@12.0.0/+esm and its /npm/ closure',
  builtAt: new Date().toISOString().split('T')[0],
  specs: Object.fromEntries(Object.entries(mapping).sort()),
  files: {},
};
for (const f of files) {
  manifest.files[f] = crypto.createHash('sha384').update(fs.readFileSync(path.join(OUT, f))).digest('base64');
}
fs.writeFileSync(path.join(OUT, 'SOURCES.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('SOURCES.json written');
