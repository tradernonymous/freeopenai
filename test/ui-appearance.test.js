// The appearance layer, pinned where a refactor would quietly undo it.
//
// Three of these are bugs that came back once already: a theme toggle that was
// the first control hidden on a narrow phone, an image overlay that counted
// seconds toward a budget it could not know, and a download that could only ever
// hand back the bytes it was given. None of them can fail a boot test -- they
// show up as "the app looks wrong" or "the save is the wrong size".
const test = require('node:test');
const assert = require('node:assert/strict');

const { HTML, sourceOf } = require('./helpers/index-html.js');

test('the palette is the neutral ladder, not white on black', () => {
  const root = HTML.slice(HTML.indexOf(':root {'), HTML.indexOf('html[data-theme="light"] {'));
  // Chrome one step below the conversation, raised surfaces one step above it.
  assert.match(root, /--bg: #212121;/, 'the conversation surface moved off the ChatGPT grey');
  assert.match(root, /--bg-elevated: #171717;/, 'the rail and bar must sit darker than the conversation');
  assert.match(root, /--surface-2: #303030;/, 'the raised step is gone');
  assert.doesNotMatch(root, /--bg: #000000;/, 'pure black is back, which reads as a headlamp on a long transcript');

  const light = HTML.slice(HTML.indexOf('html[data-theme="light"] {'), HTML.indexOf('html[data-theme="light"] .message-text'));
  assert.match(light, /--bg: #ffffff;/);
  assert.match(light, /--bg-elevated: #f9f9f9;/);
  assert.match(light, /--surface-2: #f4f4f4;/);

  // The composer is the one control always in reach, so it is lifted off the
  // transcript rather than sitting on the same grey as it.
  const composer = CSS.match(/\.composer \{[^}]*\}/);
  assert.ok(composer, '.composer is gone -- re-point this test');
  assert.match(composer[0], /background: var\(--surface-2\)/);
});

test('the appearance toggle is reachable at every size, including the smallest phone', () => {
  // It used to be hidden below 380px with "Ctrl+P still reaches it" as the
  // reason -- which is no reason at all on a phone.
  assert.doesNotMatch(HTML, /#themeToggle \{ display: none/, 'the appearance toggle is hidden on a narrow screen again');
  assert.match(HTML, /id="themeToggle"[^>]*onclick="toggleThemeMenu\(event\)"/, 'the header button has to open the picker');
  // The drawer row carries an icon between the handler and its label, so the two
  // halves are checked separately rather than across the icon's markup.
  assert.match(HTML, /<button class="drawer-nav-btn" type="button" onclick="toggleThemeMenu\(event\)">/, 'the drawer needs a row that opens it too');
  // Sliced from the drawer's own <nav>: the settings rail has a <nav> too, and
  // searching from zero finds that one's close tag first and reads nothing.
  const drawerAt = HTML.indexOf('<nav class="drawer-nav">');
  assert.ok(drawerAt > 0, 'the drawer nav is gone -- re-point this test');
  const drawer = HTML.slice(drawerAt, HTML.indexOf('</nav>', drawerAt));
  assert.match(drawer, /Appearance/, 'the drawer row has to say what it is');
  assert.match(HTML, /class="theme-menu" id="themeMenu"/, 'the picker is missing from the page');
  // A phone gets it as a sheet at the bottom, where a thumb already is.
  assert.match(HTML, /\.theme-menu \{ left: 12px; right: 12px; bottom: /, 'the picker has no small-screen placement');
});

test('the picker names the three choices rather than cycling through five', () => {
  // A const, not a function, so it is read from the page text rather than
  // through sourceOf's function lookup.
  const at = APP_JS.indexOf('const THEME_OPTIONS = [');
  assert.ok(at > 0, 'THEME_OPTIONS is gone -- re-point this test');
  const options = HTML.slice(at, HTML.indexOf('];', at));
  assert.match(options, /id: 'auto', label: 'System'/);
  assert.match(options, /id: 'light', label: 'Light'/);
  assert.match(options, /id: 'dark', label: 'Dark'/);
  // The packs are the same choice with another palette, so they are labelled.
  assert.match(options, /id: 'tokyonight'/);
  assert.match(options, /id: 'gruvbox'/);
  assert.match(options, /Pack'/);

  const render = sourceOf('renderThemeMenu');
  assert.match(render, /aria-checked/, 'the current theme has to be marked, or the picker cannot say what is on');
  assert.match(render, /applyTheme\(option\.id\)/);
  assert.match(sourceOf('toggleThemeMenu'), /positionThemeMenu/, 'the picker has to be placed, or it opens off screen');
});

test('the generation overlay counts nothing', () => {
  // It used to count seconds toward a fifty-five second budget and grow a ring
  // toward it. A generation that finishes in nine seconds and one that times out
  // at fifty-five drew the same bar, and neither number measured the work.
  const forge = sourceOf('createHoloForge');
  assert.doesNotMatch(forge, /setInterval/, 'a timer is back in the overlay');
  assert.doesNotMatch(forge, /holoTimer/, 'the overlay is storing an interval id again');
  assert.doesNotMatch(forge, /elapsed|'s'|secs/, 'the elapsed counter is back');
  assert.doesNotMatch(HTML, /holo-progress/, 'the progress ring is back');
  // Still a machine resolving: grid, rings, beam, motes, core, and a stage word.
  for (const layer of ['holo-forge__grid', 'holo-forge__rings', 'holo-forge__beam', 'holo-forge__motes', 'holo-forge__core']) {
    // Some of these are grouped selectors (`.holo-forge__motes, ...::after`),
    // so the rule is matched by the class, not by the exact line.
    assert.ok(HTML.includes('.' + layer), layer + ' has no rule');
    assert.ok(forge.includes(layer), layer + ' is never built');
  }
  assert.match(forge, /holo-forge__words/);
  assert.match(forge, /aria-hidden', 'true'/, 'the stage words are decoration; the container already announces the wait');
});

test('the overlay stills itself for reduced motion instead of strobing', () => {
  // The page-wide rule sets every animation to 1ms, which turns an infinite
  // animation into a strobe -- the opposite of what the setting asks for.
  const at = HTML.indexOf('/* Overrides the page-wide 1ms rule');
  assert.ok(at > 0, 'the reduced-motion override for the overlay is gone');
  const block = HTML.slice(at, at + 600);
  assert.match(block, /\.holo-forge \*, \.holo-forge \*::before, \.holo-forge \*::after \{ animation: none !important; \}/);
  assert.match(block, /\.holo-forge__words i:first-child \{ opacity: 1; \}/);
});

test('a picture can be saved from the message and from the lightbox', () => {
  // An <a download> can only hand back the bytes it was given, so the lightbox
  // anchor had to become a button over the re-encoder.
  assert.doesNotMatch(HTML, /<a id="lightboxDownload"/, 'the lightbox download went back to an anchor');
  assert.match(CSS, /<button id="lightboxDownload"[\s\S]{0,80}onclick="toggleImageDownloadMenu\(event, lightboxImg\.src, lightboxImg\.alt\)"/);
  const tools = sourceOf('appendImageTools');
  assert.match(tools, /toggleImageDownloadMenu\(event, src, promptText\)/, 'the image row needs a way to save without opening it first');
});

test('the save menu offers the three formats and names the real size', () => {
  const menu = sourceOf('toggleImageDownloadMenu');
  assert.match(menu, /imageDimensionsOf\(src\)/, 'the menu has to read the picture, not assume a size');
  assert.match(menu, /Save at \$\{size\.width\} × \$\{size\.height\}/, 'the true pixel size is what makes a wrong engine size visible');
  assert.match(sourceOf('imageDownloadMenuHtml'), /IMAGE_DOWNLOAD_FORMATS/, 'the formats are not the shared list');

  // The download renders the whole picture: the one cut in the app belongs to
  // the drawing path, which trims a wrong-shaped result to the shape that was
  // asked for. A download that cropped would be the same defect as one that
  // squares -- a file saved at a size nobody chose.
  assert.match(sourceOf('imageBlobForDownload'), /\(src, format\.id !== 'png'\)/, 'the download asks for no cut');

  // The render takes its size from the picture (or from the cut it was handed),
  // never from a constant: a fixed size here is how a 1536x1024 picture ends up
  // in the downloads folder as a square.
  const canvas = sourceOf('canvasFromImage');
  assert.match(canvas, /canvas\.width = outWidth;/);
  assert.match(canvas, /canvas\.height = outHeight;/);
  assert.doesNotMatch(canvas, /1024|aspect-ratio|Math\.min\(1,/, 'the render is sizing the picture instead of passing it through');

  const pdf = sourceOf('downloadImage') + sourceOf('imageBlobForDownload');
  assert.match(pdf, /buildImagePdf/, 'the PDF has to come from the shared builder');
  assert.match(pdf, /imageDownloadFilename/, 'the filename has to come from the shared helper');
});

test('a picture hosted elsewhere still saves, and says what it did', () => {
  // A cross-origin picture cannot be read into a canvas without CORS. Refusing
  // outright would lose a save that the browser can still perform.
  const download = sourceOf('downloadImage');
  assert.match(download, /\^https\?:/);
  assert.match(download, /as-is instead of converting/);
  assert.match(download, /link\.download/);
});
