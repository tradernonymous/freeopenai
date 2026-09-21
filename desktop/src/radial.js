// Where a radial menu goes, given where the pointer is.
//
// The menu is opened by a right-click, and a right-click near the edge of the
// window is still a right-click: the ring has to move rather than open half
// off-screen. That arithmetic is the whole of this file -- the component draws
// what this returns, so the placement rule can be tested without a browser.
//
// UMD like the repo's other shared modules: node gets module.exports, the
// bundled app gets the global.
(function (root, factory) {
  // Unconditional global publish -- see chats.js for why the traditional
  // fallback-branch UMD shape breaks in a Vite production bundle.
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4URadial = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var RADIUS = 76;
  var ITEM = 44;
  var MARGIN = 10;

  function positive(value, fallback) {
    var n = Number(value);
    return n > 0 ? n : fallback;
  }

  /**
   * place({ x, y, count, viewportWidth, viewportHeight, radius, itemSize, margin })
   *
   * Returns the ring's centre and one point per item. The first item sits
   * straight above the centre and the rest follow clockwise, which is the only
   * order a menu with no beginning can have and still be predictable.
   */
  function place(input) {
    var opts = input || {};
    var count = Math.max(0, Math.floor(Number(opts.count) || 0));
    var radius = positive(opts.radius, RADIUS);
    var itemSize = positive(opts.itemSize, ITEM);
    var width = positive(opts.viewportWidth, 1024);
    var height = positive(opts.viewportHeight, 768);
    var margin = Number(opts.margin) >= 0 ? Number(opts.margin) : MARGIN;

    // Half the ring, plus half an item, plus a margin: how far the centre must
    // be from every edge for nothing to be clipped.
    var half = radius + itemSize / 2 + margin;
    // A viewport smaller than the ring (a phone, a tiny window) has no valid
    // centre; it gets the middle of what it does have rather than a negative
    // clamp, which is what Math.max alone would produce.
    var cx = move(Number(opts.x) || 0, half, width);
    var cy = move(Number(opts.y) || 0, half, height);

    var items = [];
    for (var i = 0; i < count; i += 1) {
      var angle = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(count, 1);
      items.push({
        index: i,
        angle: angle,
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      });
    }

    return { cx: cx, cy: cy, radius: radius, itemSize: itemSize, items: items };
  }

  function move(value, half, extent) {
    if (extent <= half * 2) return extent / 2;
    return Math.min(Math.max(value, half), extent - half);
  }

  return {
    RADIUS: RADIUS,
    ITEM: ITEM,
    MARGIN: MARGIN,
    place: place,
  };
});
