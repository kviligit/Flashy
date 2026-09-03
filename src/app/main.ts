/** Application entry point: bootstrap the collection, then route. */

import { el, render } from '../ui/dom.js';
import { Router } from './router.js';
import { BUILD, BUILD_LABEL } from './build-info.js';
import { bootstrap, type AppContext } from './context.js';
import { deckList } from '../features/decks/deck-list.js';
import { noteEditor } from '../features/editor/note-editor.js';
import { browse } from '../features/browse/browse.js';
import { reviewer } from '../features/review/reviewer.js';
import { statsPage } from '../features/stats/stats.js';
import { managePage } from '../features/io/manage.js';
import { settingsPage } from '../features/settings/settings.js';
import { deckOptions } from '../features/settings/deck-options.js';
import { noteTypeEditor } from '../features/settings/notetype-editor.js';
import { fsrsLab } from '../features/debug/fsrs-lab.js';
import { storageCheck } from '../features/debug/storage-check.js';
import { sampleData } from '../features/debug/sample-data.js';

const NAV: Array<{ href: string; label: string }> = [
  { href: '#/', label: 'Decks' },
  { href: '#/browse', label: 'Browse' },
  { href: '#/stats', label: 'Stats' },
  { href: '#/manage', label: 'Import/Export' },
  { href: '#/settings', label: 'Settings' },
];

function shell(): { root: HTMLElement; outlet: HTMLElement; setActive: (path: string) => void } {
  const links = NAV.map((item) => el('a', { href: item.href, text: item.label }));
  const topbar = el(
    'header.topbar',
    {},
    el('span.brand', { text: 'Flashy' }),
    // Compiled in, not fetched, so it describes the code actually
    // running rather than whatever the server last published — which is
    // the difference that makes it worth having when a service worker
    // may still be serving an older build.
    el('span.build', {
      'data-build': BUILD.commit,
      title: `${BUILD.commit}${BUILD.dirty ? ' (uncommitted changes)' : ''} · built ${BUILD.builtAt}`,
      text: BUILD_LABEL,
    }),
    el('nav', { 'aria-label': 'Main' }, links),
  );
  const outlet = el('main', { id: 'main', tabindex: '-1' });
  const root = el('div', {}, topbar, outlet);

  const setActive = (path: string) => {
    for (const [i, link] of links.entries()) {
      const href = NAV[i]!.href.slice(1);
      const active = href === '/' ? path === '/' : path.startsWith(href);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  };

  return { root, outlet, setActive };
}

function placeholder(title: string, note: string): HTMLElement {
  return el('section', {}, el('h1', { text: title }), el('div.empty', { text: note }));
}

const TITLES: Array<[RegExp, string]> = [
  [/^\/$/, 'Decks'],
  [/^\/study/, 'Study'],
  [/^\/add/, 'Add note'],
  [/^\/edit/, 'Edit note'],
  [/^\/browse/, 'Browse'],
  [/^\/stats/, 'Stats'],
  [/^\/manage/, 'Import & export'],
  [/^\/settings/, 'Settings'],
  [/^\/debug/, 'Debug'],
];

function titleFor(path: string): string {
  return TITLES.find(([pattern]) => pattern.test(path))?.[1] ?? 'Flashy';
}

function fatal(message: string): HTMLElement {
  return el(
    'section',
    {},
    el('h1', { text: 'Flashy could not start' }),
    el('div.card', { style: { borderColor: 'var(--danger)' } }, el('p', { text: message })),
  );
}

function routes(ctx: AppContext): Router {
  return new Router()
    .add('/', () => deckList(ctx))
    .add('/stats', () => statsPage(ctx))
    .add('/manage', () => managePage(ctx))
    .add('/settings', () => settingsPage(ctx))
    .add('/settings/deck/:deckId', (p) => deckOptions(ctx, p['deckId']!))
    .add('/settings/notetype/:id', (p) => noteTypeEditor(ctx, p['id']!))
    .add('/study/:deckId', (p) => reviewer(ctx, p['deckId']!))
    .add('/add', (_p, query) => noteEditor(ctx, query.get('deck') ? { deckId: query.get('deck')! } : {}))
    .add('/edit/:noteId', (p) => noteEditor(ctx, { noteId: p['noteId']! }))
    .add('/browse', (_p, query) => browse(ctx, query.get('q') ?? ''))
    .add('/debug/fsrs', () => fsrsLab())
    .add('/debug/storage', () => storageCheck())
    .add('/debug/sample', () => sampleData(ctx))
    .notFound(() => placeholder('Not found', 'No such page.'));
}

/**
 * Register the service worker so the app works offline. Failure is not
 * fatal: without it Flashy still runs, it just needs the files served.
 */
function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  // file:// has no service worker support and would log a scary error.
  if (window.location.protocol === 'file:') return;

  const register = (): void => {
    void navigator.serviceWorker.register('./sw.js').catch(() => {
      // Offline support is a bonus, not a requirement.
    });
  };

  // Registration is deferred until the page has loaded so it does not
  // compete with the first paint — but bootstrapping is async, so by the
  // time we get here the load event has usually already fired, and adding
  // a listener then would wait forever.
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

async function main(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) throw new Error('#app not found');

  const { root, outlet, setActive } = shell();
  render(app, root);
  render(outlet, el('div.empty', { text: 'Opening collection…' }));

  try {
    const ctx = await bootstrap();
    routes(ctx)
      .observe((path) => {
        setActive(path);
        // Announce the new view to screen readers, and give the keyboard
        // somewhere sensible to land after a navigation.
        document.title = `${titleFor(path)} · Flashy`;
      })
      .start(outlet);
    registerServiceWorker();
  } catch (error) {
    render(outlet, fatal(error instanceof Error ? error.message : String(error)));
  }
}

void main();
