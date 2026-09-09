// Shared pure logic used by index.html (browser) and the test suite (Node).
// No DOM/Node APIs here so it can run in either environment unmodified.

const MODELS = [
  { id: 'gpt-4o', name: 'GPT-4o', desc: 'Balanced' },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', desc: 'Fast, cheap' },
  { id: 'o1', name: 'o1', desc: 'Reasoning' },
  { id: 'o1-mini', name: 'o1 Mini', desc: 'Fast reasoning' },
];

const DEFAULT_MODEL = 'gpt-4o-mini';

function isValidModel(id) {
  return MODELS.some((m) => m.id === id);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ATTACHABLE_EXTENSIONS = ['.txt', '.md', '.csv', '.json', '.js', '.ts', '.log', '.yml', '.yaml'];

function isAttachableFile(filename) {
  const lower = String(filename).toLowerCase();
  return ATTACHABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MODELS, DEFAULT_MODEL, isValidModel, escapeHtml, ATTACHABLE_EXTENSIONS, isAttachableFile };
}
