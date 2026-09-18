const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { LLM_PROVIDERS, createRequestHandler, clearModelCache, clearImageDiscoveryCache } = require('../server.js');

test('the gemini slot is declared with the shape the server relies on', () => {
  const provider = LLM_PROVIDERS.gemini;
  assert.equal(provider.label, 'Gemini');
  assert.equal(provider.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(provider.envVar, 'GEMINI_API_KEY');
});