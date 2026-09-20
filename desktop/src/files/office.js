// Office document engine: read the text out of DOCX/XLSX/PPTX and write
// minimal valid ones back. Every format is a ZIP of XML parts (that is the
// whole trick), so this sits on zip.js and stays dependency-free. Pure
// functions on bytes and strings -- no DOM, no fetch -- so node:test can
// exercise them and the WebView bundle runs the same code.
(function (root, factory) {
  // Real CommonJS only. In a Vite bundle `module` exists (the CommonJS interop
  // object) but `require` does not, so the dependency is taken from the global
  // that zip.js publishes -- which is why the frontend imports zip.js for its
  // side effect before this file.
  var isCjs = typeof module === 'object' && module.exports && typeof require === 'function';
  var api = factory(isCjs ? require('./zip.js') : root && root.FreeZip);
  if (isCjs) module.exports = api;
  if (root) root.FreeOffice = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (zip) {
  'use strict';

  function decode(bytes) { return new TextDecoder().decode(bytes); }
  function encode(text) { return new TextEncoder().encode(text); }

  // ---- XML helpers -------------------------------------------------------
  function xmlEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  function decodeEntities(s) {
    return String(s)
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }
  // First <tag ...>...</tag> or self-closed match in a flat string scan.
  function matchAll(src, re) {
    var out = [], m;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) out.push(m);
    return out;
  }

  // ---- DOCX ---------------------------------------------------------------
  // Text lives in word/document.xml as <w:t>runs</w:t> inside <w:p>aragraphs.
  async function extractDocxText(bytes) {
    var xmlBytes = await zip.findEntry(bytes, 'word/document.xml');
    if (!xmlBytes) throw new Error('docx: word/document.xml missing (not a Word file?)');
    return (function () {
      var xml = decode(xmlBytes);
      var parts = [];
      var paras = matchAll(xml, /<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g);
      for (var i = 0; i < paras.length; i++) {
        var runs = matchAll(paras[i][0], /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>/g);
        var line = '';
        for (var r = 0; r < runs.length; r++) {
          line += runs[r][1] !== undefined ? decodeEntities(runs[r][1]) : '\t';
        }
        parts.push(line);
      }
      return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    })();
  }

  // Minimal but valid DOCX: content types, relationships, and document.xml.
  // Word (and our own reader) only need the parts to be consistent.
  function writeDocx(title, paragraphs) {
    var body = [];
    for (var i = 0; i < paragraphs.length; i++) {
      body.push('<w:p><w:r><w:t xml:space="preserve">' + xmlEscape(paragraphs[i]) + '</w:t></w:r></w:p>');
    }
    var documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body>' + body.join('') +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>';
    var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>';
    var rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>';
    return zip.writeZip([
      { name: '[Content_Types].xml', data: encode(contentTypes) },
      { name: '_rels/.rels', data: encode(rels) },
      { name: 'word/document.xml', data: encode(documentXml) },
    ]);
  }

  // ---- XLSX ---------------------------------------------------------------
  // workbook.xml names the sheets, sheet1.xml holds <c><v>cells</v></c> per
  // <row>. Inline strings (<is><t>) keep the writer single-part.
  async function extractXlsxSheets(bytes) {
    return (async function () {
      var sheetBytes = await zip.findEntry(bytes, 'xl/worksheets/sheet1.xml');
      if (!sheetBytes) throw new Error('xlsx: no worksheets found (not a spreadsheet?)');
      var xml = decode(sheetBytes);
      var rows = [];
      var rowMatches = matchAll(xml, /<row(?:\s[^>]*)?\/>|<row(?:\s[^>]*)?>[\s\S]*?<\/row>/g);
      for (var i = 0; i < rowMatches.length; i++) {
        var cells = matchAll(rowMatches[i][0], /<c(?:\s[^>]*)?\/>|<c(?:\s[^>]*)?>[\s\S]*?<\/c>/g);
        var out = [];
        for (var c = 0; c < cells.length; c++) {
          var cell = cells[c][0];
          var v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(cell);
          var t = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(cell);
          if (t) out.push(decodeEntities(t[1]));
          else if (v) {
            var val = decodeEntities(v[1]).trim();
            // A typed cell without text is numeric by OOXML rules.
            out.push(/^-?\d+(\.\d+)?$/.test(val) ? Number(val) : val);
          }
          else out.push('');
        }
        rows.push(out);
      }
      return rows;
    })();
  }

  function sheetToText(rows) {
    return rows.map(function (row) { return row.join('\t'); }).join('\n').trim();
  }

  function writeXlsx(title, sheets) {
    // sheets: [{ name, rows: [[cell,...],...] }]
    var sheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
    var first = sheets[0] || { name: 'Sheet1', rows: [] };
    for (var r = 0; r < first.rows.length; r++) {
      sheetXml += '<row r="' + (r + 1) + '">';
      for (var c = 0; c < first.rows[r].length; c++) {          var cell = first.rows[r][c];
        var ref = colName(c) + (r + 1);
        // Numbers stay typed (<v> without a type attribute is numeric in
        // OOXML); strings ride inlineStr -- even numeric-looking ones, so a
        // round-trip never turns the string "9.99" into the number 9.99.
        if (typeof cell === 'number' && isFinite(cell)) {
          sheetXml += '<c r="' + ref + '"><v>' + cell + '</v></c>';
        } else {
          sheetXml += '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEscape(String(cell)) + '</t></is></c>';
        }
      }
      sheetXml += '</row>';
    }
    sheetXml += '</sheetData></worksheet>';

    var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '</Types>';
    var rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';
    var workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="' + xmlEscape(first.name || 'Sheet1') + '" sheetId="1" r:id="rId1"/></sheets></workbook>';
    var wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '</Relationships>';
    return zip.writeZip([
      { name: '[Content_Types].xml', data: encode(contentTypes) },
      { name: '_rels/.rels', data: encode(rootRels) },
      { name: 'xl/workbook.xml', data: encode(workbook) },
      { name: 'xl/_rels/workbook.xml.rels', data: encode(wbRels) },
      { name: 'xl/worksheets/sheet1.xml', data: encode(sheetXml) },
    ]);
  }

  function colName(n) {
    var s = '';
    n += 1;
    while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  // ---- PPTX ---------------------------------------------------------------
  function extractPptxText(bytes) {
    var slides = [];
    return zip.readEntries(bytes).then(function (entries) {
      var names = entries.map(function (e) { return e.name; })
        .filter(function (n) { return /^ppt\/slides\/slide\d+\.xml$/.test(n); })
        .sort(function (a, b) {
          return (parseInt(a.replace(/\D+/g, ''), 10) || 0) - (parseInt(b.replace(/\D+/g, ''), 10) || 0);
        });
      if (names.length === 0) throw new Error('pptx: no slides found (not a presentation?)');
      var chain = Promise.resolve();
      names.forEach(function (name) {
        chain = chain.then(function () {
          var entry = entries.filter(function (e) { return e.name === name; })[0];
          var xml = decode(entry.data);
          var texts = matchAll(xml, /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)
            .map(function (m) { return decodeEntities(m[1]); });
          slides.push(texts.join('\n'));
        });
      });
      return chain.then(function () { return slides.join('\n\n'); });
    });
  }

  function writePptx(title, slideTexts) {
    var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>';
    var slideEntries = [];
    var slideOverrides = '';
    for (var i = 0; i < slideTexts.length; i++) {
      slideEntries.push('ppt/slides/slide' + (i + 1) + '.xml');
      slideOverrides += '<Override PartName="/ppt/slides/slide' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>';
    }
    contentTypes += slideOverrides + '</Types>';

    var rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
      '</Relationships>';
    var slideRels = '';
    for (var s = 0; s < slideTexts.length; s++) {
      slideRels += '<Relationship Id="rId' + (s + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide' + (s + 1) + '.xml"/>';
    }
    var presentation = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<p:sldIdLst>';
    for (var k = 0; k < slideTexts.length; k++) {
      presentation += '<p:sldId id="' + (256 + k) + '" r:id="rId' + (k + 1) + '"/>';
    }
    presentation += '</p:sldIdLst></p:presentation>';
    var presRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + slideRels + '</Relationships>';

    var entries = [
      { name: '[Content_Types].xml', data: encode(contentTypes) },
      { name: '_rels/.rels', data: encode(rootRels) },
      { name: 'ppt/presentation.xml', data: encode(presentation) },
      { name: 'ppt/_rels/presentation.xml.rels', data: encode(presRels) },
    ];
    for (var j = 0; j < slideTexts.length; j++) {
      var paras = String(slideTexts[j]).split('\n').map(function (line) {
        return '<a:p><a:r><a:t xml:space="preserve">' + xmlEscape(line) + '</a:t></a:r></a:p>';
      }).join('');
      var slide = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
        '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/>' +
        '<p:cNvGrpSpPr/></p:nvGrpSpPr><p:grpSpPr/>' + paras + '</p:spTree></p:cSld></p:sld>';
      entries.push({ name: 'ppt/slides/slide' + (j + 1) + '.xml', data: encode(slide) });
    }
    return zip.writeZip(entries);
  }

  return {
    extractDocxText: extractDocxText,
    extractXlsxSheets: extractXlsxSheets,
    sheetToText: sheetToText,
    extractPptxText: extractPptxText,
    writeDocx: writeDocx,
    writeXlsx: writeXlsx,
    writePptx: writePptx,
  };
});
