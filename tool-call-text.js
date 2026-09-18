'use strict';

// Tool calls written as text. A model whose provider does not wire native tool
// calling (or a weak free model that ignores the wiring) still tries to use
// the tools: it writes the call into its reply in whatever shape its training
// data used. Printed to the user that is a bug; parsed, it is a tool call like
// any other. Every shape the free tiers produce is read here, the span it
// occupied is remembered so the reply can be shown without it, and the caller
// decides whether the name is one of its tools.
//
// Loaded by the page as a plain script and required by the server, with no
// dependencies either way.
(function attachToolCallText(root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.NeuraOSToolCallText = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function toolCallTextFactory() {
  const TOOL_CALL_SHAPES = [
    '<tool_call>{"name": "...", "arguments": {...}}</tool_call>',
    '<function=name><parameter=key>value</parameter></function>',
    '<invoke name="..."><parameter name="key">value</parameter></invoke>',
    '[TOOL_CALLS] [{"name": "...", "arguments": {...}}]',
    '```json\n{"name": "...", "arguments": {...}}\n```',
  ];

  // Fenced code is the model showing something, not doing it: an example of a
  // tool call inside ``` is left to the reader. Only a fence marked json (or
  // unmarked) is read, and only for a JSON call.
  const FENCE = /```([\w-]*)[ \t]*\n?([\s\S]*?)```/g;

  const TOOL_CALL_TAG = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  const FUNCTION_TAG = /<function=([\w.:-]+)>([\s\S]*?)<\/function>/g;
  const FUNCTION_PARAM = /<parameter=([\w.:-]+)>([\s\S]*?)<\/parameter>/g;
  const INVOKE_TAG = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g;
  const INVOKE_PARAM = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
  const MISTRAL = /\[TOOL_CALLS\]\s*(\[[\s\S]*?\])(?=\s*(?:\[\/TOOL_CALLS\]|$))/g;
  const WRAPPERS = /<\/?(?:function_calls|tool_calls)>/g;

  // A parameter is text unless it is plainly a boolean. Numbers stay strings
  // on purpose: "2" as new_text is text, and every tool that wants a number
  // already converts what it is given.
  function coerce(value) {
    const text = String(value == null ? '' : value).replace(/^\n/, '').replace(/\n$/, '');
    if (/^(true|false)$/i.test(text.trim())) return text.trim().toLowerCase() === 'true';
    return text;
  }

  function argumentsOf(obj) {
    if (!obj || typeof obj !== 'object') return {};
    let args = obj.arguments !== undefined ? obj.arguments
      : obj.args !== undefined ? obj.args
        : obj.parameters !== undefined ? obj.parameters
          : obj.input;
    if (obj.function && typeof obj.function === 'object' && obj.function.arguments !== undefined) args = obj.function.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { args = {}; }
    }
    return args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  }

  function nameOf(obj) {
    if (!obj || typeof obj !== 'object') return '';
    if (obj.function && typeof obj.function === 'object' && obj.function.name) return String(obj.function.name);
    if (typeof obj.function === 'string') return obj.function;
    return String(obj.name || obj.tool || obj.tool_name || '');
  }

  function callFromJson(source) {
    let parsed;
    try { parsed = JSON.parse(source); } catch { return []; }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((obj) => ({ name: nameOf(obj).trim(), arguments: argumentsOf(obj) })).filter((c) => c.name);
  }

  function paramsOf(body, pattern) {
    const out = {};
    for (const m of body.matchAll(pattern)) out[m[1]] = coerce(m[2]);
    return out;
  }

  // The reply split into prose and fenced code, each piece knowing where it
  // sits in the original so a match can be cut out later.
  function segments(text) {
    const out = [];
    let last = 0;
    for (const m of text.matchAll(FENCE)) {
      if (m.index > last) out.push({ fence: false, text: text.slice(last, m.index), offset: last });
      out.push({ fence: true, lang: (m[1] || '').toLowerCase(), body: m[2], text: m[0], offset: m.index });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ fence: false, text: text.slice(last), offset: last });
    return out;
  }

  function scan(text) {
    const source = String(text == null ? '' : text);
    const calls = [];
    const spans = [];
    const add = (found, start, end) => {
      for (const call of found) calls.push(call);
      if (found.length) spans.push([start, end]);
    };
    for (const seg of segments(source)) {
      if (seg.fence) {
        if (seg.lang === '' || seg.lang === 'json') add(callFromJson(seg.body.trim()), seg.offset, seg.offset + seg.text.length);
        continue;
      }
      const prose = seg.text;
      const taken = [];
      const free = (start, end) => !taken.some(([a, b]) => start < b && end > a);
      const claim = (m, found) => {
        const start = seg.offset + m.index;
        const end = start + m[0].length;
        if (!found.length || !free(m.index, m.index + m[0].length)) return;
        taken.push([m.index, m.index + m[0].length]);
        add(found, start, end);
      };
      for (const m of prose.matchAll(TOOL_CALL_TAG)) {
        const inner = m[1];
        const nested = [...inner.matchAll(FUNCTION_TAG)].map((f) => ({ name: f[1], arguments: paramsOf(f[2], FUNCTION_PARAM) }));
        claim(m, nested.length ? nested : callFromJson(inner));
      }
      for (const m of prose.matchAll(FUNCTION_TAG)) claim(m, [{ name: m[1], arguments: paramsOf(m[2], FUNCTION_PARAM) }]);
      for (const m of prose.matchAll(INVOKE_TAG)) claim(m, [{ name: m[1], arguments: paramsOf(m[2], INVOKE_PARAM) }]);
      for (const m of prose.matchAll(MISTRAL)) claim(m, callFromJson(m[1]));
    }
    return { calls, spans };
  }

  /** Every tool call written into the text, in order: [{ name, arguments }]. */
  function parseToolCallText(text) {
    return scan(text).calls;
  }

  /** The text with its tool-call blocks (and their wrapper tags) removed. */
  function stripToolCallText(text) {
    const source = String(text == null ? '' : text);
    const { spans } = scan(source);
    if (!spans.length) return source;
    let out = '';
    let last = 0;
    for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) {
      out += source.slice(last, start);
      last = end;
    }
    out += source.slice(last);
    return out.replace(WRAPPERS, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  return { TOOL_CALL_SHAPES, parseToolCallText, stripToolCallText };
});
