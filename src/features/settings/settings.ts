/** Collection-wide settings: study day, presets, and note types. */

import { button, el, field, render, select } from '../../ui/dom.js';
import { confirmModal, promptModal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { navigate } from '../../app/router.js';
import type { AppContext } from '../../app/context.js';
import type { StorageStatus } from '../../storage/index.js';
import { makeDeckConfig, makeMeta } from '../../domain/defaults.js';
import { cloneNoteType, deleteNoteType, noteTypeUsage } from '../../collection/notetypes.js';
import { estimate, formatBytes, requestPersistence } from '../../storage/index.js';

export function settingsPage(ctx: AppContext): HTMLElement {
  const root = el('section', {});
  void draw(root, ctx);
  return root;
}

async function draw(root: HTMLElement, ctx: AppContext): Promise<void> {
  const refresh = () => void draw(root, ctx);

  const meta = (await ctx.db.meta.get('meta')) ?? makeMeta();
  const decks = await ctx.db.decks.getAll();
  const presets = (await ctx.db.deckConfigs.getAll()).sort((a, b) => a.name.localeCompare(b.name));
  const noteTypes = (await ctx.db.noteTypes.getAll()).sort((a, b) => a.name.localeCompare(b.name));

  const usage = new Map<string, number>();
  for (const nt of noteTypes) usage.set(nt.id, await noteTypeUsage(ctx.db, nt.id));

  const cutoffSelect = select(
    Array.from({ length: 24 }, (_, hour) => ({
      value: String(hour),
      label: `${String(hour).padStart(2, '0')}:00`,
    })),
    {
      'data-role': 'cutoff',
      onChange: (ev: Event) => {
        const hour = Number((ev.target as HTMLSelectElement).value);
        void (async () => {
          await ctx.db.meta.put({ ...meta, dayCutoffHour: hour, modified: Date.now() });
          await ctx.scheduler.load();
          toast(`The study day now starts at ${String(hour).padStart(2, '0')}:00.`, 'success');
        })();
      },
    },
  );
  cutoffSelect.value = String(meta.dayCutoffHour);

  const storage = ctx.storage ?? (await requestPersistence());
  const used = await estimate();

  render(
    root,
    el('h1', { text: 'Settings' }),

    storageCard(ctx, storage, used, refresh),

    el(
      'div.card.col',
      {},
      el('h3', { text: 'Study day' }),
      el('div.row', {}, field('Next day starts at', cutoffSelect), el('div.spacer', {})),
      el('p.faint', {
        text: 'Reviews done before this hour count toward the previous day, so a late-night session does not split in two.',
      }),
    ),

    el(
      'div.card.col',
      {},
      el(
        'div.row',
        {},
        el('h3', { text: 'Deck presets', style: { margin: '0' } }),
        el('div.spacer', {}),
        button('New preset', () => void createPreset(ctx, refresh), {}),
      ),
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el('tr', {}, ['Preset', 'Decks', 'New/day', 'Reviews/day', 'Retention', ''].map((h) => el('th', { text: h }))),
        ),
        el(
          'tbody',
          {},
          presets.map((preset) => {
            const users = decks.filter((d) => d.configId === preset.id);
            return el(
              'tr',
              { 'data-preset': preset.name },
              el('td', { text: preset.name }),
              el('td.muted', { text: users.length === 0 ? 'unused' : users.map((d) => d.name).join(', ') }),
              el('td.muted', { text: String(preset.newPerDay) }),
              el('td.muted', { text: String(preset.reviewsPerDay) }),
              el('td.muted', { text: `${(preset.desiredRetention * 100).toFixed(0)}%` }),
              el(
                'td',
                {},
                button('Edit', () => navigate(`/settings/deck/${users[0]?.id ?? decks[0]?.id ?? ''}`), {
                  class: 'ghost',
                  disabled: decks.length === 0,
                  title: users.length === 0 ? 'Opens on another deck; switch its preset there.' : '',
                }),
              ),
            );
          }),
        ),
      ),
      el('p.faint', { text: 'Presets are edited through a deck that uses them, so their effect is always visible in context.' }),
    ),

    el(
      'div.card.col',
      {},
      el('h3', { text: 'Note types' }),
      el(
        'table',
        {},
        el('thead', {}, el('tr', {}, ['Note type', 'Fields', 'Cards', 'Notes', ''].map((h) => el('th', { text: h })))),
        el(
          'tbody',
          {},
          noteTypes.map((nt) =>
            el(
              'tr',
              { 'data-notetype': nt.name },
              el('td', { text: nt.name }),
              el('td.muted', { text: nt.fields.map((f) => f.name).join(', ') }),
              el('td.muted', {
                text: nt.kind === 'cloze' ? 'from deletions' : String(nt.templates.length),
              }),
              el('td.muted', { text: String(usage.get(nt.id) ?? 0) }),
              el(
                'td',
                {},
                button('Edit', () => navigate(`/settings/notetype/${nt.id}`), { class: 'ghost' }),
                button('Clone', () => void clone(ctx, nt.id, nt.name, refresh), { class: 'ghost' }),
                button('Delete', () => void remove(ctx, nt.id, nt.name, refresh), {
                  class: 'ghost',
                  disabled: (usage.get(nt.id) ?? 0) > 0,
                  title: (usage.get(nt.id) ?? 0) > 0 ? 'In use by existing notes.' : '',
                }),
              ),
            ),
          ),
        ),
      ),
    ),

    el(
      'div.card.col',
      {},
      el('h3', { text: 'Tools' }),
      el(
        'div.row',
        {},
        button('Import & export', () => navigate('/manage'), {}),
        button('FSRS lab', () => navigate('/debug/fsrs'), { class: 'ghost' }),
        button('Storage conformance', () => navigate('/debug/storage'), { class: 'ghost' }),
        button('Sample data', () => navigate('/debug/sample'), { class: 'ghost' }),
      ),
    ),
  );
}

