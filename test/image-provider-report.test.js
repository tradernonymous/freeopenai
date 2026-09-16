const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('image session tab gives users actionable provider diagnostics', () => {
  assert.match(html, /id="imageProviderReport"[^>]*aria-live="polite"/);
  assert.match(html, /id="imageProviderReportStatus">Checking…/);
  assert.match(html, /id="chatProviderList"/);
  assert.match(html, /id="imageProviderList"/);
  assert.match(html, /onclick="loadImageProviderReport\(\)"/);
  assert.match(html, /read\('\/api\/llm\/providers'/);
  assert.match(html, /read\('\/api\/llm\/images\/providers'/);
  assert.match(html, /Could not check image services/);
});

test('provider diagnostics render provider names as text, not HTML', () => {
  assert.match(html, /querySelector\('\.image-provider-name'\)\.textContent/);
  assert.match(html, /querySelector\('\.image-provider-detail'\)\.textContent/);
  assert.match(html, /provider\.reason \|\| provider\.note/);
  assert.match(html, /provider\.configured &&/);
});
