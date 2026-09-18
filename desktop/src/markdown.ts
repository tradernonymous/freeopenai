// Chat markdown rendering, without a markdown dependency.
//
// The scale is deliberate: chat replies are prose with code fences, a few
// headings, lists and links. A dependency-free renderer covers exactly that
// and stays auditable -- every character of model output passes through
// escapeHtml before any tag is ever emitted, so a reply can never inject
// markup into the app.

export function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(text: string): string {
  let out = escapeHtml(text);
  // `code` first, so its content is protected from the other rules.
  out = out.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  // [label](url) -- only http(s), and the URL is attribute-escaped.
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label: string, url: string) => {
    return `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`;
  });
  // **bold** then *italic*.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>');
  return out;
}

/** Renders one fenced block. The body is escaped, never trusted. */
function codeBlock(lang: string, body: string): string {
  const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
  return (
    `<div class="code-block">` +
    `<div class="code-block-bar">${langLabel}<button class="code-copy" type="button">Copy</button></div>` +
    `<pre><code>${escapeHtml(body)}</code></pre>` +
    `</div>`
  );
}

/** Markdown -> HTML for a chat reply. Throws on nothing; bad input renders as text. */
export function renderMarkdown(source: string): string {
  const text = String(source || '');
  const lines = text.split('\n');
  const html: string[] = [];
  let i = 0;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      html.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    // fenced code block
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      flushPara();
      const lang = fence[1] || '';
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // the closing fence (or end of input)
      html.push(codeBlock(lang, body.join('\n')));
      continue;
    }
    // heading
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushPara();
      const level = heading[1].length + 2; // ## -> h4 keeps chat scale sane
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    // list item (unordered / ordered), grouped into one <ul>/<ol>
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || ordered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*[-*]\s+(.*)$/) || (tag === 'ol' ? lines[i].match(/^\s*\d+[.)]\s+(.*)$/) : null);
        if (!m) break;
        items.push(`<li>${inline(m[1])}</li>`);
        i++;
      }
      html.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    // blockquote
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushPara();
      const body: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*>\s?(.*)$/);
        if (!m) break;
        body.push(m[1]);
        i++;
      }
      html.push(`<blockquote>${inline(body.join(' '))}</blockquote>`);
      continue;
    }
    // horizontal rule
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flushPara();
      html.push('<hr>');
      i++;
      continue;
    }
    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return html.join('\n');
}
