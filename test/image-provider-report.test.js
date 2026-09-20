const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');

test('image session tab gives users actionable provider diagnostics', () => {
  assert.match(css, /id="imageProviderReport"[^>]*aria-live="polite"/);
  assert.match(css, /id="imageProviderReport"[^>]*aria-busy/);
  assert.match(html, /image-provider-report-note/);
  assert.match(css, /id="imageProviderReportStatus"[^>]*>Checking…/);
  assert.match(html, /id="chatProviderList"/);
  assert.match(html, /id="imageProviderList"/);
  assert.match(html, /onclick="loadImageProviderReport\(\)"/);
  assert.match(html, /read\('\/api\/llm\/providers'/);
  assert.match(html, /read\('\/api\/llm\/images\/providers'/);
  assert.match(html, /Could not check image services/);
  assert.match(html, /status\.dataset\.state = 'ready'/);
  assert.match(html, /report\.setAttribute\('aria-busy', 'false'\)/);
  assert.match(html, /var imageProviderReportRequest = null/);
  assert.match(html, /if \(imageProviderReportRequest\) return imageProviderReportRequest/);
});

test('provider diagnostics render provider names as text, not HTML', () => {
  assert.match(css, /querySelector\('\.image-provider-name'\)\.textContent/);
  assert.match(css, /querySelector\('\.image-provider-detail'\)\.textContent/);
  assert.match(html, /provider\.reason \|\| provider\.note/);
  // Configured state decides the row's state label on the chat tab: a slot
  // that answers reads as ready, one still awaiting its variable as setup.
  assert.match(html, /provider\.configured \? 'ready' : 'setup'/);
});
