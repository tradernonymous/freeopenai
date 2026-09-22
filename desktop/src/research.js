// Research mode (/research): the pure parts. Pure (node-tested); ChatScreen
// runs the steps and only renders what this module decides.
//
//   1. PLAN     -- the model is asked for 3-5 search queries as JSON
//                  (planMessages / parseQueries).
//   2. SEARCH   -- each query goes through the app's existing web_search tool;
//                  results are parsed back out of its text (parseSearchResults),
//                  deduped by URL and numbered [1..n] (addSources).
//   3. READ     -- the top pages go through web_fetch, capped per page and in
//                  total (pickPages, clipPage, sourcesForPrompt).
//   4. WRITE    -- the model answers ONLY from the numbered sources and cites
//                  [n] after each claim (synthesisMessages). The answer is then
//                  checked: citations to unknown numbers are stripped and
//                  paragraphs with no citation are flagged (checkCitations).
//   5. EXTRAS   -- a knowledge graph (graphMessages / parseGraph, capped to fit
//                  design/diagram-layout.js), Markdown export (exportMarkdown)
//                  and a printable page for "Save as PDF" (printHtml).
//
// When search is unavailable (no provider, offline, an older engine), research
// does not pretend: the model answers alone, is told to cite nothing, and the
// reply is labelled as having no sources (noSourcesMessages, NO_SOURCES_LABEL).
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UResearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var MIN_QUERIES = 3;
  var MAX_QUERIES = 5;
  var RESULTS_PER_QUERY = 6;
  var MAX_SOURCES = 20;
  var MAX_PAGES = 6;
  var PAGE_CHARS = 6000;
  var TOTAL_CHARS = 36000;
  var MAX_GRAPH_NODES = 9;
  var MAX_GRAPH_EDGES = 24;
  var NO_SOURCES_LABEL = 'No sources: web search was unavailable, so this answer is from the model alone and cites nothing.';

  function text(value) {
    return value == null ? '' : String(value);
  }

  function squash(value) {
    return text(value).replace(/\s+/g, ' ').trim();
  }

  function cap(value, n) {
    var s = squash(value);
    return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
  }

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /** YYYY-MM-DD in local time; a bad date falls back to today. */
  function formatDate(date) {
    var d = date instanceof Date ? date : new Date(date == null ? Date.now() : date);
    if (isNaN(d.getTime())) d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function escapeHtml(value) {
    return text(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---- JSON out of a model reply --------------------------------------------

  /** The end of the balanced {...} or [...] that starts at `start`, or -1. */
  function balancedEnd(s, start) {
    var open = s.charAt(start);
    var close = open === '{' ? '}' : ']';
    var depth = 0;
    var inString = false;
    for (var i = start; i < s.length; i += 1) {
      var c = s.charAt(i);
      if (inString) {
        if (c === '\\') i += 1;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === open) depth += 1;
      else if (c === close) {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /**
   * The first JSON value in a reply: a fenced block first, then the first
   * balanced object or array in the prose. null when there is none.
   */
  function extractJson(reply) {
    var s = text(reply).replace(/<think>[\s\S]*?(<\/think>|$)/g, '');
    var fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
    var m;
    while ((m = fence.exec(s))) {
      try { return JSON.parse(m[1].trim()); } catch { /* try the next */ }
    }
    for (var i = 0, tries = 0; i < s.length && tries < 40; i += 1) {
      var c = s.charAt(i);
      if (c !== '{' && c !== '[') continue;
      tries += 1;
      var end = balancedEnd(s, i);
      if (end < 0) continue;
      try { return JSON.parse(s.slice(i, end + 1)); } catch { /* keep looking */ }
    }
    return null;
  }

  // ---- 1. plan -----------------------------------------------------------------

  function planMessages(question, date) {
    return [
      {
        role: 'system',
        content: [
          'You plan web research. Today is ' + formatDate(date) + '.',
          'Reply with JSON only, no prose: {"queries": ["...", "..."]}',
          'Give ' + MIN_QUERIES + ' to ' + MAX_QUERIES + ' short search-engine queries that together cover the question:',
          'different angles, the key terms and names, and one for recent developments when the topic changes over time.',
        ].join('\n'),
      },
      { role: 'user', content: text(question) },
    ];
  }

  /** The queries from a plan reply (JSON anywhere in it, or a list); never empty. */
  function parseQueries(reply, question) {
    var found = extractJson(reply);
    var list = [];
    if (Array.isArray(found)) list = found;
    else if (found && Array.isArray(found.queries)) list = found.queries;
    else if (found && Array.isArray(found.searches)) list = found.searches;
    if (!list.length) {
      // No JSON: a numbered or bulleted list still says what to search for.
      text(reply).split('\n').forEach(function (line) {
        var item = /^\s*(?:[-*]|\d+[.)])\s+(.+)$/.exec(line);
        if (item) list.push(item[1].replace(/^["'`]|["'`]$/g, ''));
      });
    }
    var seen = {};
    var out = [];
    list.forEach(function (q) {
      var query = cap(typeof q === 'object' && q ? q.query || q.q || '' : q, 200);
      var key = query.toLowerCase();
      if (!query || seen[key] || out.length >= MAX_QUERIES) return;
      seen[key] = true;
      out.push(query);
    });
    var fallback = cap(question, 200);
    if (!out.length && fallback) out.push(fallback);
    return out;
  }

  // ---- 2. search and sources ---------------------------------------------------

  /** A URL's identity for deduping: host without www, no hash, no tracking, no trailing slash. '' if not http(s). */
  function normalizeUrl(url) {
    var raw = squash(url);
    if (!/^https?:\/\//i.test(raw)) return '';
    try {
      var u = new URL(raw);
      var host = u.hostname.toLowerCase().replace(/^www\./, '');
      var params = [];
      u.searchParams.forEach(function (value, key) {
        if (/^(utm_|fbclid$|gclid$|ref$|ref_src$)/i.test(key)) return;
        params.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
      });
      params.sort();
      var path = u.pathname.replace(/\/+$/, '') || '';
      return host + (u.port ? ':' + u.port : '') + path + (params.length ? '?' + params.join('&') : '');
    } catch {
      return '';
    }
  }

  /**
   * web_search's text back into rows. It writes each result as
   * "title\nurl\nsnippet" with a blank line between results.
   */
  function parseSearchResults(output) {
    var s = text(output);
    if (/^\s*(Error:|No results for)/.test(s)) return [];
    var rows = [];
    s.split(/\n\s*\n/).forEach(function (block) {
      var lines = block.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      var at = -1;
      for (var i = 0; i < lines.length; i += 1) {
        if (/^https?:\/\/\S+$/i.test(lines[i])) { at = i; break; }
      }
      if (at < 0) return;
      var url = lines[at];
      var title = lines.slice(0, at).join(' ');
      // A result with no title repeats its URL in the title's place.
      var rest = lines.slice(at + 1);
      if (!title && rest[0] === url) rest = rest.slice(1);
      rows.push({ title: cap(title || url, 200), url: url, snippet: cap(rest.join(' '), 300) });
    });
    return rows;
  }

  /**
   * `results` added to `sources`: deduped by URL, numbered after what is
   * there, each remembering which query found it and at what rank. Returns a
   * new array; at most MAX_SOURCES in all.
   */
  function addSources(sources, results, query) {
    var out = (sources || []).slice();
    var seen = {};
    out.forEach(function (src) { seen[normalizeUrl(src.url)] = true; });
    var rank = 0;
    (results || []).forEach(function (r) {
      var key = normalizeUrl(r && r.url);
      if (!key || seen[key] || out.length >= MAX_SOURCES) return;
      seen[key] = true;
      out.push({
        n: out.length + 1,
        title: cap(r.title || r.url, 200),
        url: squash(r.url),
        snippet: cap(r.snippet || '', 300),
        query: typeof query === 'number' ? query : 0,
        rank: rank,
      });
      rank += 1;
    });
    return out;
  }

  /** Which sources to read in full: each query's best first, then the next best -- at most `max`. */
  function pickPages(sources, max) {
    var limit = typeof max === 'number' ? max : MAX_PAGES;
    return (sources || []).slice().sort(function (a, b) {
      return (a.rank || 0) - (b.rank || 0) || (a.query || 0) - (b.query || 0) || a.n - b.n;
    }).slice(0, limit);
  }

  /** One page's text for the prompt: whitespace squashed, capped. '' for an error. */
  function clipPage(pageText, limit) {
    var s = text(pageText);
    if (/^\s*Error:/.test(s)) return '';
    return cap(s, typeof limit === 'number' ? limit : PAGE_CHARS);
  }

  /** The numbered sources as the model reads them, with page excerpts within TOTAL_CHARS. */
  function sourcesForPrompt(sources, pages, total) {
    var budget = typeof total === 'number' ? total : TOTAL_CHARS;
    var texts = pages || {};
    return (sources || []).map(function (src) {
      var lines = ['[' + src.n + '] ' + src.title, 'URL: ' + src.url];
      if (src.snippet) lines.push('Snippet: ' + src.snippet);
      var page = text(texts[src.n]);
      if (page && budget > 0) {
        var excerpt = page.length > budget ? page.slice(0, budget) + '…' : page;
        budget -= excerpt.length;
        lines.push('Excerpt: ' + excerpt);
      }
      return lines.join('\n');
    }).join('\n\n');
  }

  // ---- 4. write ----------------------------------------------------------------

  function synthesisMessages(question, sources, pages, date) {
    return [
      {
        role: 'system',
        content: [
          'You write a research answer. Today is ' + formatDate(date) + '.',
          'Rules:',
          '- Use ONLY the numbered sources below. Do not add facts from memory.',
          '- Cite every claim with the source number in square brackets right after it, like [2] or [1][3]. Use only numbers that exist.',
          '- When sources disagree, say so plainly and cite each side.',
          '- When the sources do not answer part of the question, say plainly that the sources do not cover it. Do not guess.',
          '- Start with a direct answer in one or two sentences, then the detail in short paragraphs or a list. Markdown is fine.',
          '- Do not write a sources or references list at the end; the app adds it.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: 'Question: ' + text(question) + '\n\nSources:\n\n' + sourcesForPrompt(sources, pages),
      },
    ];
  }

  /** Search was unavailable: the model answers alone, and cites nothing. */
  function noSourcesMessages(question, date) {
    return [
      {
        role: 'system',
        content: [
          'Web search is unavailable, so you have no sources. Today is ' + formatDate(date) + '.',
          'Answer from your own knowledge, and say at the start that no sources were consulted.',
          'Do NOT write citations like [1], and do not invent sources, links or quotes.',
          'Say plainly where your knowledge may be out of date or uncertain.',
        ].join('\n'),
      },
      { role: 'user', content: text(question) },
    ];
  }

  // Fenced code is left alone by everything that reads citations.
  function outsideFences(s, fn) {
    return text(s).split(/(```[\s\S]*?(?:```|$))/).map(function (part, i) {
      return i % 2 ? part : fn(part);
    }).join('');
  }

  // [3], [1, 2], [1;4] -- but not a Markdown link's [label](url).
  var CITE = /(\s*)\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\](?!\()/g;

  function numbersIn(group) {
    return group.split(/[,;]/).map(function (n) { return parseInt(n, 10); });
  }

  /**
   * Checks an answer's citations against `count` sources:
   *   text     -- the answer with citations to unknown numbers stripped;
   *   cited    -- the source numbers it uses;
   *   unknown  -- the numbers it used that do not exist;
   *   uncited  -- paragraphs that make claims without a citation.
   */
  function checkCitations(answer, count) {
    var total = typeof count === 'number' ? count : 0;
    var cited = {};
    var unknown = {};
    var cleaned = outsideFences(answer, function (part) {
      return part.replace(CITE, function (all, lead, group) {
        var keep = [];
        numbersIn(group).forEach(function (n) {
          if (n >= 1 && n <= total) { cited[n] = true; if (keep.indexOf(n) < 0) keep.push(n); } else unknown[n] = true;
        });
        if (!keep.length) return '';
        return lead + keep.map(function (n) { return '[' + n + ']'; }).join('');
      });
    });
    var uncited = [];
    var prose = cleaned.replace(/```[\s\S]*?(?:```|$)/g, '');
    var inSources = false;
    prose.split(/\n\s*\n/).forEach(function (para, index) {
      var p = para.trim();
      if (/^#{1,6}\s+(sources|references)\b/i.test(p)) { inSources = true; return; }
      if (inSources || !p) return;
      if (/^#{1,6}\s/.test(p) && p.indexOf('\n') < 0) return;
      if (/^(-{3,}|\*{3,})$/.test(p)) return;
      if (p.length < 60) return;
      if (/\[\d{1,3}\]/.test(p)) return;
      uncited.push({ index: index, text: cap(p, 80) });
    });
    var nums = function (o) { return Object.keys(o).map(Number).sort(function (a, b) { return a - b; }); };
    return { text: cleaned, cited: nums(cited), unknown: nums(unknown), uncited: uncited };
  }

  function safeHref(url) {
    var s = squash(url);
    if (!/^https?:\/\//i.test(s)) return '';
    return s.replace(/\s/g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
  }

  /** [n] -> [n](url) for known sources, so the renderer makes them links. */
  function linkCitations(answer, sources) {
    var byN = {};
    (sources || []).forEach(function (src) { byN[src.n] = safeHref(src.url); });
    return outsideFences(answer, function (part) {
      return part.replace(CITE, function (all, lead, group) {
        var nums = numbersIn(group);
        if (!nums.every(function (n) { return byN[n]; })) return all;
        return lead + nums.map(function (n) { return '[' + n + '](' + byN[n] + ')'; }).join('');
      });
    });
  }

  /** In rendered HTML, a link whose whole label is a number becomes a superscript citation. */
  function superscriptCitations(html) {
    return text(html).replace(/<a href="([^"]*)" target="_blank" rel="noreferrer">(\d{1,3})<\/a>/g, function (all, href, n) {
      return '<sup class="cite"><a href="' + href + '" target="_blank" rel="noreferrer" title="Source ' + n + '">' + n + '</a></sup>';
    });
  }

  // ---- 5. knowledge graph -------------------------------------------------------

  function graphMessages(question, answer) {
    var body = outsideFences(answer, function (part) { return part.replace(CITE, ''); });
    return [
      {
        role: 'system',
        content: [
          'Extract a knowledge graph of the main topics in the text.',
          'Reply with JSON only: {"nodes":[{"id":"a","label":"..."}],"edges":[{"from":"a","to":"b","label":"..."}]}',
          'At most ' + MAX_GRAPH_NODES + ' nodes: the central concepts, people, organisations or events. Labels of 1-4 words.',
          'Edges connect related nodes; each edge label is a short verb phrase (1-3 words). Only use node ids you defined.',
        ].join('\n'),
      },
      { role: 'user', content: 'Question: ' + text(question) + '\n\nText:\n' + text(body).slice(0, 8000) },
    ];
  }

  function idOf(value) {
    return squash(value).replace(/[^\w-]+/g, '_').slice(0, 32);
  }

  /**
   * The graph from a reply: at most MAX_GRAPH_NODES nodes (the rest trimmed),
   * edges only between kept nodes (by id, or by label), no duplicates.
   */
  function parseGraph(reply) {
    var found = extractJson(reply);
    var raw = found && typeof found === 'object' && !Array.isArray(found) ? found : {};
    var rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
    var nodes = [];
    var byKey = {};
    var total = 0;
    rawNodes.forEach(function (n) {
      var node = typeof n === 'string' ? { id: n, label: n } : (n || {});
      var label = cap(node.label || node.name || node.id, 40);
      var id = idOf(node.id || label);
      if (!id || byKey[id]) return;
      total += 1;
      if (nodes.length >= MAX_GRAPH_NODES) return;
      byKey[id] = id;
      byKey['label:' + label.toLowerCase()] = id;
      nodes.push({ id: id, label: label || id });
    });
    var resolve = function (ref) {
      var key = idOf(ref);
      return byKey[key] || byKey['label:' + squash(ref).toLowerCase()] || '';
    };
    var edges = [];
    var seen = {};
    (Array.isArray(raw.edges) ? raw.edges : []).forEach(function (e) {
      if (!e || edges.length >= MAX_GRAPH_EDGES) return;
      var from = resolve(e.from != null ? e.from : e.source);
      var to = resolve(e.to != null ? e.to : e.target);
      if (!from || !to || from === to) return;
      var key = from + '>' + to;
      if (seen[key]) return;
      seen[key] = true;
      var edge = { from: from, to: to };
      var label = cap(e.label || e.relation || '', 30);
      if (label) edge.label = label;
      edges.push(edge);
    });
    var trimmed = total > MAX_GRAPH_NODES;
    var message = '';
    if (!nodes.length) message = 'The model did not return a graph.';
    else if (trimmed) message = 'The graph had ' + total + ' topics; showing the first ' + MAX_GRAPH_NODES + '.';
    return { nodes: nodes, edges: edges, trimmed: trimmed, message: message };
  }

  // ---- export -----------------------------------------------------------------

  function mdEscapeLabel(value) {
    return squash(value).replace(/([[\]\\])/g, '\\$1');
  }

  /** The answer, a "Sources" list with links, and the date -- as one Markdown file. */
  function exportMarkdown(opts) {
    var o = opts || {};
    var sources = o.sources || [];
    var lines = ['# ' + squash(o.question || 'Research'), '', '_Researched ' + formatDate(o.date) + (o.model ? ' with ' + squash(o.model) : '') + '_', ''];
    if (!sources.length) lines.push('> ' + NO_SOURCES_LABEL, '');
    lines.push(text(o.answer).trim(), '');
    if (sources.length) {
      lines.push('## Sources', '');
      sources.forEach(function (src) {
        lines.push(src.n + '. [' + mdEscapeLabel(src.title || src.url) + '](' + safeHref(src.url) + ')');
      });
      lines.push('');
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  /**
   * A clean, printable page for "Save as PDF": the rendered answer (HTML the
   * caller made with the app's escaping renderer), an optional graph SVG,
   * and the sources. With `autoPrint` it opens the print dialog on load.
   */
  function printHtml(opts) {
    var o = opts || {};
    var sources = o.sources || [];
    var list = sources.map(function (src) {
      var href = safeHref(src.url);
      return '<li value="' + Number(src.n) + '"><a href="' + escapeHtml(href) + '">' + escapeHtml(src.title || src.url) + '</a><br><span class="url">' + escapeHtml(src.url) + '</span></li>';
    }).join('');
    return [
      '<!doctype html><html lang="en"><head><meta charset="utf-8">',
      '<title>' + escapeHtml(o.question || 'Research') + '</title>',
      '<style>',
      'body{font:15px/1.6 "Segoe UI",system-ui,sans-serif;color:#1b1c1a;background:#fff;max-width:720px;margin:32px auto;padding:0 24px}',
      'h1{font-size:24px;line-height:1.25;margin:0 0 4px}h2{font-size:18px;margin:28px 0 8px}h3,h4,h5,h6{font-size:16px;margin:20px 0 6px}',
      '.meta{color:#5d5f58;font-size:13px;margin:0 0 20px}.warn{border-left:3px solid #b45309;padding:6px 12px;color:#5d5f58}',
      'a{color:#2f6f4f}sup.cite{font-size:11px;line-height:0}sup.cite a{text-decoration:none}',
      'pre{background:#f6f5f1;padding:10px;white-space:pre-wrap;font-size:13px}.code-block-bar{display:none}',
      'ol.sources{font-size:13px;padding-left:24px}ol.sources .url{color:#5d5f58;word-break:break-all}',
      '.graph svg{max-width:100%;height:auto}',
      '@media print{body{margin:0 auto}a{color:inherit}}',
      '</style></head><body>',
      '<h1>' + escapeHtml(o.question || 'Research') + '</h1>',
      '<p class="meta">Researched ' + formatDate(o.date) + (o.model ? ' with ' + escapeHtml(o.model) : '') + (sources.length ? ' · ' + sources.length + ' sources' : '') + '</p>',
      sources.length ? '' : '<p class="warn">' + escapeHtml(NO_SOURCES_LABEL) + '</p>',
      '<main>' + text(o.bodyHtml) + '</main>',
      o.graphSvg ? '<h2>Knowledge graph</h2><div class="graph">' + text(o.graphSvg) + '</div>' : '',
      sources.length ? '<h2>Sources</h2><ol class="sources">' + list + '</ol>' : '',
      o.autoPrint ? '<script>setTimeout(function(){window.print();},300);</' + 'script>' : '',
      '</body></html>',
    ].join('\n');
  }

  /** The progress line: Planning -> Searching n queries -> Reading sources -> Writing. */
  function progressText(stage, info) {
    var i = info || {};
    var steps = [
      ['plan', 'Planning'],
      ['search', 'Searching ' + (i.queries || 0) + ' ' + ((i.queries || 0) === 1 ? 'query' : 'queries')],
      ['read', 'Reading ' + (i.pages || 0) + ' of ' + (i.sources || 0) + ' sources'],
      ['write', 'Writing'],
    ];
    var at = -1;
    steps.forEach(function (s, k) { if (s[0] === stage) at = k; });
    if (stage === 'done') at = steps.length;
    var line = steps.map(function (s, k) {
      if (k < at) return s[1] + ' ✓';
      if (k === at) return '**' + s[1] + '…**';
      return s[1];
    }).join(' → ');
    return '**Research** · ' + line;
  }

  return {
    MIN_QUERIES: MIN_QUERIES,
    MAX_QUERIES: MAX_QUERIES,
    RESULTS_PER_QUERY: RESULTS_PER_QUERY,
    MAX_SOURCES: MAX_SOURCES,
    MAX_PAGES: MAX_PAGES,
    PAGE_CHARS: PAGE_CHARS,
    TOTAL_CHARS: TOTAL_CHARS,
    MAX_GRAPH_NODES: MAX_GRAPH_NODES,
    NO_SOURCES_LABEL: NO_SOURCES_LABEL,
    formatDate: formatDate,
    extractJson: extractJson,
    planMessages: planMessages,
    parseQueries: parseQueries,
    normalizeUrl: normalizeUrl,
    parseSearchResults: parseSearchResults,
    addSources: addSources,
    pickPages: pickPages,
    clipPage: clipPage,
    sourcesForPrompt: sourcesForPrompt,
    synthesisMessages: synthesisMessages,
    noSourcesMessages: noSourcesMessages,
    checkCitations: checkCitations,
    linkCitations: linkCitations,
    superscriptCitations: superscriptCitations,
    graphMessages: graphMessages,
    parseGraph: parseGraph,
    exportMarkdown: exportMarkdown,
    printHtml: printHtml,
    progressText: progressText,
  };
});