async function createPreset(ctx: AppContext, refresh: () => void): Promise<void> {
  const name = await promptModal('New preset', 'Name', 'New preset', 'Create');
  if (!name) return;
  await ctx.db.deckConfigs.put(makeDeckConfig(name));
  toast(`Created "${name}". Assign it from a deck's options.`, 'success');
  refresh();
}

async function clone(ctx: AppContext, id: string, name: string, refresh: () => void): Promise<void> {
  const newName = await promptModal('Clone note type', 'Name', `${name} copy`, 'Clone');
  if (!newName) return;
  await cloneNoteType(ctx.db, id, newName);
  toast(`Created "${newName}".`, 'success');
  refresh();
}

async function remove(ctx: AppContext, id: string, name: string, refresh: () => void): Promise<void> {
  const ok = await confirmModal('Delete note type', el('p', { text: `Delete "${name}"?` }), 'Delete', true);
  if (!ok) return;
  try {
    await deleteNoteType(ctx.db, id);
    toast('Note type deleted.', 'success');
    refresh();
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error');
  }
}


/**
 * Where the collection lives and whether it is safe there.
 *
 * Worth showing plainly: a browser may evict "best effort" storage when the
 * device runs low, and on a phone that means losing the review history with
 * no warning. If the browser has not granted durable storage, the honest
 * advice is to install the app and keep backups.
 */
function storageCard(
  ctx: AppContext,
  storage: StorageStatus,
  used: { usage?: number; quota?: number },
  refresh: () => void,
): HTMLElement {
  const size =
    used.usage === undefined
      ? 'size unknown'
      : `${formatBytes(used.usage)} used${used.quota ? ` of ${formatBytes(used.quota)} available` : ''}`;

  let state: string;
  let colour: string;
  if (!ctx.persistent) {
    state = 'Not saved at all';
    colour = 'var(--danger)';
  } else if (storage.persisted) {
    state = 'Saved on this device, protected from eviction';
    colour = 'var(--good)';
  } else if (!storage.supported) {
    state = 'Saved on this device; this browser cannot promise to keep it';
    colour = 'var(--hard)';
  } else {
    state = 'Saved on this device, but the browser may evict it if space runs low';
    colour = 'var(--hard)';
  }

  return el(
    'div.card.col',
    { 'data-card': 'storage' },
    el('h3', { text: 'Storage' }),
    el('p', {
      'data-role': 'storage-state',
      text: state,
      style: { color: colour, margin: '0' },
    }),
    el('p.faint', { text: `${size}. Nothing is ever uploaded.`, style: { margin: '0' } }),
    !ctx.persistent
      ? el('p.faint', {
          text: ctx.storageWarning ?? 'This browser would not open a database, so the collection lasts only until you close the tab.',
        })
      : null,
    el(
      'div.row',
      {},
      storage.persisted || !storage.supported
        ? null
        : button(
            'Ask again for durable storage',
            () => {
              void requestPersistence().then((result) => {
                toast(
                  result.persisted
                    ? 'Granted — the collection is protected now.'
                    : 'The browser declined. Installing the app to your home screen usually persuades it.',
                  result.persisted ? 'success' : 'info',
                );
                refresh();
              });
            },
            {},
          ),
      button('Back up now', () => navigate('/manage'), { class: storage.persisted ? '' : 'primary' }),
    ),
  );
}
