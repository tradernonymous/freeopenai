// The "Social post" skill: four platform templates the studio offers next to
// the engine's own, each with the platform's canvas size and a brief of how
// that platform reads. Carousels (and the thread and script storyboards) are
// decks: one <section class="slide"> per card, laid out on a stage of the
// platform's own size, so deck mode, per-artboard PNG/SVG and PPTX export all
// work on them unchanged.
//
// The platform notes are ours, written from how these formats are used -- not
// copied from any platform's guidelines.
//
// UMD (see chats.js); data plus two tiny helpers, node-tested.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4USocial = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var TEMPLATES = [
    {
      id: 'x-thread',
      label: 'X thread',
      category: 'social',
      width: 1200,
      height: 675,
      unit: 'px',
      deck: true,
      description: 'A 4-8 post thread; each post a card with its copy and an optional 16:9 image panel.',
      prompt: [
        'Platform: an X (Twitter) thread of 4 to 8 posts. Each <section class="slide"> is ONE post, drawn as a 1200x675 card.',
        'Post 1 is the hook: one concrete claim, number or tension, no throat-clearing, and it must stand alone in a feed.',
        'Each post is under 280 characters of copy, set large on the card, with a small "n/N" counter; one idea per post.',
        'Middle posts deliver: steps, evidence, a before/after. The last post lands the point and gives one clear next step (follow, reply, link) without begging.',
        'No hashtag walls (two at most, only on the last post), no emoji bullets, no "A thread 🧵" filler.',
      ].join('\n'),
    },
    {
      id: 'linkedin-carousel',
      label: 'LinkedIn carousel',
      category: 'social',
      width: 1080,
      height: 1350,
      unit: 'px',
      deck: true,
      description: 'A 6-10 slide document carousel at 1080x1350 (4:5), cover to call to action.',
      prompt: [
        'Platform: a LinkedIn document carousel, 6 to 10 slides, each <section class="slide"> exactly 1080x1350 (4:5 portrait).',
        'Slide 1 is the cover: a specific promise in at most 10 words, set very large, plus the author line. It is the thumbnail in the feed, so it must read at phone size.',
        'Each following slide makes ONE point: a short headline (max 8 words) and at most 30 words of support, or one number with its context, or a simple before/after.',
        'Keep a consistent grid: the same margins, headline position and a small slide number on every slide, so swiping feels like turning pages.',
        'The last slide sums up in one line and gives one call to action. Professional, plain and specific; no buzzword stacks.',
      ].join('\n'),
    },
    {
      id: 'tiktok-script',
      label: 'TikTok script',
      category: 'social',
      width: 1080,
      height: 1920,
      unit: 'px',
      deck: true,
      description: 'A 15-60 second vertical video script as a storyboard: one 9:16 frame per beat.',
      prompt: [
        'Platform: a TikTok (short vertical video) script for 15 to 60 seconds, drawn as a storyboard: each <section class="slide"> is one beat, a 1080x1920 frame.',
        'Beat 1 (0-2s) is the hook: what is said AND the on-screen text, both under 8 words, promising a payoff the video keeps.',
        'Every beat shows three labelled parts: the timecode, the on-screen text (big, inside the middle safe area -- keep 200px clear at the top and 400px at the bottom for the app UI), and the voice-over line in smaller type.',
        'Beats are 2 to 6 seconds each; change something visual every beat. The last beat pays off the hook and has one call to action.',
        'Write it to be spoken: short sentences, contractions, no corporate phrasing.',
      ].join('\n'),
    },
    {
      id: 'instagram-carousel',
      label: 'Instagram carousel',
      category: 'social',
      width: 1080,
      height: 1080,
      unit: 'px',
      deck: true,
      description: 'A 5-10 slide square carousel at 1080x1080, image-led, with a caption.',
      prompt: [
        'Platform: an Instagram carousel, 5 to 10 slides, each <section class="slide"> exactly 1080x1080 (square).',
        'Slide 1 stops the scroll with one bold visual idea and at most 6 words; the rest of the grid must look like one set (same palette, type and margins).',
        'Lead with visuals: shapes, inline SVG illustration or a big number; text per slide stays under 25 words and never runs to the edges (keep 80px clear).',
        'Give the last slide a reason to save or share (a checklist, a summary) and one call to action.',
        'After the slides, add an <aside class="caption"> (hidden on the slides with display:none) holding the post caption: a first line that works cut off after 125 characters, then at most 5 relevant hashtags.',
      ].join('\n'),
    },
  ];

  function byId(id) {
    for (var i = 0; i < TEMPLATES.length; i += 1) if (TEMPLATES[i].id === id) return TEMPLATES[i];
    return null;
  }

  /** The engine's templates with the social ones added (an engine id wins; order kept). */
  function merge(engineTemplates) {
    var list = Array.isArray(engineTemplates) ? engineTemplates.slice() : [];
    var seen = {};
    list.forEach(function (t) { if (t && t.id) seen[t.id] = true; });
    TEMPLATES.forEach(function (t) {
      if (!seen[t.id]) list.push({ id: t.id, label: t.label, category: t.category, width: t.width, height: t.height, unit: t.unit, description: t.description });
    });
    return list;
  }

  /** The platform brief for a template id ('' for anything that is not a social template). */
  function promptFor(id) {
    var t = byId(id);
    return t ? t.prompt : '';
  }

  return { TEMPLATES: TEMPLATES, byId: byId, merge: merge, promptFor: promptFor };
});
