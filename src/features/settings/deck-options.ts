/**
 * Deck options: the settings preset a deck uses.
 *
 * Presets are shared between decks, exactly as in Anki, so the page is
 * explicit about how many decks a change will affect.
 */

import { button, el, field, input, render, select } from '../../ui/dom.js';
import { confirmModal, promptModal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { navigate } from '../../app/router.js';
import type { AppContext } from '../../app/context.js';
import { makeDeckConfig } from '../../domain/defaults.js';
import { LeechAction, NewCardOrder, ReviewOrder, type Deck, type DeckConfig } from '../../domain/types.js';
import { DEFAULT_PARAMS, PARAM_COUNT, validateParams } from '../../fsrs/index.js';
import { optimizerPanel } from './optimizer-panel.js';

export function deckOptions(ctx: AppContext, deckId: string): HTMLElement {
  const root = el('section', {});
  void mount(root, ctx, deckId);
  return root;
}

async function mount(root: HTMLElement, ctx: AppContext, deckId: string): Promise<void> {
  const deck = await ctx.db.decks.get(deckId);
  if (!deck) {
    render(root, el('div.empty', { text: 'That deck no longer exists.' }));
    return;
  }

  const allDecks = await ctx.db.decks.getAll();
  const presets = (await ctx.db.deckConfigs.getAll()).sort((a, b) => a.name.localeCompare(b.name));
  const current = presets.find((p) => p.id === deck.configId) ?? presets[0];
  if (!current) {
    render(root, el('div.empty', { text: 'This collection has no settings presets.' }));
    return;
  }

  // Work on a copy; nothing is written until Save.
  let draft: DeckConfig = { ...current, params: [...current.params] };
  let paramsText = draft.params.map((w) => w.toFixed(4)).join(', ');
  let paramsError = '';

  const sharedWith = allDecks.filter((d) => d.configId === draft.id);

  const draw = (): void => {
    const num = (
      label: string,
      value: number,
      onChange: (value: number) => void,
      attrs: Record<string, string> = {},
    ) =>
      field(
        label,
        input({
          type: 'number',
          value: String(value),
          ...attrs,
          onInput: (ev: Event) => {
            const parsed = Number((ev.target as HTMLInputElement).value);
            if (Number.isFinite(parsed)) onChange(parsed);
          },
        }),
      );

    const steps = (label: string, value: number[], onChange: (value: number[]) => void, hint: string) =>
      el(
        'div',
        {},
        field(
          label,
          input({
            value: value.join(' '),
            placeholder: 'e.g. 1 10',
            onChange: (ev: Event) => {
              onChange(
                (ev.target as HTMLInputElement).value
                  .split(/[\s,]+/)
                  .map(Number)
                  .filter((n) => Number.isFinite(n) && n > 0),
              );
            },
          }),
        ),
        el('p.faint', { text: hint, style: { margin: '2px 0 0' } }),
      );

    render(
      root,
      el(
        'div.row',
        {},
        el('h1', { text: 'Deck options', style: { margin: '0' } }),
        el('div.spacer', {}),
        button('Back to decks', () => navigate('/'), { class: 'ghost' }),
        button('Save', () => void save(), { class: 'primary', 'data-action': 'save' }),
      ),
      el('p.muted', {
        text: `${deck.name} — preset "${draft.name}", shared with ${sharedWith.length} deck${sharedWith.length === 1 ? '' : 's'}.`,
      }),

      // --- preset selection ---
      el(
        'div.card.col',
        {},
        el('h3', { text: 'Preset' }),
        el(
          'div.row',
          {},
          field(
            'Use preset',
            (() => {
              const s = select(presets.map((p) => ({ value: p.id, label: p.name })), {
                onChange: (ev: Event) => {
                  void switchPreset((ev.target as HTMLSelectElement).value);
                },
              });
              s.value = draft.id;
              return s;
            })(),
          ),
          el('div.spacer', {}),
          button('Clone preset…', () => void clonePreset(), {}),
          button('Rename…', () => void renamePreset(), { class: 'ghost' }),
          presets.length > 1
            ? button('Delete preset', () => void deletePreset(), { class: 'danger' })
            : null,
        ),
      ),

      // --- daily limits ---
      el(
        'div.card.col',
        {},
        el('h3', { text: 'Daily limits' }),
        el(
          'div.row',
          {},
          num('New cards / day', draft.newPerDay, (v) => (draft.newPerDay = Math.max(0, Math.round(v))), { min: '0' }),
          num('Maximum reviews / day', draft.reviewsPerDay, (v) => (draft.reviewsPerDay = Math.max(0, Math.round(v))), { min: '0' }),
        ),
        el('p.faint', {
          text: 'Limits apply to the deck you click, and cover its subdecks. Learning cards already in progress are never limited.',
        }),
      ),

      // --- scheduling ---
      el(
        'div.card.col',
        {},
        el('h3', { text: 'Scheduling' }),
        el(
          'div.row',
          {},
          num(
            'Desired retention',
            draft.desiredRetention,
            (v) => (draft.desiredRetention = Math.min(0.99, Math.max(0.7, v))),
            { min: '0.7', max: '0.99', step: '0.01' },
          ),
          num('Maximum interval (days)', draft.maximumInterval, (v) => (draft.maximumInterval = Math.max(1, Math.round(v))), { min: '1' }),
        ),
        el('p.faint', {
          text: `Higher retention means shorter intervals and more reviews. 0.9 is the usual choice; every 0.01 above it costs noticeably more work.`,
        }),
        el(
          'div.row',
          {},
          steps('Learning steps (minutes)', draft.learningSteps, (v) => { draft.learningSteps = v; }, 'Shown to new cards before they graduate. Empty graduates immediately.'),
          steps('Relearning steps (minutes)', draft.relearningSteps, (v) => { draft.relearningSteps = v; }, 'Shown after a lapse. Empty returns the card straight to review.'),
        ),
        el(
          'div.row',
          {},
          field(
            'New card order',
            (() => {
              const s = select(
                [
                  { value: NewCardOrder.Sequential, label: 'Order added' },
                  { value: NewCardOrder.Random, label: 'Random' },
                ],
                { onChange: (ev: Event) => (draft.newCardOrder = (ev.target as HTMLSelectElement).value as NewCardOrder) },
              );
              s.value = draft.newCardOrder;
              return s;
            })(),
          ),
          field(
            'Review order',
            (() => {
              const s = select(
                [
                  { value: ReviewOrder.DueFirst, label: 'Most overdue first' },
                  { value: ReviewOrder.Random, label: 'Random' },
                  { value: ReviewOrder.DifficultyDescending, label: 'Hardest first' },
                ],
                { onChange: (ev: Event) => (draft.reviewOrder = (ev.target as HTMLSelectElement).value as ReviewOrder) },
              );
              s.value = draft.reviewOrder;
              return s;
            })(),
          ),
          checkbox('Bury siblings until tomorrow', draft.burySiblings, (v) => (draft.burySiblings = v)),
          checkbox('Fuzz intervals', draft.enableFuzz, (v) => (draft.enableFuzz = v)),
        ),
      ),

      // --- leeches ---
      el(
        'div.card.col',
        {},
        el('h3', { text: 'Leeches' }),
        el(
          'div.row',
          {},
          num('Lapse threshold', draft.leechThreshold, (v) => (draft.leechThreshold = Math.max(0, Math.round(v))), { min: '0' }),
          field(
            'Action',
            (() => {
              const s = select(
                [
                  { value: LeechAction.Suspend, label: 'Tag and suspend' },
                  { value: LeechAction.TagOnly, label: 'Tag only' },
                ],
                { onChange: (ev: Event) => (draft.leechAction = (ev.target as HTMLSelectElement).value as LeechAction) },
              );
              s.value = draft.leechAction;
              return s;
            })(),
          ),
        ),
        el('p.faint', { text: 'A card that lapses this many times is tagged "leech". 0 disables leech handling.' }),
      ),

      // --- FSRS parameters ---
      el(
        'div.card.col',
        {},
        el('h3', { text: 'FSRS parameters' }),
        el('p.faint', {
          text: `The ${PARAM_COUNT} weights of the memory model. Optimise them against your own review history below, or paste a set from elsewhere.`,
        }),
        field(
          'Weights',
          (() => {
            const control = el('textarea', {
              rows: '3',
              value: paramsText,
              'data-role': 'params',
              style: { fontFamily: 'var(--mono)', fontSize: '0.85rem' },
              onInput: (ev: Event) => {
                paramsText = (ev.target as HTMLTextAreaElement).value;
                const parsed = parseParams(paramsText);
                paramsError = parsed.error;
                const holder = root.querySelector('[data-role="params-error"]');
                if (holder) holder.textContent = paramsError;
              },
            }) as HTMLTextAreaElement;
            return control;
          })(),
        ),
        el('p', { 'data-role': 'params-error', text: paramsError, style: { color: 'var(--danger)', fontSize: '0.85rem', margin: '0' } }),
        el(
          'div.row',
          {},
          button(
            'Reset to defaults',
            () => {
              draft.params = [...DEFAULT_PARAMS];
              paramsText = draft.params.map((w) => w.toFixed(4)).join(', ');
              paramsError = '';
              draw();
            },
            {},
          ),
        ),
        optimizerPanel(ctx, draft, (params: number[]) => {
          draft.params = params;
          paramsText = params.map((w: number) => w.toFixed(4)).join(', ');
          paramsError = '';
          draw();
        }),
      ),
    );
  };

  const switchPreset = async (presetId: string): Promise<void> => {
    const preset = presets.find((p) => p.id === presetId);
    if (!preset) return;
    await ctx.db.decks.put({ ...deck, configId: preset.id, modified: Date.now() });
    toast(`"${deck.name}" now uses "${preset.name}".`, 'success');
    void mount(root, ctx, deckId);
  };

  const clonePreset = async (): Promise<void> => {
    const name = await promptModal('Clone preset', 'Name for the new preset', `${draft.name} copy`, 'Clone');
    if (!name) return;
    const clone: DeckConfig = { ...makeDeckConfig(name), ...draft, id: makeDeckConfig(name).id, name, created: Date.now(), modified: Date.now() };
    await ctx.db.deckConfigs.put(clone);
    await ctx.db.decks.put({ ...deck, configId: clone.id, modified: Date.now() });
    toast(`Created "${name}" and applied it to this deck.`, 'success');
    void mount(root, ctx, deckId);
  };

  const renamePreset = async (): Promise<void> => {
    const name = await promptModal('Rename preset', 'Name', draft.name, 'Rename');
    if (!name) return;
    draft.name = name;
    await ctx.db.deckConfigs.put({ ...draft, modified: Date.now() });
    toast('Preset renamed.', 'success');
    void mount(root, ctx, deckId);
  };

  const deletePreset = async (): Promise<void> => {
    const fallback = presets.find((p) => p.id !== draft.id);
    if (!fallback) return;
    const users = allDecks.filter((d: Deck) => d.configId === draft.id);
    const ok = await confirmModal(
      'Delete preset',
      el(
        'div',
        {},
        el('p', { text: `Delete the preset "${draft.name}"?` }),
        el('p.muted', { text: `${users.length} deck(s) will fall back to "${fallback.name}".` }),
      ),
      'Delete',
      true,
    );
    if (!ok) return;

    await ctx.db.decks.putMany(users.map((d) => ({ ...d, configId: fallback.id, modified: Date.now() })));
    await ctx.db.deckConfigs.delete(draft.id);
    toast('Preset deleted.', 'success');
    void mount(root, ctx, deckId);
  };

  const save = async (): Promise<void> => {
    const parsed = parseParams(paramsText);
    if (parsed.error) {
      toast(parsed.error, 'error');
      return;
    }
    draft.params = parsed.params;
    await ctx.db.deckConfigs.put({ ...draft, modified: Date.now() });
    toast(
      sharedWith.length > 1
        ? `Saved. ${sharedWith.length} decks use this preset.`
        : 'Saved.',
      'success',
    );
  };

  draw();
}

function checkbox(label: string, value: boolean, onChange: (value: boolean) => void): HTMLElement {
  return el(
    'label.field',
    {},
    el('span', { text: label }),
    input({
      type: 'checkbox',
      checked: value,
      style: { width: 'auto' },
      onChange: (ev: Event) => onChange((ev.target as HTMLInputElement).checked),
    }),
  );
}

/** Parse a pasted weight list, reporting the first thing wrong with it. */
export function parseParams(text: string): { params: number[]; error: string } {
  const parts = text
    .replace(/[[\]]/g, '')
    .split(/[\s,]+/)
    .filter(Boolean);

  if (parts.length !== PARAM_COUNT) {
    return { params: [], error: `Expected ${PARAM_COUNT} weights, found ${parts.length}.` };
  }

  const params = parts.map(Number);
  const bad = params.findIndex((n) => !Number.isFinite(n));
  if (bad >= 0) return { params: [], error: `Weight ${bad + 1} ("${parts[bad]}") is not a number.` };

  const problems = validateParams(params);
  if (problems.length > 0) return { params: [], error: problems[0]!.message };

  return { params, error: '' };
}
