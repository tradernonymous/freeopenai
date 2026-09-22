// The Design studio's contract with the model and with the preview.
//
//   * extract(reply): what the model sent. The contract is ONE
//     <artifact type="text/html"> block; a tolerant parser still finds the HTML
//     in a code fence or bare text, because local models often skip the tag.
//     A <question-form> (JSON, at most 5 questions) and an <assumptions> list
//     are read the same way.
//   * inject/strip: the host script that runs INSIDE the sandboxed preview
//     (allow-scripts, no same-origin). It numbers elements (data-nid), picks
//     an element for a comment, turns on direct text editing, applies tweak
//     values, swaps one element for a rewritten one, and posts the cleaned
//     document back. Nothing it adds survives serialisation.
//   * cssVars/setTweaks/controlFor: the Tweaks panel's model -- :root custom
//     properties in, a marked <style id="neura-tweaks"> block out.
//
// UMD (see chats.js); pure string work, node-tested.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UArtifact = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var HOST_MARK = 'neura-host';
  var MAX_QUESTIONS = 5;

  function text(value) {
    return String(value == null ? '' : value);
  }

  /** The first complete HTML document in some text, or a large enough fragment. */
  function htmlIn(source) {
    var candidate = text(source).trim();
    var fenced = /```(?:html)?\s*([\s\S]*?)```/i.exec(candidate);
    if (fenced && /<[a-z!]/i.test(fenced[1])) candidate = fenced[1].trim();
    var doc = /<!DOCTYPE html[\s\S]*<\/html>/i.exec(candidate) || /<html[\s\S]*<\/html>/i.exec(candidate);
    if (doc) return doc[0];
    // A model that stopped early still sent a usable page: close it.
    var open = /<!DOCTYPE html[\s\S]*$/i.exec(candidate) || /<html[\s\S]*$/i.exec(candidate);
    if (open && open[0].length > 200) return open[0] + (/<\/body>/i.test(open[0]) ? '' : '\n</body>') + '\n</html>';
    if (/<(body|main|section|div|header)[\s>]/i.test(candidate) && candidate.length > 120) return candidate;
    return null;
  }

  function questionsIn(source) {
    var m = /<question-form>([\s\S]*?)<\/question-form>/i.exec(text(source));
    if (!m) return null;
    var parsed;
    try {
      parsed = JSON.parse(m[1].trim().replace(/^```(?:json)?|```$/g, ''));
    } catch {
      return null;
    }
    var list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.questions) ? parsed.questions : [];
    var out = [];
    list.forEach(function (q, i) {
      if (!q || typeof q !== 'object' || out.length >= MAX_QUESTIONS) return;
      var label = text(q.label || q.question || q.text).trim();
      if (!label) return;
      var options = Array.isArray(q.options) ? q.options.map(text).filter(Boolean).slice(0, 6) : [];
      out.push({ id: text(q.id || 'q' + (i + 1)), label: label.slice(0, 200), options: options });
    });
    return out.length ? out : null;
  }

  function assumptionsIn(source) {
    var m = /<assumptions>([\s\S]*?)<\/assumptions>/i.exec(text(source));
    if (!m) return [];
    return m[1].split('\n').map(function (l) { return l.replace(/^\s*[-*\d.)]+\s*/, '').trim(); }).filter(Boolean).slice(0, 8);
  }

  /** { html, questions, assumptions, tagged } from a model reply. */
  function extract(reply) {
    var src = text(reply);
    var tagged = /<artifact\b[^>]*type=["']text\/html["'][^>]*>([\s\S]*?)(<\/artifact>|$)/i.exec(src);
    var html = tagged ? htmlIn(tagged[1]) || (tagged[1].trim().length > 120 ? tagged[1].trim() : null) : null;
    if (!html) {
      // Without the tag, look outside any question form or assumptions list.
      html = htmlIn(src.replace(/<question-form>[\s\S]*?<\/question-form>/gi, '').replace(/<assumptions>[\s\S]*?<\/assumptions>/gi, ''));
    }
    return { html: html, questions: questionsIn(src), assumptions: assumptionsIn(src), tagged: !!tagged };
  }

  /** One element, for a comment edit: the fragment tag, a fence, or the bare element. */
  function extractFragment(reply) {
    var src = text(reply);
    var tagged = /<artifact\b[^>]*>([\s\S]*?)(<\/artifact>|$)/i.exec(src);
    var body = tagged ? tagged[1] : src;
    var fenced = /```(?:html)?\s*([\s\S]*?)```/i.exec(body);
    if (fenced) body = fenced[1];
    var start = body.search(/<[a-z][\w-]*[\s>]/i);
    var end = body.lastIndexOf('>');
    if (start < 0 || end < start) return null;
    return body.slice(start, end + 1).trim();
  }

  // ---- the host script -------------------------------------------------------
  //
  // Plain ES5 in a string: it is written into srcdoc, not bundled. Messages it
  // takes (from the parent only): neura:mode {mode}, neura:set-tweaks {vars},
  // neura:replace {nid, html}, neura:pins {nids}, neura:print,
  // neura:deck-go {index}. Messages it sends: neura:ready, neura:pick {nid,
  // tag, text, outer}, neura:html {html}, neura:tweaks-available {version,
  // schema} (tweaks.js validates it), neura:deck {index, count} for pages
  // made of <section class="slide">, and neura:size {w, h}.
  //
  // Tweaks are applied twice: as inline custom properties on :root (so they
  // win at once, whatever the page's cascade), and into the page's
  // neura-tweaks:start/end marker block when it has one (so the serialised
  // page keeps them). The inline copy is removed again on serialisation.
  var HOST_SCRIPT = [
    '(function(){',
    'var mode="view",hovered=null,timer=0,applied={},slide=0,deckTimer=0;',
    // Split so the host script itself never contains a marker a reader could find.
    'var TS="/* neura-tweaks"+":start */",TE="/* neura-tweaks"+":end */";',
    'function slides(){return document.querySelectorAll("section.slide");}',
    'function deckPost(){var n=slides().length;if(n)send({type:"neura:deck",index:slide,count:n});}',
    'function goSlide(i){var list=slides();if(!list.length)return;slide=Math.max(0,Math.min(list.length-1,i));var r=list[slide].getBoundingClientRect();window.scrollTo(0,r.top+(window.pageYOffset||0));deckPost();}',
    'function nearest(){var list=slides(),best=0,d=1e9;for(var i=0;i<list.length;i++){var t=Math.abs(list[i].getBoundingClientRect().top);if(t<d){d=t;best=i;}}if(best!==slide){slide=best;deckPost();}}',
    'function markerStyle(){var st=document.querySelectorAll("style");for(var i=0;i<st.length;i++){if(st[i].id!=="' + HOST_MARK + '-style"&&st[i].textContent.indexOf(TS)>=0)return st[i];}return null;}',
    'function writeMarkers(vars){var st=markerStyle();if(!st)return false;var t=st.textContent,a=t.indexOf(TS),b=t.indexOf(TE,a);if(b<0)return false;var cur={},re=/(--[\\w-]+)\\s*:\\s*([^;}]+)/g,m,body=t.slice(a+TS.length,b);while((m=re.exec(body)))cur[m[1]]=m[2].trim();',
    'for(var k in vars)cur[k]=vars[k];var css="";for(var c in cur)css+=c+":"+cur[c]+";";st.textContent=t.slice(0,a)+TS+":root{"+css+"}"+TE+t.slice(b+TE.length);return true;}',
    'function tweakSchema(){var s=document.querySelector("script[type=\\"application/neura-tweaks+json\\"]");if(!s)return;var raw=s.textContent;try{raw=JSON.parse(raw);}catch(e){}send({type:"neura:tweaks-available",version:1,schema:raw});}',
    'function number(el,path){var kids=el.children;for(var i=0;i<kids.length;i++){var k=kids[i];if(k.id==="' + HOST_MARK + '")continue;var p=path?path+"."+i:String(i);k.setAttribute("data-nid",p);number(k,p);}}',
    'function renumber(){if(document.body)number(document.body,"");}',
    'function clean(root){var sel=["[data-nid]","[data-neura-hover]","[data-neura-pin]"];for(var s=0;s<sel.length;s++){var list=root.querySelectorAll(sel[s]);for(var i=0;i<list.length;i++){list[i].removeAttribute("data-nid");list[i].removeAttribute("data-neura-hover");list[i].removeAttribute("data-neura-pin");}}',
    'var gone=root.querySelectorAll("#' + HOST_MARK + ',#' + HOST_MARK + '-style");for(var j=0;j<gone.length;j++)gone[j].parentNode.removeChild(gone[j]);',
    'var body=root.querySelector("body");if(body){body.removeAttribute("contenteditable");body.removeAttribute("spellcheck");}}',
    'function serialize(){var copy=document.documentElement.cloneNode(true);clean(copy);for(var k in applied)copy.style.removeProperty(k);if(copy.getAttribute("style")==="")copy.removeAttribute("style");return "<!DOCTYPE html>\\n"+copy.outerHTML;}',
    'function send(msg){try{parent.postMessage(msg,"*");}catch(e){}}',
    'function sendHtml(){clearTimeout(timer);timer=setTimeout(function(){send({type:"neura:html",html:serialize()});},350);}',
    'function style(){var s=document.createElement("style");s.id="' + HOST_MARK + '-style";',
    's.textContent="[data-neura-hover]{outline:2px solid #e8590c!important;outline-offset:2px;cursor:crosshair}[data-neura-pin]{outline:2px dashed #e8590c!important;outline-offset:2px}";',
    '(document.head||document.documentElement).appendChild(s);}',
    'function setMode(m){mode=m;if(document.body){document.body.contentEditable=m==="edit"?"true":"false";if(m!=="edit")document.body.removeAttribute("contenteditable");}',
    'if(hovered&&m!=="comment"){hovered.removeAttribute("data-neura-hover");hovered=null;}}',
    'document.addEventListener("mouseover",function(e){if(mode!=="comment")return;if(hovered)hovered.removeAttribute("data-neura-hover");hovered=e.target;if(hovered&&hovered.setAttribute&&hovered!==document.body)hovered.setAttribute("data-neura-hover","1");},true);',
    'document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a"):null;if(a)e.preventDefault();',
    'if(mode!=="comment")return;e.preventDefault();e.stopPropagation();var el=e.target;if(!el||!el.getAttribute)return;',
    'var outer=el.outerHTML.replace(/ data-(nid|neura-hover|neura-pin)="[^"]*"/g,"");',
    'send({type:"neura:pick",nid:el.getAttribute("data-nid"),tag:el.tagName.toLowerCase(),text:(el.textContent||"").trim().slice(0,160),outer:outer.slice(0,6000)});},true);',
    'document.addEventListener("input",function(){if(mode==="edit")sendHtml();},true);',
    'window.addEventListener("message",function(e){if(e.source!==parent)return;var d=e.data||{};',
    'if(d.type==="neura:mode")setMode(d.mode);',
    'else if(d.type==="neura:set-tweaks"){var ok={};for(var k in d.vars){if(/^--[\\w-]+$/.test(k)){var v=String(d.vars[k]).replace(/[;{}<]/g,"").replace(/\\/\\*|\\*\\//g,"");ok[k]=v;applied[k]=1;document.documentElement.style.setProperty(k,v);}}',
    // A versioned (protocol) message on a page without markers gets a marked block of its own.
    'if(!writeMarkers(ok)&&d.version){var mk=document.createElement("style");mk.id="neura-tweak-defaults";mk.textContent=TS+":root{}"+TE;(document.head||document.documentElement).appendChild(mk);writeMarkers(ok);}',
    'else if(!markerStyle()){var st=document.getElementById("neura-tweaks");if(!st){st=document.createElement("style");st.id="neura-tweaks";(document.head||document.documentElement).appendChild(st);}',
    'var css="";for(var q in ok)css+=q+":"+ok[q]+";";st.textContent="/* neura:tweaks */:root{"+css+"}";}sendHtml();}',
    'else if(d.type==="neura:deck-go"){goSlide(Number(d.index)||0);}',
    'else if(d.type==="neura:replace"){var el=document.querySelector("[data-nid=\\""+d.nid+"\\"]");if(el){var t=document.createElement("template");t.innerHTML=String(d.html||"");el.parentNode.replaceChild(t.content,el);renumber();sendHtml();}}',
    'else if(d.type==="neura:pins"){var old=document.querySelectorAll("[data-neura-pin]");for(var i=0;i<old.length;i++)old[i].removeAttribute("data-neura-pin");',
    '(d.nids||[]).forEach(function(n,i){var p=document.querySelector("[data-nid=\\""+n+"\\"]");if(p)p.setAttribute("data-neura-pin",String(i+1));});}',
    'else if(d.type==="neura:print"){window.print();}});',
    'document.addEventListener("keydown",function(e){if(mode!=="view"||!slides().length)return;var k=e.key;if(k==="ArrowRight"||k==="ArrowDown"||k==="PageDown"||k===" "){e.preventDefault();goSlide(slide+1);}else if(k==="ArrowLeft"||k==="ArrowUp"||k==="PageUp"){e.preventDefault();goSlide(slide-1);}},true);',
    'window.addEventListener("scroll",function(){clearTimeout(deckTimer);deckTimer=setTimeout(nearest,120);});',
    'function size(){var el=document.documentElement;send({type:"neura:size",w:el.scrollWidth,h:el.scrollHeight});}',
    'window.addEventListener("resize",size);',
    'function boot(){style();renumber();send({type:"neura:ready"});tweakSchema();deckPost();size();}',
    'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);else boot();',
    '})();',
  ].join('\n');

  /** The page with the host script appended (before </body> when there is one). */
  function inject(html) {
    var page = strip(html);
    var tag = '<script id="' + HOST_MARK + '">' + HOST_SCRIPT + '</' + 'script>';
    var at = page.search(/<\/body>/i);
    return at >= 0 ? page.slice(0, at) + tag + page.slice(at) : page + tag;
  }

  /** The page without the host script, whatever the preview left behind. */
  function strip(html) {
    return text(html)
      .replace(new RegExp('<script id="' + HOST_MARK + '">[\\s\\S]*?<\\/script>', 'gi'), '')
      .replace(new RegExp('<style id="' + HOST_MARK + '-style">[\\s\\S]*?<\\/style>', 'gi'), '')
      .replace(/ data-(nid|neura-hover|neura-pin)="[^"]*"/g, '');
  }

  // ---- tweaks ----------------------------------------------------------------

  /** Custom properties declared on :root, in order; a later block wins. */
  function cssVars(html) {
    var out = [];
    var index = {};
    var blocks = text(html).match(/:root\s*\{[^}]*\}/g) || [];
    blocks.forEach(function (block) {
      var re = /(--[\w-]+)\s*:\s*([^;}]+)/g;
      var m;
      while ((m = re.exec(block))) {
        var name = m[1];
        var value = m[2].trim();
        if (name in index) out[index[name]].value = value;
        else { index[name] = out.length; out.push({ name: name, value: value }); }
      }
    });
    return out;
  }

  /** The page with `vars` written into its one tweaks block (replaced, never stacked). */
  function setTweaks(html, vars) {
    var css = '';
    Object.keys(vars || {}).forEach(function (k) {
      if (/^--[\w-]+$/.test(k)) css += k + ':' + String(vars[k]).replace(/[;{}<]/g, '') + ';';
    });
    var block = '<style id="neura-tweaks">/* neura:tweaks */:root{' + css + '}</style>';
    var page = text(html).replace(/<style id="neura-tweaks">[\s\S]*?<\/style>/gi, '');
    if (!css) return page;
    var at = page.search(/<\/head>/i);
    if (at >= 0) return page.slice(0, at) + block + page.slice(at);
    var body = page.search(/<body[\s>]/i);
    return body >= 0 ? page.slice(0, body) + block + page.slice(body) : block + page;
  }

  /** What control a value wants: colour, a length with a unit, a number, or text. */
  function controlFor(name, value) {
    var v = text(value).trim();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return { kind: 'color' };
    var len = /^(-?\d*\.?\d+)(px|rem|em|%|vw|vh|ch)$/.exec(v);
    if (len) {
      var n = Number(len[1]);
      var unit = len[2];
      var max = unit === 'px' ? Math.max(64, n * 3) : unit === '%' ? 100 : Math.max(4, n * 3);
      return { kind: 'length', unit: unit, min: 0, max: max, step: unit === 'px' || unit === '%' ? 1 : 0.05, value: n };
    }
    if (/^-?\d*\.?\d+$/.test(v)) {
      var num = Number(v);
      return { kind: 'number', min: 0, max: Math.max(2, num * 3), step: num % 1 ? 0.05 : 1, value: num };
    }
    return { kind: 'text' };
  }

  return {
    HOST_MARK: HOST_MARK,
    MAX_QUESTIONS: MAX_QUESTIONS,
    HOST_SCRIPT: HOST_SCRIPT,
    extract: extract,
    extractFragment: extractFragment,
    inject: inject,
    strip: strip,
    cssVars: cssVars,
    setTweaks: setTweaks,
    controlFor: controlFor,
  };
});
