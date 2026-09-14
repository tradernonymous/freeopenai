// The rules that decide what an image turn is, and what the image model is told.
//
// They exist because matching keywords is not the same as reading a request:
// "make the sky purple" with a photo attached matched no verb-and-noun pair, so
// it fell through to a vision answer *about* the photo and never reached an
// image model at all. A model call now reads the turn and writes the prompt the
// image model actually receives -- with the keyword rules kept as a floor, so
// no reading of a request can turn an attached picture into a fresh text-only
// render (the bug that drew a poster of a car where a recoloured one was asked
// for).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  IMAGE_EDIT_MODELS,
  IMAGE_GENERATE_MODELS,
  IMAGE_PLANNER_PROMPT,
  IMAGE_REFUSAL_ADVICE,
  MAX_IMAGE_PROMPT_CHARS,
  imageModelsFor,
  isModerationRefusal,
  lastImageInMessages,
  parseImagePlan,
  resolveImageAction,
} = require('../chatlib.js');

// ---- choosing the models -------------------------------------------------

test('each kind of work asks a different model, and edits ask the editing one', () => {
  // Puter documents Sunburst for editing precision and Flare for generation.
  // Pinning one pair for both jobs is what made edits drift from their source.
  assert.equal(imageModelsFor('edit')[0], 'gpt-image-2.5-sunburst');
  assert.equal(imageModelsFor('generate')[0], 'gpt-image-2.5-flare');
  assert.notEqual(imageModelsFor('edit')[0], imageModelsFor('generate')[0]);
});

test('every chain is non-empty, falls back, and hands out a copy', () => {
  for (const kind of ['edit', 'generate', undefined, null, 'nonsense']) {
    const chain = imageModelsFor(kind);
    assert.ok(chain.length >= 2, 'a refused model must not end the request');
    // A caller that sorts or shifts its chain must not rearrange the source.
    chain.length = 0;
    assert.ok(imageModelsFor(kind).length >= 2);
  }
  assert.deepEqual(imageModelsFor('generate'), IMAGE_GENERATE_MODELS);
  assert.deepEqual(imageModelsFor('edit'), IMAGE_EDIT_MODELS);
});

// ---- reading the planner's reply -----------------------------------------

test('a plan is read from a bare JSON object', () => {
  const plan = parseImagePlan('{"action":"edit","prompt":"recolour the car deep red"}');
  assert.deepEqual(plan, { action: 'edit', prompt: 'recolour the car deep red' });
});

test('a plan is read out of prose or a code fence, because models add them anyway', () => {
  const fenced = 'Here you go:\n```json\n{"action":"generate","prompt":"a red fox"}\n```\n';
  assert.deepEqual(parseImagePlan(fenced), { action: 'generate', prompt: 'a red fox' });
});

test('an unreadable answer is no plan at all, never a guess', () => {
  // Every one of these would otherwise pick an action out of nothing -- and the
  // one that guesses "generate" draws a picture nobody asked for.
  assert.equal(parseImagePlan(''), null);
  assert.equal(parseImagePlan('   '), null);
  assert.equal(parseImagePlan('I would draw a fox'), null);
  assert.equal(parseImagePlan('{'), null);
  assert.equal(parseImagePlan('{"action":"paint","prompt":"x"}'), null);
  assert.equal(parseImagePlan('{"prompt":"x"}'), null);
  assert.equal(parseImagePlan(null), null);
  assert.equal(parseImagePlan(undefined), null);
});

test('the action is read case-insensitively and the prompt is capped', () => {
  const plan = parseImagePlan('{"action":" Edit ","prompt":"' + 'x'.repeat(MAX_IMAGE_PROMPT_CHARS + 500) + '"}');
  assert.equal(plan.action, 'edit');
  assert.equal(plan.prompt.length, MAX_IMAGE_PROMPT_CHARS);
});

test('a plan with no usable prompt still names an action, and the caller falls back to the words', () => {
  // parseImagePlan reports what it read; the caller substitutes the user's own
  // text when the prompt is empty, so an empty prompt never becomes the request.
  assert.deepEqual(parseImagePlan('{"action":"edit"}'), { action: 'edit', prompt: '' });
});

// ---- the floor and the plan, together ------------------------------------

test('an attached picture keeps a clear edit an edit, whatever the plan says', () => {
  // The deterministic floor: this is the case that once produced a poster of a
  // car instead of a recoloured one.
  for (const plan of [null, { action: 'chat' }, { action: 'generate' }, { action: 'edit' }]) {
    assert.equal(resolveImageAction('edit', plan, { hasImage: true }), 'edit');
  }
});

test('a plain chat message only becomes image work on the model reading, and only with a source', () => {
  const editPlan = { action: 'edit' };
  // "make the sky purple" with a photo attached: no keyword matched, so this is
  // the case the planner exists for.
  assert.equal(resolveImageAction('chat', editPlan, { hasImage: true }), 'edit');
  // The same words with nothing to work from are not an edit of anything.
  assert.equal(resolveImageAction('chat', editPlan, {}), 'chat');
  assert.equal(resolveImageAction('chat', editPlan, { hasImage: false, hasPreviousImage: false }), 'chat');
});

