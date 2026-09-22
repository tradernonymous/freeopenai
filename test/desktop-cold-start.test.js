// NEURA-035: cold start. Chat's optional parts stay out of the first bundle
// (entry 525.61 -> 491.41 kB on the same tree): the drawers, the MCP App frame
// and the attachment readers load in their own chunks. The marks themselves are
// tested in desktop-diagnostics.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8').replace(/\r\n/g, '\n');

test('ChatScreen loads its drawers and attachment readers lazily', () => {
  const src = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  for (const eager of [
    "import RunSettings from '../components/RunSettings'",
    "import CompareDrawer from '../components/CompareDrawer'",
    "import '../files/zip.js'",
    "import '../files/office.js'",
    "import '../files/pdf.js'",
  ]) {
    assert.ok(!src.includes(eager), `not eager: ${eager}`);
  }
  assert.match(src, /const RunSettings = afterPaint\(\(\) => import\('\.\.\/components\/RunSettings'\)\)/);
  assert.match(src, /const CompareDrawer = afterPaint\(\(\) => import\('\.\.\/components\/CompareDrawer'\)\)/);
  // zip first: office.js and pdf.js read FreeZip as they load.
  assert.match(src, /import\('\.\.\/files\/zip\.js'\)\s*\.then\(\(\) => Promise\.all\(\[import\('\.\.\/files\/office\.js'\), import\('\.\.\/files\/pdf\.js'\)\]\)\)/);
  assert.match(src, /const office = lazyUmd<typeof import\('\.\.\/files\/office\.js'\)>\('FreeOffice'\)/);
  assert.match(src, /const pdf = lazyUmd<typeof import\('\.\.\/files\/pdf\.js'\)>\('FreePdf'\)/);
});

test('the lazy readers keep their module names, so the globals match', () => {
  const office = require('../desktop/src/files/office.js');
  const pdf = require('../desktop/src/files/pdf.js');
  for (const fn of ['extractDocxText', 'extractPptxText', 'extractXlsxSheets', 'sheetToText']) {
    assert.equal(typeof office[fn], 'function', fn);
  }
  assert.equal(typeof pdf.extractPdfText, 'function');
  assert.equal(globalThis.FreeOffice, office);
  assert.equal(globalThis.FreePdf, pdf);
});
