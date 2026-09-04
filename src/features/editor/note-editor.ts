/**
 * The note editor, used both for adding new notes and for editing existing
 * ones. Same fields, same live preview; only the save behaviour differs.
 */

import { button, el, field, input, render, select, textarea } from '../../ui/dom.js';
import { toast } from '../../ui/toast.js';
import { navigate } from '../../app/router.js';
import type { AppContext } from '../../app/context.js';
import { generateOrds, renderCard } from '../../domain/cards.js';
import { deckTag } from '../../domain/decks.js';
import {
  addNote,
  completeFields,
  parseTags,
  replaceTag,
  updateNote,
} from '../../collection/notes.js';
import { addMedia } from '../../collection/media.js';
import { MediaResolver } from '../../ui/media-resolver.js';
import { deferMediaSrc } from '../../domain/media.js';
import { setSafeHtml } from '../../ui/safe-html.js';
import { applyPrefix, SNIPPETS } from './snippets.js';
import { insertAt, looksLikeSwallowedMaths, SYMBOL_GROUPS, textFor } from './symbols.js';
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

  /**
   * The deck's name, as a tag, on new notes only.
   *
   * A deck already says where a card lives; the tag is what makes that
   * searchable from the browser and survives the card being moved later.
   * It is put in the tags field rather than added silently on save, so it
   * is visible before the note exists and can simply be deleted for the
   * one note where it is not wanted.
   *
   * Editing an existing note leaves its tags alone: the deck tag would be
   * a change nobody asked for, applied to notes filed long ago.
   */
  const deckTagFor = (id: string): string =>
    editing ? '' : deckTag(decks.find((d: Deck) => d.id === id)?.name ?? '');

  let autoTag = deckTagFor(deckId);
  let tagsText = editing
    ? (editing.tags ?? []).join(' ')
    : replaceTag('', '', autoTag);
  const media = new MediaResolver(ctx.db);

  const draw = (): void => {
    /** Field name -> apply a prefix to that field's current text. */
    const prefixers = new Map<string, (text: string) => void>();
    const inserters = new Map<string, (text: string) => void>();
    // Only one palette open at a time: the panel above Back covers the
    // Front field, and two of them open at once is just clutter.
    const palettes = new Set<() => void>();
    /**
     * Which field the snippet buttons act on.
     *
     * Read from a focus listener rather than `document.activeElement` at
     * click time: pressing the button moves focus to the button itself, so
     * by then the field the user was in is no longer the active element.
     */
    let lastFocusedField = noteType.fields[0]?.name;

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

      const picker = input({
        type: 'file',
        accept: 'image/*,audio/*',
        multiple: true,
        style: { display: 'none' },
        'data-media-input': f.name,
      });

      /** Insert markup where the cursor is, rather than at the end. */
      const insert = (markup: string): void => {
        const start = control.selectionStart ?? control.value.length;
        const end = control.selectionEnd ?? start;
        const before = control.value.slice(0, start);
        const after = control.value.slice(end);
        control.value = `${before}${markup}${after}`;
        fields[f.name] = control.value;
        const caret = start + markup.length;
        control.setSelectionRange(caret, caret);
        control.focus();
        drawPreview();
      };

      const attach = async (files: FileList | null): Promise<void> => {
        if (!files || files.length === 0) return;
        for (const file of Array.from(files)) {
          try {
            const result = await addMedia(ctx.db, {
              filename: file.name,
              mime: file.type,
              data: await file.arrayBuffer(),
            });
            insert(result.tag);
            toast(
              result.deduplicated
                ? `Reused "${result.file.filename}", which was already in the collection.`
                : `Attached "${result.file.filename}".`,
              'success',
            );
          } catch (error) {
            toast(error instanceof Error ? error.message : String(error), 'error');
          }
        }
      };

      control.addEventListener('focus', () => {
        lastFocusedField = f.name;
      });

      // Insertion at the caret, which is a different operation from the
      // stock openings: a symbol goes where you are, an opening goes at
      // the front. A textarea keeps its selection while blurred, so the
      // caret read here is still the one the user left behind when they
      // reached for the button.
      inserters.set(f.name, (text: string) => {
        const { value: next, caret } = insertAt(
          control.value,
          control.selectionStart ?? control.value.length,
          control.selectionEnd ?? control.value.length,
          text,
        );
        control.value = next;
        fields[f.name] = next;
        control.focus();
        control.setSelectionRange(caret, caret);
        drawPreview();
      });

      prefixers.set(f.name, (text: string) => {
        const next = applyPrefix(control.value, text);
        control.value = next;
        fields[f.name] = next;
        // Leave the cursor after the inserted opening, ready to type.
        const caret = Math.min(text.length, next.length);
        control.setSelectionRange(caret, caret);
        control.focus();
        drawPreview();
      });

      picker.addEventListener('change', () => {
        void attach(picker.files).finally(() => {
          picker.value = '';
        });
      });

      // Dropping a file onto the field is the fastest way to attach one.
      control.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        control.classList.add('drop-target');
      });
      control.addEventListener('dragleave', () => control.classList.remove('drop-target'));
      control.addEventListener('drop', (ev) => {
        ev.preventDefault();
        control.classList.remove('drop-target');
        void attach(ev.dataTransfer?.files ?? null);
      });

      // So is pasting a screenshot.
      control.addEventListener('paste', (ev) => {
        const items = ev.clipboardData?.files;
        if (items && items.length > 0) {
          ev.preventDefault();
          void attach(items);
        }
      });

      return el(
        'div.field-editor',
        {},
        el(
          'div.row',
          { style: { alignItems: 'baseline' } },
          el('span.field-label', { text: f.name }),
          el('div.spacer', {}),
          button('Attach…', () => picker.click(), {
            class: 'ghost',
            'data-action': `attach-${f.name}`,
            title: 'Add an image or sound. You can also drag one in, or paste a screenshot.',
          }),
        ),
        // Directly above this field's own textarea, and inserting into
        // that field rather than into whichever one was last touched.
        symbolPalette(f.name, inserters, palettes, control),
        control,
        picker,
      );
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
          // Follow the deck: the old deck's tag goes, the new one's
          // arrives, and anything typed by hand is left untouched.
          const next = deckTagFor(deckId);
          tagsText = replaceTag(tagsText, autoTag, next);
          autoTag = next;
          tagsInput.value = tagsText;
        },
      },
    );
    deckSelect.value = deckId;

    const tagsInput = input({
      value: tagsText,
      'data-tags': 'true',
      'aria-label': 'Tags',
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

      const paint = (node: HTMLElement): HTMLElement => {
        void media.resolve(node);
        return node;
      };

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
        // `<a,b>` is parsed as an anchor tag and vanishes. Saying so beats
        // leaving someone to work out why their ordered pair is missing
        // from a preview that is otherwise working perfectly.
        Object.values(fields).some(looksLikeSwallowedMaths)
          ? el('div.notice', {
              'data-notice': 'html-eats-angle-brackets',
              text:
                'Card text is HTML, so "<" followed by a letter starts a tag: <a,b> disappears. Use the ⟨ ⟩ buttons for an ordered pair, or the < > buttons for a literal bracket.',
            })
          : null,
        ords.length === 0
          ? el('div.empty', {
              text:
                noteType.kind === 'cloze'
                  ? 'Add a deletion like {{c1::this}} to make a card.'
                  : 'Fill in a field to make a card.',
            })
          : ords.map((ord) => {
              const { question, answer } = renderCard(noteType, complete, ord);
              return paint(
                el(
                  'div.card',
                  {},
                  el('div.preview-label', {
                    text:
                      noteType.kind === 'cloze'
                        ? `Cloze ${ord}`
                        : (noteType.templates[ord]?.name ?? `Card ${ord + 1}`),
                  }),
                  safeCard(deferMediaSrc(question), 'question'),
                  safeCard(deferMediaSrc(answer), 'answer'),
                ),
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
          snippetBar(() => lastFocusedField, prefixers),
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

  // Object URLs live until they are revoked, so let them go once the router
  // has swapped this screen out.
  const watcher = new MutationObserver(() => {
    if (root.isConnected) return;
    watcher.disconnect();
    media.dispose();
  });
  watcher.observe(document.body, { childList: true, subtree: true });
}


/**
 * The stock-opening buttons.
 *
 * They act on the field the user was last in, which defaults to the first —
 * the one someone means by "start the card with".
 */
function snippetBar(
  targetField: () => string | undefined,
  prefixers: Map<string, (text: string) => void>,
): HTMLElement | null {
  if (SNIPPETS.length === 0 || prefixers.size === 0) return null;

  return el(
    'div.snippet-bar',
    {},
    el('span.faint', { text: 'Start with' }),
    SNIPPETS.map((snippet) =>
      button(
        snippet.label,
        () => {
          const target = targetField();
          if (target) prefixers.get(target)?.(snippet.text);
        },
        {
          class: 'ghost',
          'data-snippet': snippet.label,
          title: snippet.title ?? `Insert "${snippet.text}"`,
        },
      ),
    ),
  );
}


/**
 * The mathematical symbol palette.
 *
 * One button per category, and pressing one opens that category's symbols
 * over the note-type and deck controls above the fields. Overlaying
 * rather than expanding is the point: a sentence with five symbols in it
 * means five trips to the palette, and a panel that pushed the fields
 * down would move the text out from under the cursor every time it opened
 * or closed.
 *
 * The panel stays open after an insertion, and the inserter puts the
 * caret back in the field, so the next character typed lands where it
 * should without anyone having to tap back into the textarea.
 */
/**
 * Keep an upward-opening panel inside the viewport.
 *
 * The panel opens above its field so the field stays visible while
 * symbols go into it. Near the top of a short viewport — which is what an
 * on-screen keyboard leaves — there may not be room above, and the first
 * rows of symbols end up off-screen.
 *
 * Two moves, in order. Scroll the page down so the panel comes into view,
 * which costs nothing and keeps every symbol reachable. If the page is
 * already at the top and cannot scroll, cap the panel to the room that
 * actually exists and let it scroll internally — worse, but reachable,
 * which a clipped panel is not.
 */
function fitAbove(popover: HTMLElement, tabs: HTMLElement, control: HTMLElement): void {
  const gap = 8;
  // The top bar is sticky, so "inside the viewport" is not good enough: a
  // panel flush with y=0 has its first row of symbols behind the nav.
  const bar = document.querySelector('.topbar');
  const ceiling = (bar ? bar.getBoundingClientRect().bottom : 0) + gap;

  popover.style.maxHeight = '';
  popover.style.overflowY = '';

  // The field wins. It is the thing being typed into, and a panel that
  // pushed it off the bottom of a keyboard-sized viewport would have
  // defeated the point of moving the palette here at all.
  const overshoot = control.getBoundingClientRect().bottom - (window.innerHeight - gap);
  if (overshoot > 0) window.scrollBy(0, overshoot);

  // Then bring the panel down out from under the bar, as far as the page
  // will allow without pushing the field back off.
  const room = () => tabs.getBoundingClientRect().top - ceiling - gap;
  if (popover.offsetHeight > room()) {
    const slack = Math.max(
      0,
      window.innerHeight - gap - control.getBoundingClientRect().bottom,
    );
    if (slack > 0) window.scrollBy(0, -Math.min(slack, popover.offsetHeight - room()));
  }

  // Whatever room is left after that is what the panel gets. Scrolling a
  // few rows inside it is worse than not scrolling, and far better than
  // symbols that cannot be reached at all.
  const available = room();
  if (popover.offsetHeight > available) {
    popover.style.maxHeight = `${Math.max(120, available)}px`;
    popover.style.overflowY = 'auto';
  }
}

/**
 * A symbol palette for one field.
 *
 * It sits directly above that field's textarea and inserts into that
 * field only — no guessing at which field was last touched. With an
 * on-screen keyboard up there is very little page left, and this is the
 * part that has to be inside it.
 *
 * The panel opens *upward*, over whatever is above: the field it belongs
 * to must stay visible while symbols are being put into it, and anything
 * higher up the page is not being typed into.
 */
function symbolPalette(
  fieldName: string,
  inserters: Map<string, (text: string) => void>,
  palettes: Set<() => void>,
  control: HTMLElement,
): HTMLElement {
  const popover = el('div.symbol-popover', { hidden: true, 'data-symbols': fieldName });
  const tabs = el('div.symbol-tabs', { 'data-tabs': fieldName });
  let open: string | null = null;

  const close = (): void => {
    open = null;
    render(popover);
    popover.hidden = true;
    popover.style.maxHeight = '';
    popover.style.overflowY = '';
    for (const tab of Array.from(tabs.children)) {
      tab.classList.remove('active');
      tab.setAttribute('aria-expanded', 'false');
    }
  };
  palettes.add(close);

  const show = (name: string | null): void => {
    if (name === null || name === open) {
      close();
      return;
    }

    // Close whatever else is open first, including this one's own panel,
    // so switching category re-renders from a clean state.
    for (const other of palettes) other();
    open = name;

    for (const tab of Array.from(tabs.children)) {
      const isOpen = tab.getAttribute('data-category') === name;
      tab.classList.toggle('active', isOpen);
      tab.setAttribute('aria-expanded', String(isOpen));
    }

    const group = SYMBOL_GROUPS.find((candidate) => candidate.name === name);
    if (!group) return;

    render(
      popover,
      el(
        'div.symbol-popover-head',
        {},
        button('✕', () => close(), {
          class: 'ghost symbol-close',
          'data-action': 'close-symbols',
          title: 'Close the symbol palette',
          'aria-label': 'Close the symbol palette',
        }),
      ),
      el(
        'div.symbol-keys',
        {},
        group.symbols.map((symbol) =>
          button(
            symbol.char,
            () => inserters.get(fieldName)?.(textFor(symbol)),
            {
              class: 'ghost symbol-key',
              'data-symbol': symbol.char,
              title: `${symbol.char} — ${symbol.name}`,
              'aria-label': symbol.name,
              // Keeps the textarea focused, so the on-screen keyboard does
              // not close and reopen on every symbol. Without this, iOS
              // dismisses it the moment the button takes focus.
              onMousedown: (ev: Event) => ev.preventDefault(),
              onTouchstart: (ev: Event) => ev.preventDefault(),
            },
          ),
        ),
      ),
    );
    popover.hidden = false;
    fitAbove(popover, tabs, control);
  };

  render(
    tabs,
    SYMBOL_GROUPS.map((group) =>
      button(group.name, () => show(group.name), {
        class: 'ghost symbol-tab',
        'data-category': group.name,
        'aria-expanded': 'false',
        onMousedown: (ev: Event) => ev.preventDefault(),
      }),
    ),
  );

  const wrapper = el('div.symbol-palette', {}, popover, tabs);
  wrapper.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Escape' && open !== null) {
      ev.preventDefault();
      close();
    }
  });
  return wrapper;
}


/**
 * A preview panel holding untrusted card content.
 *
 * Card HTML comes from whoever wrote the deck, so it goes through the
 * sanitiser rather than straight into innerHTML.
 */
function safeCard(html: string, side?: string): HTMLElement {
  const node = el('div.preview-card', side ? { 'data-preview': side } : {});
  setSafeHtml(node, html);
  return node;
}
