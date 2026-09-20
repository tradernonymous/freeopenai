module.exports = [
  {
    ignores: ['node_modules/**', 'index.html', '.worktrees/**', 'desktop/dist/**', 'desktop/src-tauri/target/**', 'desktop/src-tauri/gen/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        Buffer: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        // Text in, bytes out (and back) -- both are globals in Node and in the
        // browser, which is what lets the same decode rule run in either.
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'warn',
      'no-undef': 'error',
    },
  },
  {
    // Loaded into the page by a <script> tag rather than required, so these are
    // the browser's globals and not a typo. Listed per file rather than added to
    // every file, because a node module reaching for `document` really is a bug.
    files: ['transcript-controller.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        requestAnimationFrame: 'readonly',
      },
    },
  },
  {
    // Also loaded by a <script> tag: the picture index is the browser's own
    // storage, which node has no form of (the tests pass a stand-in instead).
    files: ['image-store.js'],
    languageOptions: {
      globals: {
        indexedDB: 'readonly',
      },
    },
  },
  {
    // The Puter SDK bridge: it exists to drive a browser SDK, so `document` and
    // `FileReader` are the point rather than a mistake. Everything it does is
    // behind a `loaded()` check, so in node it reports "not loaded" instead of
    // reaching for either.
    files: ['desktop/src/puter.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        FileReader: 'readonly',
      },
    },
  },
];
