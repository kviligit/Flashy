import { test } from 'node:test';
import assert from 'node:assert/strict';

// The matcher is exercised through a tiny re-implementation-free path:
// we import the module and drive it via a fake DOM-less surface. Only the
// pure matching logic is under test here; mounting is covered end-to-end.
import { Router } from './router.js';

function makeOutlet(): { replaceChildren: (n: Node) => void; last: unknown } {
  const outlet = {
    last: null as unknown,
    replaceChildren(n: Node) {
      outlet.last = n;
    },
  };
  return outlet;
}

test('router matches static and parameterised routes', async () => {
  const seen: Array<[string, Record<string, string>]> = [];
  const router = new Router()
    .add('/', (p) => (seen.push(['/', p]), {} as Node))
    .add('/decks/:id', (p) => (seen.push(['/decks/:id', p]), {} as Node))
    .add('/decks/:id/edit', (p) => (seen.push(['/decks/:id/edit', p]), {} as Node))
    .notFound((p) => (seen.push(['404', p]), {} as Node));

  const outlet = makeOutlet();
  // @ts-expect-error minimal outlet stand-in for the DOM Element
  router['outlet'] = outlet;

  const go = async (hash: string) => {
    globalThis.window = { location: { hash } } as never;
    await router.resolve();
  };

  await go('#/');
  await go('#/decks/abc');
  await go('#/decks/abc/edit');
  await go('#/nope/nope/nope');

  assert.deepEqual(seen, [
    ['/', {}],
    ['/decks/:id', { id: 'abc' }],
    ['/decks/:id/edit', { id: 'abc' }],
    ['404', {}],
  ]);
});

test('router decodes params and parses the query string', async () => {
  let got: { params: Record<string, string>; q: string | null } | null = null;
  const router = new Router().add('/decks/:name', (params, query) => {
    got = { params, q: query.get('sort') };
    return {} as Node;
  });
  // @ts-expect-error minimal outlet stand-in for the DOM Element
  router['outlet'] = makeOutlet();

  globalThis.window = { location: { hash: '#/decks/my%20deck?sort=due' } } as never;
  await router.resolve();

  assert.deepEqual(got, { params: { name: 'my deck' }, q: 'due' });
});
