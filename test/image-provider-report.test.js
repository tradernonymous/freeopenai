const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('image session tab gives users actionable provider diagnostics', () => {
  assert.match(html, /id="imageProviderReport"[^>]*aria-live="polite"/);
  assert.match(html, /id="imageProviderReport"[^>]*aria-busy/);
  assert.match(html, /image-provider-report-note/);
  assert.match(html, /id="imageProviderReportStatus"[^>]*>Checking…/);
  assert.match(html, /id="chatProviderList"/);
  assert.match(html, /id="imageProviderList"/);
  assert.match(html, /onclick="loadImageProviderReport\(\)"/);
  assert.match(appJs, /read\('\/api\/llm\/providers'/);
  assert.match(appJs, /read\('\/api\/llm\/images\/providers'/);
  assert.match(appJs, /Could not check image services/);
  assert.match(appJs, /status\.dataset\.state = 'ready'/);
  assert.match(appJs, /report\.setAttribute\('aria-busy', 'false'\)/);
  assert.match(appJs, /var imageProviderReportRequest = null/);
  assert.match(appJs, /if \(imageProviderReportRequest\) return imageProviderReportRequest/);
});

test('provider diagnostics render provider names as text, not HTML', () => {
  assert.match(appJs, /querySelector\('\.image-provider-name'\)\.textContent/);
  assert.match(appJs, /querySelector\('\.image-provider-detail'\)\.textContent/);
  assert.match(appJs, /provider\.reason \|\| provider\.note/);
  // Configured state decides the row's state label on the chat tab: a slot
  // that answers reads as ready, one still awaiting its variable as setup.
  assert.match(appJs, /provider\.configured \? 'ready' : 'setup'/);
});
