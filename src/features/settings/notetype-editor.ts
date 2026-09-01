/**
 * The note type editor: fields, templates and styling, with a live preview
 * rendered from a real note of that type where one exists.
 */

import { button, el, field, input, render, textarea } from '../../ui/dom.js';
import { confirmModal, promptModal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { navigate } from '../../app/router.js';
import type { AppContext } from '../../app/context.js';
import { generateOrds, renderCard } from '../../domain/cards.js';
import { NoteTypeKind, type NoteType } from '../../domain/types.js';
import {
  addField,
  addTemplate,
  moveField,
  removeField,
  removeTemplate,
  renameField,
  resyncCards,
  updateNoteType,
} from '../../collection/notetypes.js';

export function noteTypeEditor(ctx: AppContext, noteTypeId: string): HTMLElement {
  const root = el('section', {});
  void mount(root, ctx, noteTypeId);
  return root;
}

async function mount(root: HTMLElement, ctx: AppContext, noteTypeId: string): Promise<void> {
  const noteType = await ctx.db.noteTypes.get(noteTypeId);
  if (!noteType) {
    render(root, el('div.empty', { text: 'That note type no longer exists.' }));
    return;
  }

  const notes = await ctx.db.notes.byIndex('noteTypeId', noteTypeId);
  const sample = notes[0]?.fields ?? sampleFields(noteType);

  // Templates and CSS are edited as a draft; field operations write
  // immediately, because they have to migrate notes as they go.
  let templates = noteType.templates.map((t) => ({ ...t }));
  let css = noteType.css;
  let selected = 0;

  const reload = () => void mount(root, ctx, noteTypeId);

  const draw = (): void => {
    const isCloze = noteType.kind === NoteTypeKind.Cloze;
    const template = templates[Math.min(selected, templates.length - 1)];

    const previewOrds = generateOrds({ ...noteType, templates }, sample);
    const previewOrd = isCloze ? (previewOrds[0] ?? 1) : Math.min(selected, templates.length - 1);
    const preview = renderCard({ ...noteType, templates, css }, sample, previewOrd);

    render(
      root,
      el(
        'div.row',
        {},
        el('h1', { text: noteType.name, style: { margin: '0' } }),
        el('div.spacer', {}),
        el('span.muted', { text: `${notes.length} note${notes.length === 1 ? '' : 's'}` }),
        button('Back to settings', () => navigate('/settings'), { class: 'ghost' }),
        button('Save', () => void save(), { class: 'primary', 'data-action': 'save-notetype' }),
      ),

      // --- fields ---
      el(
        'div.card.col',
        {},
        el(
          'div.row',
          {},
          el('h3', { text: 'Fields', style: { margin: '0' } }),
          el('div.spacer', {}),
          button('Add field', () => void doAddField(), { 'data-action': 'add-field' }),
        ),
        el(
          'table',
          {},
          el(
            'tbody',
            {},
            noteType.fields.map((f, index) =>
              el(
                'tr',
                { 'data-field-row': f.name },
                el('td', { text: f.name }),
                el('td.muted', { text: index === noteType.sortField ? 'sort field' : '' }),
                el(
                  'td',
                  { style: { textAlign: 'right' } },
                  button('↑', () => void move(index, index - 1), {
                    class: 'ghost',
                    disabled: index === 0,
                    'aria-label': `Move ${f.name} up`,
                  }),
                  button('↓', () => void move(index, index + 1), {
                    class: 'ghost',
                    disabled: index === noteType.fields.length - 1,
                    'aria-label': `Move ${f.name} down`,
                  }),
                  button('Rename', () => void doRenameField(f.name), { class: 'ghost' }),
                  button('Delete', () => void doRemoveField(f.name), {
                    class: 'ghost',
                    disabled: noteType.fields.length <= 1,
                  }),
                ),
              ),
            ),
          ),
        ),
        el('p.faint', {
          text: 'Renaming a field updates every note and every template that mentions it. Deleting one discards that field’s content in every note.',
        }),
      ),

      // --- templates ---
      el(
        'div.card.col',
        {},
        el(
          'div.row',
          {},
          el('h3', { text: 'Templates', style: { margin: '0' } }),
          el('div.spacer', {}),
          isCloze
            ? el('span.faint', { text: 'A cloze note type has one template; its cards come from the deletions.' })
            : button('Add card type', () => void doAddTemplate(), { 'data-action': 'add-template' }),
        ),
        isCloze || templates.length <= 1
          ? null
          : el(
              'div.range-tabs',
              {},
              templates.map((t, index) =>
                button(t.name, () => {
                    selected = index;
                    draw();
                  },
                  { 'aria-pressed': index === selected ? 'true' : 'false' },
                ),
              ),
              button('Delete this card type', () => void doRemoveTemplate(selected), { class: 'danger' }),
            ),
        template
          ? el(
              'div.editor-grid',
              {},
              el(
                'div.col',
                {},
                field(
                  'Name',
                  input({
                    value: template.name,
                    disabled: isCloze,
                    onInput: (ev: Event) => {
                      template.name = (ev.target as HTMLInputElement).value;
                    },
                  }),
                ),
                field(
                  'Front template',
                  textarea({
                    value: template.question,
                    rows: '5',
                    'data-role': 'question-template',
                    style: { fontFamily: 'var(--mono)', fontSize: '0.85rem' },
                    onInput: (ev: Event) => {
                      template.question = (ev.target as HTMLTextAreaElement).value;
                      draw();
                    },
                  }),
                ),
                field(
                  'Back template',
                  textarea({
                    value: template.answer,
                    rows: '5',
                    style: { fontFamily: 'var(--mono)', fontSize: '0.85rem' },
                    onInput: (ev: Event) => {
                      template.answer = (ev.target as HTMLTextAreaElement).value;
                      draw();
                    },
                  }),
                ),
                el('p.faint', {
                  text: `Available: ${noteType.fields.map((f) => `{{${f.name}}}`).join(' ')} {{FrontSide}} · filters text: hint: ${isCloze ? 'cloze: ' : ''}· conditionals {{#Field}}…{{/Field}}`,
                }),
              ),
              el(
                'div.col',
                {},
                el('div.preview-label', { text: 'Front' }),
                el('div.preview-card', { html: preview.question, 'data-preview': 'question' }),
                el('div.preview-label', { text: 'Back', style: { marginTop: '10px' } }),
                el('div.preview-card', { html: preview.answer, 'data-preview': 'answer' }),
                notes.length === 0
                  ? el('p.faint', { text: 'No notes of this type yet, so the preview uses placeholder text.' })
                  : null,
              ),
            )
          : null,
      ),

      // --- styling ---
      el(
        'div.card.col',
        {},
        el('h3', { text: 'Styling' }),
        field(
          'CSS applied to this note type’s cards',
          textarea({
            value: css,
            rows: '6',
            style: { fontFamily: 'var(--mono)', fontSize: '0.85rem' },
            onInput: (ev: Event) => {
              css = (ev.target as HTMLTextAreaElement).value;
            },
          }),
        ),
      ),
    );
  };

  const save = async (): Promise<void> => {
    try {
      await updateNoteType(ctx.db, noteTypeId, { templates, css });
      const result = await resyncCards(ctx.db, noteTypeId);
      const detail =
        result.added || result.removed
          ? ` (${result.added} card(s) added, ${result.removed} removed)`
          : '';
      toast(`Saved.${detail}`, 'success');
      reload();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const guard = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
      reload();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const doAddField = async (): Promise<void> => {
    const name = await promptModal('Add field', 'Field name', '', 'Add');
    if (!name) return;
    await guard(() => addField(ctx.db, noteTypeId, name));
  };

  const doRenameField = async (from: string): Promise<void> => {
    const to = await promptModal('Rename field', 'New name', from, 'Rename');
    if (!to || to === from) return;
    await guard(() => renameField(ctx.db, noteTypeId, from, to));
  };

  const doRemoveField = async (name: string): Promise<void> => {
    const ok = await confirmModal(
      'Delete field',
      el(
        'div',
        {},
        el('p', { text: `Delete the field "${name}"?` }),
        el('p.muted', { text: `Its content is removed from all ${notes.length} note(s). This cannot be undone.` }),
      ),
      'Delete',
      true,
    );
    if (!ok) return;
    await guard(() => removeField(ctx.db, noteTypeId, name));
  };

  const move = async (from: number, to: number): Promise<void> => {
    await guard(() => moveField(ctx.db, noteTypeId, from, to));
  };

  const doAddTemplate = async (): Promise<void> => {
    const name = await promptModal('Add card type', 'Name', `Card ${templates.length + 1}`, 'Add');
    if (!name) return;
    const first = noteType.fields[0]?.name ?? 'Front';
    const second = noteType.fields[1]?.name ?? first;
    await guard(() =>
      addTemplate(ctx.db, noteTypeId, {
        name,
        question: `{{${second}}}`,
        answer: `{{FrontSide}}<hr>{{${first}}}`,
      }),
    );
  };

  const doRemoveTemplate = async (index: number): Promise<void> => {
    const victim = templates[index];
    if (!victim) return;
    const ok = await confirmModal(
      'Delete card type',
      el(
        'div',
        {},
        el('p', { text: `Delete the card type "${victim.name}"?` }),
        el('p.muted', {
          text: 'Every card generated from it is deleted, along with its review history. This cannot be undone.',
        }),
      ),
      'Delete',
      true,
    );
    if (!ok) return;
    selected = 0;
    await guard(() => removeTemplate(ctx.db, noteTypeId, index));
  };

  draw();
}

/** Placeholder content, so a brand-new note type still previews. */
function sampleFields(noteType: NoteType): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [index, f] of noteType.fields.entries()) {
    fields[f.name] =
      noteType.kind === NoteTypeKind.Cloze && index === 0
        ? 'The capital of {{c1::France}} is {{c2::Paris}}.'
        : `[${f.name}]`;
  }
  return fields;
}