test('a picture already in the chat is a source too', () => {
  assert.equal(resolveImageAction('chat', { action: 'edit' }, { hasPreviousImage: true }), 'edit');
});

test('nothing draws on its own: a generation needs the toggle, not just a plan', () => {
  // With a picture attached, "generate" would mean ignoring it -- so the only
  // way a plan may ask for one is the user having said so with the toggle.
  assert.equal(resolveImageAction('chat', { action: 'generate' }, { hasImage: true }), 'chat');
  assert.equal(resolveImageAction('chat', { action: 'generate' }, { forced: true }), 'generate');
  // A draw request typed in plain words is already a generation, plan or no plan.
  assert.equal(resolveImageAction('generate', null, {}), 'generate');
  assert.equal(resolveImageAction('generate', { action: 'chat' }, {}), 'generate');
});

test('a draw request with a picture attached still edits that picture', () => {
  // "draw me a version of this at night" -- the attachment is the stronger
  // instruction, which is what imageAction decided before the planner ran.
  assert.equal(resolveImageAction('generate', { action: 'chat' }, { hasImage: true }), 'generate');
  assert.equal(resolveImageAction('generate', { action: 'edit' }, { hasImage: true }), 'edit');
});

test('no plan and no keywords is a chat', () => {
  assert.equal(resolveImageAction('chat', null, {}), 'chat');
});

// ---- the picture already in the chat -------------------------------------

test('the newest picture in the conversation is the one a follow-up edits', () => {
  const messages = [
    { type: 'user', content: 'draw a fox' },
    { type: 'bot', content: '[Generated image: a fox]', images: [{ url: 'data:image/png;base64,FIRST', prompt: 'a fox' }] },
    { type: 'user', content: 'make it orange' },
    { type: 'bot', content: '[Generated image: an orange fox]', images: [{ url: 'https://img.example/second.png', prompt: 'an orange fox' }] },
  ];
  assert.deepEqual(lastImageInMessages(messages), { url: 'https://img.example/second.png', prompt: 'an orange fox' });
});

test('a message list with no pictures has no source, and junk does not crash it', () => {
  assert.equal(lastImageInMessages([]), null);
  assert.equal(lastImageInMessages(null), null);
  assert.equal(lastImageInMessages(undefined), null);
  assert.equal(lastImageInMessages([{ type: 'bot', content: 'x' }]), null);
  assert.equal(lastImageInMessages([{ type: 'bot', images: [] }]), null);
  assert.equal(lastImageInMessages([{ type: 'bot', images: [{ prompt: 'no url' }] }]), null);
  assert.equal(lastImageInMessages([{ type: 'bot', images: [null, { url: '' }] }]), null);
});

test('the last picture is found even when later messages carry none', () => {
  const messages = [
    { type: 'bot', images: [{ url: 'only', prompt: 'p' }] },
    { type: 'user', content: 'thanks' },
    { type: 'bot', content: 'you are welcome' },
  ];
  assert.equal(lastImageInMessages(messages).url, 'only');
});

// ---- refusals ------------------------------------------------------------

test('a refusal is recognised however the service words it', () => {
  assert.ok(isModerationRefusal({ errorCode: 'moderation_flagged' }));
  assert.ok(isModerationRefusal(new Error('moderation_flagged')));
  assert.ok(isModerationRefusal(new Error('That request violates our usage policies')));
  assert.ok(isModerationRefusal(new Error('blocked by the safety filter')));
  assert.ok(isModerationRefusal(new Error('the content policy forbids this')));
});

test('everything else is not a refusal', () => {
  // These have their own handling, and treating one as a refusal would hide the
  // real fix (a key, a balance, a retry).
  assert.equal(isModerationRefusal(new Error('No usage left for request')), false);
  assert.equal(isModerationRefusal(new Error('429 rate limited')), false);
  assert.equal(isModerationRefusal(new Error('fetch failed')), false);
  assert.equal(isModerationRefusal(new Error('Image model is required')), false);
  assert.equal(isModerationRefusal(null), false);
  assert.equal(isModerationRefusal(undefined), false);
  assert.equal(isModerationRefusal(''), false);
});

test('the refusal advice says what to change, not which backend failed', () => {
  assert.match(IMAGE_REFUSAL_ADVICE, /rew/i);
  assert.equal(/server image route|Puter/.test(IMAGE_REFUSAL_ADVICE), false);
});

// ---- the planner's brief -------------------------------------------------

test('the planner is asked for one JSON object and told the prompt is verbatim', () => {
  assert.match(IMAGE_PLANNER_PROMPT, /one JSON object/);
  assert.match(IMAGE_PLANNER_PROMPT, /"action"/);
  assert.match(IMAGE_PLANNER_PROMPT, /verbatim/);
  // A pronoun in a generated prompt reaches the image model with nothing behind
  // it, which is most of the difference between this and a bare keyword router.
  assert.match(IMAGE_PLANNER_PROMPT, /pronoun/);
  for (const action of ['generate', 'edit', 'chat']) {
    assert.ok(IMAGE_PLANNER_PROMPT.includes('"' + action + '"'), 'the planner is told about ' + action);
  }
});
