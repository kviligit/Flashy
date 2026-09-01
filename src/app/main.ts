import { el, render } from '../ui/dom.js';
import { Router } from './router.js';

const NAV: Array<{ href: string; label: string }> = [
  { href: '#/', label: 'Decks' },
  { href: '#/stats', label: 'Stats' },
  { href: '#/settings', label: 'Settings' },
];

function shell(): { root: HTMLElement; outlet: HTMLElement; setActive: (path: string) => void } {
  const links = NAV.map((item) => el('a', { href: item.href, text: item.label }));
  const topbar = el(
    'header.topbar',
    {},
    el('span.brand', { text: 'Flashy' }),
    el('nav', {}, links),
  );
  const outlet = el('main', {});
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

function main(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('#app not found');

  const { root, outlet, setActive } = shell();
  render(app, root);

  new Router()
    .add('/', () => placeholder('Decks', 'Deck list lands in step 5.'))
    .add('/stats', () => placeholder('Stats', 'Stats land in step 8.'))
    .add('/settings', () => placeholder('Settings', 'Settings land in step 10.'))
    .notFound(() => placeholder('Not found', 'No such page.'))
    .observe(setActive)
    .start(outlet);
}

main();
