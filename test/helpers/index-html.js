// Shared harness for testing index.html's wiring.
//
// That page has no DOM test setup, so the functions under test are pulled out by
// text and run against stubs -- which is how shipped behaviour gets checked
// rather than described. This module owns the extraction so no test file has to
// re-implement it, along with the two guards that catch an extraction which has
// silently stopped testing what it claims to.
//
// Note: Node's runner loads every .js under test/ as a test file, so this counts
// as one extra passing file. It defines no tests.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', '..', 'style.css'), 'utf8');
const HUB_CSS = fs.readFileSync(path.join(__dirname, '..', '..', 'hub.css'), 'utf8');

// The source of a named function, from `function` through its closing brace.
function sourceOf(name) {
  const start = HTML.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `index.html no longer defines ${name}() -- re-point this test`);
  // Walk past the parameter list first: a default such as `extra = {}` contains
  // a brace that would otherwise read as the body opening.
  let params = 0;
  let i = HTML.indexOf('(', start);
  for (; i < HTML.length; i++) {
    if (HTML[i] === '(') params++;
    else if (HTML[i] === ')' && !--params) break;
  }
  let depth = 0;
  i = HTML.indexOf('{', i);
  let quote = null;
  for (; i < HTML.length; i++) {
    const ch = HTML[i];
    const next = HTML[i + 1];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { i = HTML.indexOf('\n', i); if (i === -1) break; continue; }
    if (ch === '/' && next === '*') { i = HTML.indexOf('*/', i); if (i === -1) break; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && !--depth) return HTML.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces while reading ${name}()`);
}

// Keep the `async` keyword that precedes the declaration.
function declarationOf(name) {
  const start = HTML.indexOf(`function ${name}(`);
  const asyncPrefix = HTML.slice(Math.max(0, start - 6), start).endsWith('async ') ? 'async ' : '';
  return asyncPrefix + sourceOf(name);
}

// The page's functions close over page-scope variables. `with` resolves those
// reads and, more usefully, makes an assignment such as `selectedModel = next`
// land back on the deps object, so a test can watch it move.
function loadFromIndex(names, deps) {
  const body = names.map(declarationOf).join('\n') + `\nreturn { ${names.join(', ')} };`;
  return new Function('deps', `with (deps) {\n${body}\n}`)(deps);
}

// Source with comments and string literals removed, for the two guards below:
// prose such as "Request failed (" otherwise reads as a call to `failed`.
function codeOnly(source) {
  return String(source)
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

// Names that are fair game to resolve outside the sandbox.
const BUILTINS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'await', 'async', 'function',
  'delete', 'void', 'in', 'of', 'do', 'else', 'throw', 'yield', 'instanceof', 'super', 'this', 'case',
  'Error', 'JSON', 'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Math', 'RegExp', 'Date',
  'Map', 'Set', 'WeakMap', 'TypeError', 'RangeError', 'Symbol', 'parseInt', 'parseFloat', 'isNaN',
  'Infinity', 'NaN', 'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'clearTimeout', 'globalThis',
  // Globals in both the browser and Node, so `with` falls through to them.
  'TextDecoder', 'TextEncoder', 'Buffer', 'URL', 'URLSearchParams', 'AbortController', 'fetch',
  'btoa', 'atob', 'Blob', 'Uint8Array', 'ArrayBuffer',
]);

// The names one or more extracted functions would look for outside their own
// body: locals and keywords are excluded, so anything left is a dependency.
function referencedPageNames(names) {
  const sources = codeOnly(names.map(sourceOf).join('\n'));
  const declared = new Set(
    [...sources.matchAll(/(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
  );
  // Parameters of nested functions and arrows are locals too. Without this, a
  // Promise executor's `resolve` read as a page-scope name the sandbox was
  // missing -- and the only fix at the call site was to pass a stub that the
  // real function's own parameter shadows, which documents nothing.
  // Deliberately not matching `if (...) {`: a condition's identifier may well be
  // page scope, and treating it as a local would blind the guard.
  for (const m of sources.matchAll(/function\s*[\w$]*\s*\(([^()]*)\)|\(([^()]*)\)\s*=>/g)) {
    for (const param of (m[1] || m[2] || '').split(',')) {
      const name = param.trim().replace(/=.*$/, '').replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
    }
  }
  // A leading dot means a method call (`.drawImage(`), which is not page scope.
  const called = [...sources.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
  return [...new Set(called)].filter((n) => !declared.has(n) && !BUILTINS.has(n));
}

// Guards, called once per test file.
//
// The scanner cannot read a template literal, so it refuses to guess: a real one
// inside the extracted code would silently test the wrong slice.
function assertScannerCanRead(names) {
  for (const name of names) {
    assert.equal(codeOnly(sourceOf(name)).includes('`'), false, `${name}() gained a template literal -- sourceOf needs updating`);
  }
}

// A page-scope name missing from the sandbox does not fail loudly: it throws a
// ReferenceError that the function under test may catch, so the test sees a
// plausible empty result instead. Deriving the names makes that impossible.
function assertSandboxCovers(names, deps) {
  const missing = referencedPageNames(names).filter((n) => !(n in deps));
  assert.deepEqual(missing, [], `these page-scope names are missing from the sandbox: ${missing.join(', ')}`);
}

module.exports = {
  HTML,
  CSS,
  HUB_CSS,
  sourceOf,
  declarationOf,
  loadFromIndex,
  codeOnly,
  referencedPageNames,
  assertScannerCanRead,
  assertSandboxCovers,
};
