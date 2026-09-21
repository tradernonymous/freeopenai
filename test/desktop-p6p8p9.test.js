const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const hfInference = require('../desktop/src/hf-inference.js');
const hfSkills = require('../desktop/src/hf-skills.js');
const finetune = require('../desktop/src/finetune.js');

// ---- P6: HF Inference ----------------------------------------------------

describe('hf-inference', () => {
  it('exports the expected API surface', () => {
    assert.equal(typeof hfInference.providerRow, 'function');
    assert.equal(typeof hfInference.models, 'function');
    assert.equal(typeof hfInference.streamChat, 'function');
    assert.equal(typeof hfInference.chat, 'function');
    assert.ok(Array.isArray(hfInference.FREE_MODELS));
    assert.ok(hfInference.API_BASE.includes('huggingface.co'));
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

  it('chat throws without a token', async () => {
    try {
      await hfInference.chat('model', [], null);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('signed-in') || err.message.includes('token'));
    }
  });
});

// ---- P8: HF Skills -------------------------------------------------------

describe('hf-skills', () => {
  it('exports the expected API surface', () => {
    assert.equal(typeof hfSkills.fetchSkill, 'function');
    assert.equal(typeof hfSkills.parseSkillMd, 'function');
    assert.equal(typeof hfSkills.loadCatalog, 'function');
    assert.equal(typeof hfSkills.filterSkills, 'function');
    assert.ok(Array.isArray(hfSkills.SKILL_REPOS));
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

  it('filterSkills filters by name', () => {
    const skills = [
      { name: 'hf-mem', description: 'Memory estimation', tags: ['memory'] },
      { name: 'hf-cli', description: 'CLI tools', tags: ['cli'] },
    ];
    assert.equal(hfSkills.filterSkills(skills, 'mem').length, 1);
    assert.equal(hfSkills.filterSkills(skills, 'cli').length, 1);
    assert.equal(hfSkills.filterSkills(skills, 'xyz').length, 0);
  });

  it('filterSkills returns all when query is empty', () => {
    const skills = [{ name: 'a', description: '', tags: [] }];
    assert.equal(hfSkills.filterSkills(skills, '').length, 1);
    assert.equal(hfSkills.filterSkills(skills, null).length, 1);
  });

  it('filterSkills matches tags', () => {
    const skills = [
      { name: 'x', description: '', tags: ['training', 'unsloth'] },
    ];
    assert.equal(hfSkills.filterSkills(skills, 'unsloth').length, 1);
  });
});

// ---- P9: Fine-tuning -----------------------------------------------------

describe('finetune', () => {
  it('exports the expected API surface', () => {
    assert.equal(typeof finetune.estimateRequirements, 'function');
    assert.equal(typeof finetune.validateDataset, 'function');
    assert.equal(typeof finetune.createSession, 'function');
    assert.equal(typeof finetune.buildCommand, 'function');
    assert.equal(typeof finetune.statusText, 'function');
    assert.equal(typeof finetune.MIN_RAM_GB, 'number');
    assert.equal(typeof finetune.DEFAULT_LORA_R, 'number');
  });

  it('estimateRequirements returns fits=true for small models', () => {
    const req = finetune.estimateRequirements(1, 16, 100);
    assert.ok(req.fits);
    assert.ok(req.ramGb > 0);
    assert.ok(req.reason.includes('Estimated'));
  });

  it('estimateRequirements returns fits=false for large models', () => {
    const req = finetune.estimateRequirements(30, 64, 1000);
    assert.ok(!req.fits);
    assert.ok(req.reason.includes('Needs'));
  });

  it('validateDataset accepts valid JSONL', () => {
    const jsonl = '{"prompt":"hi","completion":"hello"}\n{"prompt":"bye","completion":"goodbye"}';
    const result = finetune.validateDataset(jsonl);
    assert.ok(result.valid);
    assert.equal(result.count, 2);
    assert.equal(result.errors.length, 0);
  });

  it('validateDataset catches missing prompt', () => {
    const jsonl = '{"completion":"hello"}';
    const result = finetune.validateDataset(jsonl);
    assert.ok(!result.valid);
    assert.ok(result.errors[0].includes('prompt'));
  });

  it('validateDataset catches missing completion', () => {
    const jsonl = '{"prompt":"hi"}';
    const result = finetune.validateDataset(jsonl);
    assert.ok(!result.valid);
    assert.ok(result.errors[0].includes('completion'));
  });

  it('validateDataset catches invalid JSON', () => {
    const jsonl = '{broken';
    const result = finetune.validateDataset(jsonl);
    assert.ok(!result.valid);
    assert.ok(result.errors[0].includes('invalid JSON'));
  });

  it('validateDataset accepts "response" as alternative to "completion"', () => {
    const jsonl = '{"prompt":"hi","response":"hello"}';
    const result = finetune.validateDataset(jsonl);
    assert.ok(result.valid);
  });

  it('createSession returns a session with defaults', () => {
    const s = finetune.createSession();
    assert.ok(s.id.startsWith('finetune-'));
    assert.equal(s.status, 'idle');
    assert.equal(s.loraR, finetune.DEFAULT_LORA_R);
    assert.equal(s.epochs, finetune.DEFAULT_EPOCHS);
    assert.equal(s.progress, 0);
  });

  it('createSession accepts overrides', () => {
    const s = finetune.createSession({ baseModel: 'model.gguf', loraR: 32 });
    assert.equal(s.baseModel, 'model.gguf');
    assert.equal(s.loraR, 32);
  });

  it('buildCommand returns the expected command', () => {
    const s = finetune.createSession({ baseModel: 'model.gguf', datasetPath: 'data.jsonl' });
    const cmd = finetune.buildCommand(s);
    assert.ok(cmd.includes('llama-cli'));
    assert.ok(cmd.includes('--mode'));
    assert.ok(cmd.includes('finetune'));
    assert.ok(cmd.includes('model.gguf'));
    assert.ok(cmd.includes('data.jsonl'));
  });

  it('statusText returns empty for null', () => {
    assert.equal(finetune.statusText(null), '');
  });

  it('statusText returns status for each state', () => {
    assert.equal(finetune.statusText(finetune.createSession({ status: 'idle' })), 'Ready to train.');
    assert.ok(finetune.statusText(finetune.createSession({ status: 'training', currentEpoch: 1, totalEpochs: 3 })).includes('1/3'));
    assert.ok(finetune.statusText(finetune.createSession({ status: 'error', error: 'OOM' })).includes('OOM'));
  });
});
