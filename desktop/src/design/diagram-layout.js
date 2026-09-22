// The diagram artifact type: the model sends a graph, not a picture.
//
//   {"nodes":[{"id":"api","label":"API","group":"core"}],
//    "edges":[{"from":"api","to":"db","label":"reads"}]}
//
// and the drawing is done here, deterministically, so every diagram follows
// the same house rules whatever model made it:
//   * layered left to right (longest-path layering, then a few barycentre
//     sweeps to untangle the order inside each layer; a cycle's back edge is
//     routed underneath instead of breaking the layering);
//   * orthogonal connectors whose bends are rounded at r=8;
//   * at most MAX_NODES nodes -- a bigger graph is trimmed, with a message
//     saying so, because a diagram nobody can read at a glance is a table;
//   * one or two accent colours (by group), no shadows, no gradients.
// Mermaid flowchart text (A-->B, A[Label], A-- text -->B, A-->|text|B) is
// parsed into the same graph, so an imported diagram is redrawn the same way.
//
// UMD (see chats.js); pure string and number work, node-tested.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UDiagramLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var MAX_NODES = 9;
  var MAX_EDGES = 24;
  var RADIUS = 8;
  var NODE_H = 48;
  var MIN_W = 112;
  var MAX_W = 220;
  var LAYER_GAP = 96;
  var ROW_GAP = 32;
  var PAD = 32;
  var SCRIPT_TYPE = 'application/neura-diagram+json';

  function text(value) {
    return String(value == null ? '' : value);
  }

  function esc(value) {
    return text(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function idOf(value) {
    return text(value).trim().replace(/[^\w-]+/g, '_').slice(0, 32);
  }

  // ---- the graph -------------------------------------------------------------

  /**
   * A graph made safe to draw: ids cleaned and unique, labels short, edges
   * only between known nodes, and at most MAX_NODES nodes (the rest trimmed,
   * with `message` saying what was left out).
   */
  function normalize(raw) {
    var src = raw;
    if (typeof src === 'string') {
      try { src = JSON.parse(src); } catch { return { nodes: [], edges: [], trimmed: false, message: 'That is not diagram JSON.' }; }
    }
    src = src && typeof src === 'object' ? src : {};
    var nodes = [];
    var seen = {};
    (Array.isArray(src.nodes) ? src.nodes : []).forEach(function (n) {
      var node = n && typeof n === 'object' ? n : { id: n };
      var id = idOf(node.id != null ? node.id : node.label);
      if (!id || seen[id]) return;
      seen[id] = true;
      var out = { id: id, label: text(node.label != null ? node.label : node.id).replace(/\s+/g, ' ').trim().slice(0, 40) || id };
      if (node.group != null && text(node.group).trim()) out.group = text(node.group).trim().slice(0, 24);
      nodes.push(out);
    });
    var total = nodes.length;
    var trimmed = total > MAX_NODES;
    if (trimmed) nodes = nodes.slice(0, MAX_NODES);
    var kept = {};
    nodes.forEach(function (n) { kept[n.id] = true; });
    var edges = [];
    var pairs = {};
    (Array.isArray(src.edges) ? src.edges : []).forEach(function (e) {
      if (!e || typeof e !== 'object') return;
      var from = idOf(e.from != null ? e.from : e.source);
      var to = idOf(e.to != null ? e.to : e.target);
      if (!kept[from] || !kept[to] || from === to || pairs[from + '>' + to] || edges.length >= MAX_EDGES) return;
      pairs[from + '>' + to] = true;
      var edge = { from: from, to: to };
      if (e.label != null && text(e.label).trim()) edge.label = text(e.label).replace(/\s+/g, ' ').trim().slice(0, 32);
      edges.push(edge);
    });
    var message = '';
    if (trimmed) message = 'The diagram had ' + total + ' nodes; drew the first ' + MAX_NODES + '. Split it in two or group related nodes.';
    else if (!nodes.length) message = 'The diagram has no nodes.';
    return { nodes: nodes, edges: edges, trimmed: trimmed, message: message };
  }

  /** The graph in a model reply: a <diagram> block, a fenced JSON or Mermaid block, or bare JSON. */
  function extractGraph(reply) {
    var src = text(reply);
    var tagged = /<diagram[^>]*>([\s\S]*?)(<\/diagram>|$)/i.exec(src);
    var body = tagged ? tagged[1] : src;
    var mermaid = /```mermaid\s*([\s\S]*?)```/i.exec(body);
    if (mermaid) return normalize(parseMermaid(mermaid[1]));
    var fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(body);
    if (fenced) body = fenced[1];
    var start = body.indexOf('{');
    var end = body.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return normalize(JSON.parse(body.slice(start, end + 1))); } catch { /* fall through */ }
    }
    if (/^\s*(graph|flowchart)\b/im.test(body)) return normalize(parseMermaid(body));
    return null;
  }

  // ---- Mermaid import --------------------------------------------------------

  var NODE_RE = /^\s*([A-Za-z0-9_]+)\s*(?:\(\(([^)]*)\)\)|\(\[([^\]]*)\]\)|\[\[([^\]]*)\]\]|\[\(([^)]*)\)\]|\[([^\]]*)\]|\(([^)]*)\)|\{\{([^}]*)\}\}|\{([^}]*)\}|>([^\]]*)\])?/;
  // Labelled forms first ("A-- text -->B"), then the bare arrows; an optional
  // |text| after any of them is also a label.
  var ARROW_RE = /^\s*(?:--\s*([^|>-][^>]*?)\s*-->|==\s*([^=>][^>]*?)\s*==>|-\.\s*([^.>][^>]*?)\s*\.->|-\.->|-->|---|==>|--[xo]|<-->)\s*(?:\|([^|]*)\|)?/;

  function unquote(value) {
    return text(value).trim().replace(/^["']|["']$/g, '').trim();
  }

  /** Mermaid flowchart text -> {nodes, edges} (the basic forms; the rest is skipped). */
  function parseMermaid(source) {
    var nodes = [];
    var index = {};
    var edges = [];
    function node(id, label) {
      if (!(id in index)) { index[id] = nodes.length; nodes.push({ id: id, label: label || id, named: !!label }); }
      else if (label && !nodes[index[id]].named) { nodes[index[id]].label = label; nodes[index[id]].named = true; }
      return id;
    }
    function readNode(s) {
      var m = NODE_RE.exec(s);
      if (!m) return null;
      var label = null;
      for (var i = 2; i < m.length; i += 1) if (m[i] != null) { label = unquote(m[i]); break; }
      return { id: node(m[1], label), rest: s.slice(m[0].length) };
    }
    text(source).split(/\r?\n|;/).forEach(function (line) {
      var s = line.replace(/%%.*$/, '').trim();
      if (!s || /^(graph|flowchart)\b/i.test(s) || /^(classDef|class|style|linkStyle|click|subgraph|end|direction)\b/i.test(s)) return;
      var first = readNode(s);
      if (!first) return;
      var prev = first.id;
      var rest = first.rest;
      var guard = 0;
      while (rest.trim() && guard < 32) {
        guard += 1;
        var arrow = ARROW_RE.exec(rest);
        if (!arrow) break;
        var next = readNode(rest.slice(arrow[0].length));
        if (!next) break;
        var label = unquote(arrow[1] || arrow[2] || arrow[3] || arrow[4] || '');
        edges.push(label ? { from: prev, to: next.id, label: label } : { from: prev, to: next.id });
        prev = next.id;
        rest = next.rest;
      }
    });
    return {
      nodes: nodes.map(function (n) { return { id: n.id, label: n.label }; }),
      edges: edges,
    };
  }

  // ---- layout ----------------------------------------------------------------

  function widthOf(label) {
    return Math.max(MIN_W, Math.min(MAX_W, Math.round(text(label).length * 7.5 + 40)));
  }

  /**
   * Positions for a normalised graph: {width, height, nodes:[{id,label,group,
   * layer,order,x,y,w,h}], edges:[{from,to,label,back,points}]}.
   */
  function layout(graph) {
    var g = graph && Array.isArray(graph.nodes) ? graph : normalize(graph);
    var ids = g.nodes.map(function (n) { return n.id; });
    var byId = {};
    g.nodes.forEach(function (n, i) { byId[n.id] = { id: n.id, label: n.label, group: n.group, first: i }; });
    var out = {};
    ids.forEach(function (id) { out[id] = []; });
    g.edges.forEach(function (e, i) { if (out[e.from] && byId[e.to]) out[e.from].push({ to: e.to, i: i }); });

    // Back edges: the ones a depth-first walk (in document order) finds
    // pointing at a node still on its stack. Without them the graph is a DAG.
    var state = {};
    var back = {};
    function walk(id) {
      state[id] = 1;
      out[id].forEach(function (e) {
        if (state[e.to] === 1) back[e.i] = true;
        else if (!state[e.to]) walk(e.to);
      });
      state[id] = 2;
    }
    ids.forEach(function (id) { if (!state[id]) walk(id); });

    // Longest-path layering over the forward edges (Kahn order).
    var indeg = {};
    var layer = {};
    ids.forEach(function (id) { indeg[id] = 0; layer[id] = 0; });
    g.edges.forEach(function (e, i) { if (!back[i]) indeg[e.to] += 1; });
    var queue = ids.filter(function (id) { return !indeg[id]; });
    while (queue.length) {
      var id = queue.shift();
      out[id].forEach(function (e) {
        if (back[e.i]) return;
        layer[e.to] = Math.max(layer[e.to], layer[id] + 1);
        indeg[e.to] -= 1;
        if (!indeg[e.to]) queue.push(e.to);
      });
    }
    var layers = [];
    ids.forEach(function (id) {
      (layers[layer[id]] = layers[layer[id]] || []).push(id);
    });
    layers = layers.filter(Boolean);

    // Order inside a layer: barycentre of the neighbours in the layer before,
    // then after; ties keep document order. Four sweeps settle nine nodes.
    var pos = {};
    function place() { layers.forEach(function (row) { row.forEach(function (nid, i) { pos[nid] = i; }); }); }
    place();
    function bary(nid, useIn) {
      var ns = [];
      g.edges.forEach(function (e, i) {
        if (back[i]) return;
        if (useIn && e.to === nid) ns.push(pos[e.from]);
        if (!useIn && e.from === nid) ns.push(pos[e.to]);
      });
      return ns.length ? ns.reduce(function (a, b) { return a + b; }, 0) / ns.length : pos[nid];
    }
    for (var sweep = 0; sweep < 4; sweep += 1) {
      var down = sweep % 2 === 0;
      var order = down ? layers.map(function (_, i) { return i; }) : layers.map(function (_, i) { return layers.length - 1 - i; });
      order.forEach(function (li) {
        if ((down && li === 0) || (!down && li === layers.length - 1)) return;
        var keyed = layers[li].map(function (nid) { return { id: nid, k: bary(nid, down), f: byId[nid].first }; });
        keyed.sort(function (a, b) { return a.k - b.k || a.f - b.f; });
        layers[li] = keyed.map(function (x) { return x.id; });
        place();
      });
    }

    // Coordinates: columns as wide as their widest node, rows centred.
    var colW = layers.map(function (row) { return Math.max.apply(null, row.map(function (nid) { return widthOf(byId[nid].label); })); });
    var tallest = Math.max.apply(null, layers.map(function (row) { return row.length; }).concat([1]));
    var innerH = tallest * NODE_H + (tallest - 1) * ROW_GAP;
    var x = PAD;
    var placed = {};
    var colX = [];
    layers.forEach(function (row, li) {
      colX[li] = x;
      var rowH = row.length * NODE_H + (row.length - 1) * ROW_GAP;
      var y0 = PAD + (innerH - rowH) / 2;
      row.forEach(function (nid, i) {
        var n = byId[nid];
        var w = widthOf(n.label);
        placed[nid] = { id: nid, label: n.label, group: n.group, layer: li, order: i, x: x + (colW[li] - w) / 2, y: y0 + i * (NODE_H + ROW_GAP), w: w, h: NODE_H };
      });
      x += colW[li] + LAYER_GAP;
    });
    var width = Math.max(PAD * 2, x - LAYER_GAP + PAD);
    var bottom = PAD + innerH;

    // Connectors. A forward edge leaves the right side, turns in the channel
    // between the columns (each edge from a column gets its own lane so they
    // do not overlap) and enters the left side. A back edge (or one within a
    // layer) drops below the drawing, runs back and rises into the target.
    // An edge that skips layers turns in the channel after its source AND the
    // one before its target, crossing the columns between on a row that no
    // node sits on (its own row if free, else a gap between rows, else a lane
    // above the drawing).
    var lanes = {};
    var laneCount = {};
    function forward(e, i) {
      return !back[i] && placed[e.from] && placed[e.to] && placed[e.to].layer > placed[e.from].layer;
    }
    g.edges.forEach(function (e, i) {
      if (!forward(e, i)) return;
      var la = placed[e.from].layer;
      var lb = placed[e.to].layer - 1;
      laneCount[la] = (laneCount[la] || 0) + 1;
      if (lb !== la) laneCount[lb] = (laneCount[lb] || 0) + 1;
    });
    function laneX(li) {
      var k = lanes[li] = (lanes[li] || 0) + 1;
      var n = laneCount[li] || 1;
      var channel = PAD + colW.slice(0, li + 1).reduce(function (s, w) { return s + w; }, 0) + LAYER_GAP * li;
      var spread = Math.min(12, (LAYER_GAP - 2 * (RADIUS + 8)) / Math.max(1, n));
      return channel + LAYER_GAP / 2 + (k - (n + 1) / 2) * spread;
    }
    var rowsBetween = function (la, lb) {
      return ids.map(function (nid) { return placed[nid]; }).filter(function (p) { return p.layer > la && p.layer < lb; });
    };
    var over = 0;
    var under = 0;
    var edges = g.edges.map(function (e, i) {
      var a = placed[e.from];
      var b = placed[e.to];
      var points;
      var isBack = !forward(e, i);
      if (!isBack) {
        var sx = a.x + a.w;
        var sy = a.y + a.h / 2;
        var tx = b.x;
        var ty = b.y + b.h / 2;
        var m1 = laneX(a.layer);
        if (b.layer === a.layer + 1) {
          points = Math.abs(sy - ty) < 0.5 ? [[sx, sy], [tx, ty]] : [[sx, sy], [m1, sy], [m1, ty], [tx, ty]];
        } else {
          var m2 = laneX(b.layer - 1);
          var blockers = rowsBetween(a.layer, b.layer);
          var free = function (y) { return blockers.every(function (p) { return y < p.y - 6 || y > p.y + p.h + 6; }); };
          var candidates = [sy, ty];
          blockers.forEach(function (p) { candidates.push(p.y - ROW_GAP / 2, p.y + p.h + ROW_GAP / 2); });
          var best = null;
          candidates.forEach(function (y) {
            if (!free(y)) return;
            if (best === null || Math.abs(y - sy) + Math.abs(y - ty) < Math.abs(best - sy) + Math.abs(best - ty)) best = y;
          });
          if (best === null) { over += 1; best = PAD - 12 * over; }
          if (best === sy) points = [[sx, sy], [m2, sy], [m2, ty], [tx, ty]];
          else if (best === ty) points = [[sx, sy], [m1, sy], [m1, ty], [tx, ty]];
          else points = [[sx, sy], [m1, sy], [m1, best], [m2, best], [m2, ty], [tx, ty]];
          if (Math.abs(sy - ty) < 0.5 && best === sy) points = [[sx, sy], [tx, ty]];
        }
      } else {
        // Only through channels, never across a node: out of the source's
        // right side into the channel after its column, down to a lane under
        // the drawing, back to the channel before the target's column, up,
        // and into the target's left side.
        under += 1;
        var lane = bottom + 24 + under * 12;
        var off = (under - 1) * 6;
        var right = colX[a.layer] + colW[a.layer] + (a.layer === layers.length - 1 ? PAD / 2 : LAYER_GAP / 2 - 12) - off;
        var left = b.layer === 0 ? colX[0] - PAD / 2 + off : colX[b.layer] - LAYER_GAP / 2 + 12 + off;
        var sy2 = a.y + a.h / 2;
        var ty2 = b.y + b.h / 2;
        points = [[a.x + a.w, sy2], [right, sy2], [right, lane], [left, lane], [left, ty2], [b.x, ty2]];
      }
      var edge = { from: e.from, to: e.to, back: isBack, points: points.map(function (p) { return [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]; }) };
      if (e.label) edge.label = e.label;
      return edge;
    });
    var height = bottom + PAD + (under ? 24 + under * 12 : 0);
    // Lanes above the drawing may leave the top padding: shift everything down.
    var shiftY = over ? Math.max(0, 12 - (PAD - 12 * over)) : 0;
    if (shiftY) {
      ids.forEach(function (nid) { placed[nid].y += shiftY; });
      edges.forEach(function (e) { e.points = e.points.map(function (p) { return [p[0], p[1] + shiftY]; }); });
      height += shiftY;
    }
    return {
      width: Math.round(width),
      height: Math.round(height),
      nodes: ids.map(function (nid) { return placed[nid]; }),
      edges: edges,
    };
  }

  /** An orthogonal polyline as an SVG path, every bend an arc of radius r. */
  function roundedPath(points, r) {
    var radius = r == null ? RADIUS : r;
    var pts = (points || []).filter(function (p, i, all) { return !i || p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]; });
    if (!pts.length) return '';
    var d = 'M' + pts[0][0] + ' ' + pts[0][1];
    for (var i = 1; i < pts.length - 1; i += 1) {
      var p0 = pts[i - 1];
      var p1 = pts[i];
      var p2 = pts[i + 1];
      var d1x = Math.sign(p1[0] - p0[0]);
      var d1y = Math.sign(p1[1] - p0[1]);
      var d2x = Math.sign(p2[0] - p1[0]);
      var d2y = Math.sign(p2[1] - p1[1]);
      var len1 = Math.abs(p1[0] - p0[0]) + Math.abs(p1[1] - p0[1]);
      var len2 = Math.abs(p2[0] - p1[0]) + Math.abs(p2[1] - p1[1]);
      var rr = Math.min(radius, len1 / 2, len2 / 2);
      var bx = p1[0] - d1x * rr;
      var by = p1[1] - d1y * rr;
      var ax = p1[0] + d2x * rr;
      var ay = p1[1] + d2y * rr;
      // Screen coordinates (y down): a positive cross product turns clockwise.
      var sweep = d1x * d2y - d1y * d2x > 0 ? 1 : 0;
      d += ' L' + round(bx) + ' ' + round(by);
      if (rr > 0) d += ' A' + round(rr) + ' ' + round(rr) + ' 0 0 ' + sweep + ' ' + round(ax) + ' ' + round(ay);
    }
    var last = pts[pts.length - 1];
    return d + ' L' + last[0] + ' ' + last[1];
  }

  function round(n) {
    return Math.round(n * 10) / 10;
  }

  // ---- drawing ---------------------------------------------------------------

  var DEFAULTS = { paper: '#f6f5f1', ink: '#1b1c1a', muted: '#5d5f58', line: '#dcdad3', accent: '#2f6f4f', accent2: '', font: "'Segoe UI', system-ui, sans-serif" };

  /**
   * The drawing as SVG. Colours go through the page's tokens -- var(--accent,
   * fallback) -- so it follows Tweaks inside a page and still renders alone.
   * Groups take the accent (first group) and --accent-2 (second); any further
   * group is drawn neutral, so a diagram never has more than two accents.
   */
  function toSvg(graph, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    var lay = graph && graph.width && graph.edges && graph.nodes && graph.nodes[0] && graph.nodes[0].w ? graph : layout(graph);
    var groups = [];
    lay.nodes.forEach(function (n) { if (n.group && groups.indexOf(n.group) < 0) groups.push(n.group); });
    var accent2 = o.accent2 || o.accent;
    var style = [
      '.dg-node{fill:var(--paper,' + o.paper + ');stroke:var(--line,' + o.line + ');stroke-width:1.5}',
      '.dg-a1{stroke:var(--accent,' + o.accent + ');stroke-width:2}',
      '.dg-a2{stroke:var(--accent-2,' + accent2 + ');stroke-width:2}',
      '.dg-label{fill:var(--ink,' + o.ink + ');font:500 14px var(--font-body,' + o.font.replace(/"/g, "'") + ')}',
      '.dg-edge{fill:none;stroke:var(--muted,' + o.muted + ');stroke-width:1.5}',
      '.dg-head{fill:var(--muted,' + o.muted + ')}',
      '.dg-elabel{fill:var(--muted,' + o.muted + ');font:12px var(--font-body,' + o.font.replace(/"/g, "'") + ')}',
      '.dg-ebg{fill:var(--paper,' + o.paper + ')}',
    ].join('');
    var parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + lay.width + ' ' + lay.height + '" width="' + lay.width + '" height="' + lay.height + '" role="img" aria-label="' + esc(o.title || 'Diagram') + '">');
    parts.push('<style>' + style + '</style>');
    parts.push('<defs><marker id="dg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path class="dg-head" d="M0 0 L10 5 L0 10 z"/></marker></defs>');
    lay.edges.forEach(function (e) {
      parts.push('<path class="dg-edge" d="' + roundedPath(e.points, RADIUS) + '" marker-end="url(#dg-arrow)"/>');
    });
    lay.edges.forEach(function (e) {
      if (!e.label) return;
      // On the longest segment, where there is room for it.
      var best = 0;
      var at = [e.points[0][0], e.points[0][1]];
      for (var i = 1; i < e.points.length; i += 1) {
        var p = e.points[i - 1];
        var q = e.points[i];
        var len = Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]);
        if (len > best) { best = len; at = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; }
      }
      var w = Math.round(e.label.length * 6.6 + 12);
      parts.push('<rect class="dg-ebg" x="' + round(at[0] - w / 2) + '" y="' + round(at[1] - 10) + '" width="' + w + '" height="20" rx="4"/>');
      parts.push('<text class="dg-elabel" x="' + round(at[0]) + '" y="' + round(at[1] + 4) + '" text-anchor="middle">' + esc(e.label) + '</text>');
    });
    lay.nodes.forEach(function (n) {
      var gi = n.group ? groups.indexOf(n.group) : -1;
      var cls = 'dg-node' + (gi === 0 ? ' dg-a1' : gi === 1 ? ' dg-a2' : '');
      parts.push('<g><rect class="' + cls + '" x="' + round(n.x) + '" y="' + round(n.y) + '" width="' + n.w + '" height="' + n.h + '" rx="' + RADIUS + '"/>');
      parts.push('<text class="dg-label" x="' + round(n.x + n.w / 2) + '" y="' + round(n.y + n.h / 2 + 5) + '" text-anchor="middle">' + esc(n.label) + '</text></g>');
    });
    parts.push('</svg>');
    return parts.join('');
  }

  /**
   * A whole page around the drawing, tokens in :root, the graph itself kept
   * in a data block so the diagram can be read back and redrawn.
   */
  function toPage(graph, opts) {
    var o = opts || {};
    var g = normalize(graph);
    var tokens = Object.assign({ '--paper': DEFAULTS.paper, '--ink': DEFAULTS.ink, '--muted': DEFAULTS.muted, '--line': DEFAULTS.line, '--accent': DEFAULTS.accent, '--font-display': 'Georgia, serif', '--font-body': DEFAULTS.font, '--space': '8px' }, o.tokens || {});
    if (!tokens['--accent-2']) tokens['--accent-2'] = tokens['--ink'];
    var root = Object.keys(tokens).filter(function (k) { return /^--[\w-]+$/.test(k); }).map(function (k) { return k + ':' + text(tokens[k]).replace(/[;{}<]/g, ''); }).join(';');
    var title = text(o.title || 'Diagram').slice(0, 80);
    var schema = {
      version: 1,
      controls: [
        { var: '--accent', label: 'Accent', type: 'color', default: /^#[0-9a-f]{6}$/i.test(tokens['--accent']) ? tokens['--accent'] : DEFAULTS.accent },
        { var: '--accent-2', label: 'Second accent', type: 'color', default: /^#[0-9a-f]{6}$/i.test(tokens['--accent-2']) ? tokens['--accent-2'] : DEFAULTS.ink },
        { var: '--diagram-width', label: 'Width', type: 'slider', min: 40, max: 100, step: 5, unit: '%', default: 100 },
      ],
    };
    var data = JSON.stringify({ nodes: g.nodes, edges: g.edges }).replace(/</g, '\\u003c');
    return [
      '<!DOCTYPE html>',
      '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>' + esc(title) + '</title>',
      '<style>:root{' + root + '}',
      'body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--font-body)}',
      'main{padding:calc(var(--space) * 6) calc(var(--space) * 4);max-width:1200px;margin:0 auto}',
      'h1{font-family:var(--font-display);font-weight:600;font-size:1.563rem;margin:0 0 calc(var(--space) * 3)}',
      'figure{margin:0}figure svg{width:var(--diagram-width, 100%);height:auto;display:block}',
      '/* neura-tweaks:start */:root{--diagram-width:100%;}/* neura-tweaks:end */</style>',
      '<script type="application/neura-tweaks+json">' + JSON.stringify(schema) + '</' + 'script>',
      '<script type="' + SCRIPT_TYPE + '">' + data + '</' + 'script>',
      '</head><body><main><h1>' + esc(title) + '</h1><figure>' + toSvg(g, { title: title }) + '</figure></main></body></html>',
    ].join('\n');
  }

  /** The graph a diagram page carries, normalised -- or null for any other page. */
  function graphFromHtml(html) {
    var m = new RegExp('<script type="' + SCRIPT_TYPE.replace(/[+.]/g, '\\$&') + '">([\\s\\S]*?)<\\/script>', 'i').exec(text(html));
    if (!m) return null;
    try { return normalize(JSON.parse(m[1])); } catch { return null; }
  }

  return {
    MAX_NODES: MAX_NODES,
    RADIUS: RADIUS,
    SCRIPT_TYPE: SCRIPT_TYPE,
    normalize: normalize,
    extractGraph: extractGraph,
    parseMermaid: parseMermaid,
    layout: layout,
    roundedPath: roundedPath,
    toSvg: toSvg,
    toPage: toPage,
    graphFromHtml: graphFromHtml,
  };
});
