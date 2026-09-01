/**
 * The note editor, used both for adding new notes and for editing existing
 * ones. Same fields, same live preview; only the save behaviour differs.
 */

import { button, el, field, input, render, select, textarea } from '../../ui/dom.js';
import { toast } from '../../ui/toast.js';
import { navigate } from '../../app/router.js';
import type { AppContext } from '../../app/context.js';
import { generateOrds, renderCard } from '../../domain/cards.js';
import { addNote, completeFields, parseTags, updateNote } from '../../collection/notes.js';
import type { Deck, Note, NoteType } from '../../domain/types.js';

export interface EditorOptions {
  /** Editing an existing note, rather than adding a new one. */
  noteId?: string;
  /** Deck to add to; ignored when editing. */
  deckId?: string;
  /** Called after a successful save. */
  onSaved?: () => void;
}

export function noteEditor(ctx: AppContext, options: EditorOptions = {}): HTMLElement {
  const root = el('section', {});
  void mount(root, ctx, options);
  return root;
}

async function mount(root: HTMLElement, ctx: AppContext, options: EditorOptions): Promise<void> {
  const noteTypes = await ctx.db.noteTypes.getAll();
  const decks = await ctx.db.decks.getAll();
  noteTypes.sort((a, b) => a.name.localeCompare(b.name));
  decks.sort((a, b) => a.name.localeCompare(b.name));

  if (noteTypes.length === 0 || decks.length === 0) {
    render(root, el('div.empty', { text: 'The collection has no note types or decks yet.' }));
    return;
  }

  const editing: Note | null = options.noteId ? await ctx.db.notes.get(options.noteId) : null;
  if (options.noteId && !editing) {
    render(root, el('div.empty', { text: 'That note no longer exists.' }));
    return;
  }

  // Editing is locked to the note's own type: changing it would have to
  // remap fields and would throw away the note's cards.
  let noteType: NoteType =
    (editing ? noteTypes.find((nt) => nt.id === editing.noteTypeId) : undefined) ??
    noteTypes[0]!;

  let deckId =
    options.deckId ??
    (editing ? (await ctx.db.cards.byIndex('noteId', editing.id))[0]?.deckId : undefined) ??
    decks[0]!.id;

  let fields: Record<string, string> = completeFields(noteType, editing?.fields ?? {});
  let tagsText = (editing?.tags ?? []).join(' ');

  const draw = (): void => {
    const inputs = noteType.fields.map((f) => {
      const control = textarea({
        value: fields[f.name] ?? '',
        rows: '2',
        dir: f.rtl ? 'rtl' : 'auto',
        'data-field': f.name,
        onInput: (ev: Event) => {
          fields[f.name] = (ev.target as HTMLTextAreaElement).value;
          drawPreview();
        },
      });
      return el('div.field-editor', {}, field(f.name, control));
    });

    const noteTypeSelect = select(
      noteTypes.map((nt) => ({ value: nt.id, label: nt.name })),
      {
        value: noteType.id,
        disabled: editing !== null,
        title: editing ? 'The note type cannot be changed while editing.' : '',
        onChange: (ev: Event) => {
          const chosen = noteTypes.find((nt) => nt.id === (ev.target as HTMLSelectElement).value);
          if (!chosen) return;
          noteType = chosen;
          fields = completeFields(noteType, fields);
          draw();
        },
      },
    );
    noteTypeSelect.value = noteType.id;

    const deckSelect = select(
      decks.map((d: Deck) => ({ value: d.id, label: d.name })),
      {
        value: deckId,
        onChange: (ev: Event) => {
          deckId = (ev.target as HTMLSelectElement).value;
        },
      },
    );
    deckSelect.value = deckId;

    const tagsInput = input({
      value: tagsText,
      placeholder: 'space-separated',
      onInput: (ev: Event) => {
        tagsText = (ev.target as HTMLInputElement).value;
      },
    });

    const previewHost = el('div.col', {});
    const saveButton = button(editing ? 'Save changes' : 'Add note', () => void save(), {
      class: 'primary',
    });

    const drawPreview = (): void => {
      const complete = completeFields(noteType, fields);
      const ords = generateOrds(noteType, complete);
      saveButton.disabled = ords.length === 0;

      render(
        previewHost,
        el(
          'div.row',
          {},
          el('h3', { text: 'Preview', style: { margin: '0' } }),
          el('div.spacer', {}),
          el('span.muted', {
            'data-card-count': String(ords.length),
            text: ords.length === 1 ? '1 card' : `${ords.length} cards`,
          }),
        ),
        ords.length === 0
          ? el('div.empty', {
              text:
                noteType.kind === 'cloze'
                  ? 'Add a deletion like {{c1::this}} to make a card.'
                  : 'Fill in a field to make a card.',
            })
          : ords.map((ord) => {
              const { question, answer } = renderCard(noteType, complete, ord);
              return el(
                'div.card',
                {},
                el('div.preview-label', {
                  text: noteType.kind === 'cloze' ? `Cloze ${ord}` : (noteType.templates[ord]?.name ?? `Card ${ord + 1}`),
                }),
                el('div.preview-card', { html: question, 'data-preview': 'question' }),
                el('div.preview-card', { html: answer, 'data-preview': 'answer' }),
              );
            }),
      );
    };

    const save = async (): Promise<void> => {
      try {
        if (editing) {
          const result = await updateNote(ctx.db, editing.id, {
            fields: completeFields(noteType, fields),
            tags: parseTags(tagsText),
            deckId,
          });
          const detail =
            result.added || result.removed
              ? ` (${result.added} card(s) added, ${result.removed} removed)`
              : '';
          toast(`Saved.${detail}`, 'success');
          options.onSaved?.();
        } else {
          await addNote(ctx.db, {
            noteTypeId: noteType.id,
            deckId,
            fields: completeFields(noteType, fields),
            tags: parseTags(tagsText),
          });
          toast('Note added.', 'success');

          // Keep sticky fields, clear the rest, and put the cursor back in
          // the first field so a run of notes can be typed without pausing.
          for (const f of noteType.fields) if (!f.sticky) fields[f.name] = '';
          draw();
          root.querySelector<HTMLTextAreaElement>('textarea[data-field]')?.focus();
          options.onSaved?.();
        }
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), 'error');
      }
    };

    render(
      root,
      el(
        'div.row',
        {},
        el('h1', { text: editing ? 'Edit note' : 'Add note', style: { margin: '0' } }),
        el('div.spacer', {}),
        editing ? button('Back to browser', () => navigate('/browse'), {}) : null,
        saveButton,
      ),
      el(
        'div.editor-grid',
        {},
        el(
          'div.card.col',
          {},
          el('div.row', {}, field('Type', noteTypeSelect), field('Deck', deckSelect)),
          inputs,
          field('Tags', tagsInput),
          el('p.faint', {
            text:
              noteType.kind === 'cloze'
                ? 'Wrap text in {{c1::…}} to make a deletion. Add {{c2::…}} for a second card.'
                : 'Ctrl+Enter saves.',
          }),
        ),
        el('div.card', {}, previewHost),
      ),
    );

    drawPreview();

    root.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
        ev.preventDefault();
        if (!saveButton.disabled) void save();
      }
    });
  };

  draw();
  root.querySelector<HTMLTextAreaElement>('textarea[data-field]')?.focus();
}
