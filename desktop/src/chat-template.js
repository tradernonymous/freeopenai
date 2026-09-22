// A local model's OWN chat template, rendered here.
//
// A GGUF carries the Jinja template it was trained with (tokenizer.chat_template
// in the header). Until now the page never looked at it: every local turn went
// out as a list of messages and whatever shaped it downstream decided where the
// system prompt goes, how a tool call is written, and which tags a thinking
// model opens. For a model whose template differs from that guess the answer is
// wrong in ways that read like a bad model -- so the file's own template is the
// one that should win.
//
// THE TEMPLATE IS UNTRUSTED. It came out of a file the person downloaded, and
// Jinja is a language: a template can loop forever, or render a gigabyte.
// Nothing here trusts it. Every render is fenced by LIMITS -- the template's own
// length, how many messages and how much text go in, how much text may come out
// -- and by a refusal of the one construct that can loop without the caller's
// input bounding it (`range()` over a big constant; Jinja has no `while`, and a
// macro that calls itself blows the JS stack, which is caught below). A render
// that trips any of these does not throw at the person: it returns a reason and
// the caller falls back to the generic path, which is exactly what shipped
// before this file existed.
//
// SPECIAL TOKENS ARE NOT WRITTEN TWICE. The rendered text is handed to
// llama-server as a prompt, and llama-server tokenizes a prompt with its
// special tokens on -- it prepends the model's BOS itself. So the template is
// rendered with sentinels in place of bos_token/eos_token: a leading BOS is
// dropped (the runtime is about to add it), and a template that needs either
// token anywhere else is refused, because the header gives their ids, never
// their text, and guessing one would corrupt the prompt silently.
//
// UMD like the repo's other shared modules.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UChatTemplate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var CACHE_KEY = 'freeai4u.chat_templates';

  // Generous against every real chat template (the longest in the wild are a
  // few tens of kilobytes), tight against a file that is not one.
  var LIMITS = {
    /** The template source itself. */
    template: 128 * 1024,
    /** Turns in one render. */
    messages: 512,
    /** Total characters of message text going in. */
    input: 512 * 1024,
    /** Characters of prompt coming out. */
    output: 1024 * 1024,
    /** The largest constant a template may hand `range()`. */
    range: 10000,
  };

  // Stand-ins for the two tokens only the tokenizer knows the text of.
  // NUL cannot occur in a template's own literals or in chat text.
  var BOS = '\u0000bos\u0000';
  var EOS = '\u0000eos\u0000';

  // The Jinja implementation, handed in by the page (run-model.ts) so this
  // module stays a plain UMD file and the bundler still sees one import.
  var Engine = null;

  function setEngine(template) {
    Engine = typeof template === 'function' ? template : null;
    return !!Engine;
  }

  function engine() {
    if (Engine) return Engine;
    // Under real CommonJS (the tests) the package resolves at runtime; in the
    // page it arrives through setEngine, because a UMD file has no import. The
    // name is a variable so a bundler does not try to follow it into a build
    // where this branch is dead anyway (see files/office.js, evals.js).
    if (typeof module === 'object' && module.exports && typeof require === 'function') {
      var pkg = '@huggingface/jinja';
      try {
        Engine = require(pkg).Template;
      } catch {
        Engine = null;
      }
    }
    return Engine;
  }

  function storage(given) {
    if (given) return given;
    try {
      var scope = typeof globalThis !== 'undefined' ? globalThis : {};
      return scope.localStorage || null;
    } catch {
      return null;
    }
  }

  function fail(reason) {
    return { prompt: '', reason: reason };
  }

  /** The template a `gguf_info` answer carries, or '' when the file has none. */
  function templateOf(info) {
    var found = info && info.chat_template;
    if (typeof found !== 'string') return '';
    return found.length > LIMITS.template ? '' : found;
  }

  // ---- what is remembered per model -------------------------------------------
  //
  // Reading a header means opening a multi-gigabyte file, so the answer is kept
  // per model id. '' is a real answer -- "this file has no template" -- and is
  // remembered too, so a model without one is not re-read on every turn. Only a
  // FAILED read is left unremembered, because that is a condition that mends.

  function readMap(given) {
    var target = storage(given);
    if (!target) return {};
    try {
      var parsed = JSON.parse(target.getItem(CACHE_KEY) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeMap(map, given) {
    var target = storage(given);
    if (!target) return false;
    try {
      target.setItem(CACHE_KEY, JSON.stringify(map));
      return true;
    } catch {
      // A full or refused store is not worth a message: the header is re-read.
      return false;
    }
  }

  /** The template remembered for `modelId`, '' for "none", null for "not asked yet". */
  function cached(modelId, given) {
    var map = readMap(given);
    var found = Object.prototype.hasOwnProperty.call(map, modelId) ? map[modelId] : null;
    return typeof found === 'string' ? found : null;
  }

  function remember(modelId, template, given) {
    if (!modelId) return false;
    var text = typeof template === 'string' && template.length <= LIMITS.template ? template : '';
    var map = readMap(given);
    map[modelId] = text;
    return writeMap(map, given);
  }

  function forget(modelId, given) {
    var map = readMap(given);
    if (!Object.prototype.hasOwnProperty.call(map, modelId)) return false;
    delete map[modelId];
    return writeMap(map, given);
  }

  // ---- rendering ---------------------------------------------------------------

  /**
   * The one way a template can loop without the caller's own (capped) input
   * bounding it: `range()` over a constant. A real chat template ranges over
   * the messages it was given, never over a number of its own.
   */
  function rangeBomb(text) {
    var calls = /range\s*\(([^)]*)\)/g;
    var call;
    while ((call = calls.exec(text))) {
      var numbers = call[1].match(/\d+/g) || [];
      for (var i = 0; i < numbers.length; i += 1) {
        if (Number(numbers[i]) > LIMITS.range) {
          return 'the template loops over ' + numbers[i] + ' steps of its own, which is not a chat template';
        }
      }
    }
    return '';
  }

  /** A message as a template expects it: a role, text, and the tool fields. */
  function flatten(message) {
    var row = message && typeof message === 'object' ? message : {};
    var content = row.content;
    if (Array.isArray(content)) {
      // A picture cannot go into a text prompt; its caption still can.
      content = content
        .filter(function (part) { return part && part.type === 'text' && typeof part.text === 'string'; })
        .map(function (part) { return part.text; })
        .join('\n');
    } else if (content === null || content === undefined) {
      content = '';
    } else if (typeof content !== 'string') {
      content = String(content);
    }
    var out = { role: typeof row.role === 'string' ? row.role : 'user', content: content };
    if (Array.isArray(row.tool_calls)) out.tool_calls = row.tool_calls;
    if (typeof row.name === 'string') out.name = row.name;
    if (typeof row.tool_call_id === 'string') out.tool_call_id = row.tool_call_id;
    return out;
  }

  function reasonFor(err) {
    var text = (err && err.message) || String(err || 'unknown error');
    return text.length > 200 ? text.slice(0, 200) + '…' : text;
  }

  /**
   * Render `messages` through `template`.
   *
   * Returns { prompt, reason }: a reason means nothing was rendered and the
   * caller should send the messages the generic way instead. It never throws.
   */
  function render(template, messages, options) {
    var opts = options || {};
    var Template = engine();
    if (!Template) return fail('the template engine is not loaded');

    var text = typeof template === 'string' ? template : '';
    if (!text.trim()) return fail('this model file carries no chat template');
    if (text.length > LIMITS.template) {
      return fail('the template is ' + text.length + ' characters long, past the ' + LIMITS.template + ' a template may be');
    }

    var list = Array.isArray(messages) ? messages : [];
    if (!list.length) return fail('there are no messages to render');
    if (list.length > LIMITS.messages) {
      return fail('this chat has ' + list.length + ' turns, past the ' + LIMITS.messages + ' one prompt may hold');
    }
    var ready = [];
    var size = 0;
    for (var i = 0; i < list.length; i += 1) {
      var row = flatten(list[i]);
      size += row.content.length;
      if (size > LIMITS.input) {
        return fail('this chat is longer than the ' + LIMITS.input + ' characters one prompt may hold');
      }
      ready.push(row);
    }

    var bomb = rangeBomb(text);
    if (bomb) return fail(bomb);

    var variables = {
      messages: ready,
      add_generation_prompt: opts.addGenerationPrompt !== false,
      bos_token: BOS,
      eos_token: EOS,
    };
    // Only when the turn offers tools: a template branches on `tools` being
    // set at all, so an empty list is not the same as none.
    if (Array.isArray(opts.tools) && opts.tools.length) variables.tools = opts.tools;

    var out;
    try {
      // A template that recurses forever ends here too: the JS stack overflows
      // and the RangeError is a refusal like any other.
      out = new Template(text).render(variables);
    } catch (err) {
      return fail('the template did not render: ' + reasonFor(err));
    }
    if (typeof out !== 'string') return fail('the template did not produce text');

    var cap = Number(opts.maxOutput) > 0 ? Number(opts.maxOutput) : LIMITS.output;
    if (out.length > cap) {
      return fail('the template rendered ' + out.length + ' characters, past the ' + cap + ' a prompt may be');
    }

    // llama-server tokenizes a prompt with its special tokens on, so it adds
    // the model's BOS itself: the template's own leading one would be a second.
    if (out.slice(0, BOS.length) === BOS) out = out.slice(BOS.length);
    if (out.indexOf(BOS) >= 0) {
      return fail('the template writes the begin-of-text token inside the prompt, which cannot be sent as text');
    }
    if (out.indexOf(EOS) >= 0) {
      return fail('the template needs the model’s end-of-sequence token, which the file’s header does not give as text');
    }
    if (!out) return fail('the template rendered nothing');
    return { prompt: out, reason: '' };
  }

  return {
    LIMITS: LIMITS,
    CACHE_KEY: CACHE_KEY,
    setEngine: setEngine,
    templateOf: templateOf,
    render: render,
    cached: cached,
    remember: remember,
    forget: forget,
  };
});
