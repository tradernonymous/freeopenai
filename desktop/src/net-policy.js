// Which URLs this app will ask the shell to fetch.
//
// The rule is enforced in Rust (src-tauri/src/net.rs) — this is the frontend's
// copy of it, so a URL can be refused with a readable message *before* crossing
// the boundary, and so node:test can exercise the rules without a Rust
// toolchain. test/desktop-net.test.js asserts this list and the Rust one are
// identical, so the two cannot drift apart.
//
// https anywhere on the list; http only on loopback (a local model server);
// everything else refused.
(function (root, factory) {
  // Unconditional global publish -- see chats.js for why the traditional
  // fallback-branch UMD shape breaks in a Vite production bundle.
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UNetPolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var HOSTS = [
    'api.github.com',
    'github.com',
    'objects.githubusercontent.com',
    'raw.githubusercontent.com',
    'huggingface.co',
    '*.huggingface.co',
    '*.hf.co',
    '*.xethub.hf.co',
  ];

  function schemeOf(url) {
    var value = String(url == null ? '' : url);
    var at = value.indexOf('://');
    if (at <= 0) return '';
    var rest = value.slice(at + 3);
    if (!rest) return '';
    return value.slice(0, at).toLowerCase();
  }

  // Host only: no port, no credentials, no path. IPv6 literals keep brackets.
  function hostOf(url) {
    var value = String(url == null ? '' : url);
    var at = value.indexOf('://');
    if (at <= 0) return '';
    var rest = value.slice(at + 3);
    var authority = rest.split(/[/?#]/)[0];
    var creds = authority.lastIndexOf('@');
    if (creds >= 0) authority = authority.slice(creds + 1);
    var host;
    if (authority.charAt(0) === '[') {
      var end = authority.indexOf(']');
      host = end < 0 ? '' : authority.slice(0, end + 1);
    } else {
      host = authority.split(':')[0];
    }
    return host.trim().toLowerCase();
  }

  function isLoopback(host) {
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  }

  function hostMatches(host, entry) {
    var value = String(entry == null ? '' : entry).trim().toLowerCase();
    if (!value) return false;
    if (value.slice(0, 2) === '*.') {
      var suffix = value.slice(2);
      return host === suffix || host.slice(-(suffix.length + 1)) === '.' + suffix;
    }
    return host === value;
  }

  function isAllowed(url, extra) {
    var scheme = schemeOf(url);
    var host = hostOf(url);
    if (!scheme || !host) return false;
    if (scheme === 'http') {
      if (!isLoopback(host)) return false;
    } else if (scheme !== 'https') {
      return false;
    }
    if (isLoopback(host)) return true;
    if (HOSTS.some(function (entry) { return hostMatches(host, entry); })) return true;
    return (extra || []).some(function (entry) { return hostMatches(host, entry); });
  }

  // The sentence a user sees when a URL is refused; '' means it is fine.
  function refusalReason(url, extra) {
    var value = String(url == null ? '' : url).trim();
    if (!value) return 'That is not a web address.';
    if (!schemeOf(value)) return 'That address is missing its https:// prefix.';
    var host = hostOf(value);
    if (!host) return 'That address has no host.';
    if (isAllowed(value, extra)) return '';
    if (schemeOf(value) === 'http') {
      return host + ' is http, which is only allowed for a server on this machine (127.0.0.1).';
    }
    return host + ' is not on the list of addresses this app may reach.';
  }

  // Where a redirect points: absolute, scheme-relative, root-relative or
  // sibling-relative. Anything else is refused rather than guessed at.
  function resolveLocation(base, location) {
    var loc = String(location == null ? '' : location).trim();
    if (!loc || loc.charAt(0) === '#') return null;
    if (loc.indexOf('://') > 0) return loc;
    if (loc.slice(0, 2) === '//') {
      var scheme = schemeOf(base);
      return scheme ? scheme + ':' + loc : null;
    }
    var at = String(base).indexOf('://');
    if (at <= 0) return null;
    var rest = String(base).slice(at + 3);
    var authority = rest.split(/[/?#]/)[0];
    if (!authority) return null;
    var origin = String(base).slice(0, at + 3) + authority;
    if (loc.charAt(0) === '/') return origin + loc;
    var withoutQuery = String(base).split(/[?#]/)[0];
    var slash = withoutQuery.lastIndexOf('/');
    if (slash < origin.length) return origin + '/' + loc;
    return withoutQuery.slice(0, slash + 1) + loc;
  }

  return {
    HOSTS: HOSTS,
    schemeOf: schemeOf,
    hostOf: hostOf,
    isLoopback: isLoopback,
    hostMatches: hostMatches,
    isAllowed: isAllowed,
    refusalReason: refusalReason,
    resolveLocation: resolveLocation,
  };
});
