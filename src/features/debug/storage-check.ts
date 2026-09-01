/**
 * Runs the storage conformance suite against the real IndexedDB backend,
 * in a scratch database so nothing touches the user's collection.
 *
 * The node test suite runs these same checks against the in-memory backend.
 * Both must pass for the two implementations to be interchangeable.
 */

import { button, el, render } from '../../ui/dom.js';
import { CHECK_COUNT, IdbDb, MemoryDb, deleteDatabase, runConformance } from '../../storage/index.js';
import type { CheckResult } from '../../storage/index.js';

const SCRATCH_DB = 'flashy-conformance-scratch';

export function storageCheck(): HTMLElement {
  const root = el('section', {});
  let running = false;

  const draw = (
    results: Record<string, CheckResult[] | null>,
    error: string | null,
  ): void => {
    render(
      root,
      el(
        'div.row',
        {},
        el('h1', { text: 'Storage conformance' }),
        el('div.spacer', {}),
        button(running ? 'Running…' : 'Run checks', () => void run(), {
          class: 'primary',
          disabled: running,
        }),
      ),
      el('p.muted', {
        text: `${CHECK_COUNT} checks, run against both backends. They must agree — that is what makes the in-memory database a valid stand-in for IndexedDB.`,
      }),
      error ? el('div.card', { style: { borderColor: 'var(--danger)' } }, el('p', { text: error })) : null,
      el(
        'div.col',
        {},
        Object.entries(results).map(([backend, list]) => backendCard(backend, list)),
      ),
    );
  };

  const run = async (): Promise<void> => {
    running = true;
    draw({ 'In-memory': null, IndexedDB: null }, null);
    const results: Record<string, CheckResult[] | null> = { 'In-memory': null, IndexedDB: null };
    let error: string | null = null;

    try {
      results['In-memory'] = await runConformance(new MemoryDb());
      draw(results, null);

      await deleteDatabase(SCRATCH_DB);
      const idb = await IdbDb.open(SCRATCH_DB);
      try {
        results['IndexedDB'] = await runConformance(idb);
      } finally {
        idb.close();
        await deleteDatabase(SCRATCH_DB);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    running = false;
    draw(results, error);
  };

  draw({ 'In-memory': null, IndexedDB: null }, null);
  void run();
  return root;
}

function backendCard(backend: string, results: CheckResult[] | null): HTMLElement {
  if (!results) {
    return el('div.card', {}, el('h3', { text: backend }), el('p.muted', { text: 'Running…' }));
  }

  const failed = results.filter((r) => !r.ok);
  const colour = failed.length === 0 ? 'var(--good)' : 'var(--danger)';

  return el(
    'div.card',
    {},
    el(
      'div.row',
      {},
      el('h3', { text: backend, style: { margin: '0' } }),
      el('div.spacer', {}),
      el('strong', {
        // Marker the browser test greps for.
        'data-backend': backend,
        'data-ok': failed.length === 0 ? 'true' : 'false',
        text: `${results.length - failed.length}/${results.length} passed`,
        style: { color: colour },
      }),
    ),
    el(
      'table',
      {},
      el(
        'tbody',
        {},
        results.map((r) =>
          el(
            'tr',
            {},
            el('td', {
              text: r.ok ? '✓' : '✕',
              style: { color: r.ok ? 'var(--good)' : 'var(--danger)', width: '2em' },
            }),
            el('td', { text: r.name }),
            el('td.faint', { text: r.error ?? '' }),
          ),
        ),
      ),
    ),
  );
}
