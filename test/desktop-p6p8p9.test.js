const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const hfInference = require('../desktop/src/hf-inference.js');
const hfSkills = require('../desktop/src/hf-skills.js');

// ---- P6: HF Inference ----------------------------------------------------

describe('hf-inference', () => {
  it('exports the API the screens use', () => {
    assert.equal(typeof hfInference.providerRow, 'function');
    assert.equal(typeof hfInference.models, 'function');
    assert.equal(typeof hfInference.streamChat, 'function');
  });

  it('providerRow returns null without a token', () => {
    assert.equal(hfInference.providerRow(null), null);
    assert.equal(hfInference.providerRow(''), null);
  });

  it('providerRow returns a row with a token', () => {
    const row = hfInference.providerRow('tok_abc');
    assert.equal(row.id, 'hf');
    assert.equal(row.label, 'Hugging Face');
    assert.ok(row.freeTier.text);
  });

  it('models returns empty without a token', () => {
    assert.deepEqual(hfInference.models(null), []);
  });

  it('models returns the curated list with a token', () => {
    const models = hfInference.models('tok_abc');
    assert.ok(models.length > 0);
    assert.ok(models.some(m => m.id.includes('Qwen')));
    assert.ok(models.every(m => m.free));
  });

  it('streamChat throws without a token', async () => {
    try {
      await hfInference.streamChat('model', [], () => {}, null, null);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('signed-in') || err.message.includes('token'));
    }
  });

});

// ---- P8: HF Skills -------------------------------------------------------

describe('hf-skills', () => {
  it('exports the API the screens use', () => {
    assert.equal(typeof hfSkills.parseSkillMd, 'function');
    assert.equal(typeof hfSkills.loadCatalog, 'function');
  });

  it('parseSkillMd parses frontmatter and body', () => {
    const md = '---\nname: test-skill\ndescription: A test\ntags:\n  - coding\n  - test\n---\n\nThis is the skill body.';
    const skill = hfSkills.parseSkillMd(md);
    assert.equal(skill.name, 'test-skill');
    assert.equal(skill.description, 'A test');
    assert.deepEqual(skill.tags, ['coding', 'test']);
    assert.equal(skill.content, 'This is the skill body.');
  });

  it('parseSkillMd returns null for invalid input', () => {
    assert.equal(hfSkills.parseSkillMd(null), null);
    assert.equal(hfSkills.parseSkillMd(''), null);
    assert.equal(hfSkills.parseSkillMd('no frontmatter'), null);
  });

  it('parseSkillMd handles single-quoted values', () => {
    const md = "name: 'my-skill'\ndescription: \"A skill\"\n---\nBody.";
    const skill = hfSkills.parseSkillMd('---\n' + md + '\n---\n');
    // The parser strips quotes from values.
    assert.equal(skill.name, 'my-skill');
    assert.equal(skill.description, 'A skill');
  });
});
