// The app's entry point, with a guard around it.
//
// A start-up throw used to be a window painted in the app's background colour
// with nothing in it -- the "installed it, opened it, there is nothing there"
// report, which says nothing about what went wrong. The mount is wrapped, and
// a failure is written into #root with its own message, so a broken bundle
// explains itself in one screenshot instead of looking like a dead app.
//
// The listeners only paint while #root is still EMPTY: an ordinary error in a
// working app must not replace a running UI.
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// Bundled, not borrowed from the machine: the app should look the same on every
// Windows build rather than inheriting whatever Segoe happens to be installed.
import '@fontsource-variable/inter';
import './index.css';

function rootElement(): HTMLElement | null {
  return document.getElementById('root');
}

function rootIsEmpty(): boolean {
  const root = rootElement();
  return !!root && root.childElementCount === 0;
}

/** What the user sees when the app cannot start. */
export function paintFailure(error: unknown): void {
  const root = rootElement();
  if (!root || !rootIsEmpty()) return;
  const message = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
  root.textContent = '';
  const box = document.createElement('div');
  box.className = 'boot-failure';
  const title = document.createElement('h1');
  title.textContent = 'FreeAI4U could not start';
  const detail = document.createElement('pre');
  detail.textContent = message;
  const hint = document.createElement('p');
  hint.textContent = 'This is a fault in the app itself, not in your account or your network. '
    + 'Copy the line above into a report, or reinstall the newest build from the release page.';
  box.append(title, detail, hint);
  root.append(box);
}

window.addEventListener('error', (event) => {
  if (rootIsEmpty()) paintFailure(event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  if (rootIsEmpty()) paintFailure(event.reason);
});

const container = rootElement();
if (!container) {
  // index.html is bundled with the app; if #root is missing the shell and the
  // frontend do not match, and saying so beats a blank window.
  document.body.textContent = 'FreeAI4U: this build is missing its #root element.';
} else {
  try {
    ReactDOM.createRoot(container).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  } catch (error) {
    paintFailure(error);
  }
}
