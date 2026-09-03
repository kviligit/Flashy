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
  let tagsText = (editing?.tags ?? []).join(' ');
  const media = new MediaResolver(ctx.db);

  const draw = (): void => {
    /** Field name -> apply a prefix to that field's current text. */
    const prefixers = new Map<string, (text: string) => void>();
    const inserters = new Map<string, (text: string) => void>();
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
          // The palette pops up over this block rather than pushing it
          // down, so the fields below never move while symbols are being
          // inserted into a sentence.
          symbolTabs(() => lastFocusedField, inserters, () =>
            el(
              'div.editor-top',
              {},
              el('div.row', {}, field('Type', noteTypeSelect), field('Deck', deckSelect)),
              snippetBar(() => lastFocusedField, prefixers),
            ),
          ),
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
function symbolTabs(
  targetField: () => string | undefined,
  inserters: Map<string, (text: string) => void>,
  covered: () => HTMLElement,
): HTMLElement {
  const block = covered();
  if (inserters.size === 0) return block;

  const popover = el('div.symbol-popover', { hidden: true, 'data-symbols': 'true' });
  const tabs = el('div.symbol-tabs', { role: 'tablist' });
  let open: string | null = null;

  const show = (name: string | null): void => {
    open = name;
    rememberCategory(name);

    for (const tab of Array.from(tabs.children)) {
      const isOpen = tab.getAttribute('data-category') === name;
      tab.classList.toggle('active', isOpen);
      tab.setAttribute('aria-expanded', String(isOpen));
    }

    if (name === null) {
      // Emptied, not just hidden: leaving a category's buttons in the DOM
      // behind `hidden` means anything looking for a symbol still finds
      // one, which is confusing for assistive technology and for tests.
      render(popover);
      popover.hidden = true;
      return;
    }

    const group = SYMBOL_GROUPS.find((candidate) => candidate.name === name);
    if (!group) {
      popover.hidden = true;
      return;
    }

    render(
      popover,
      // No category heading: the active tab directly above already says
      // which group this is, and the row it would take is a row of keys.
      el(
        'div.symbol-popover-head',
        {},
        button('✕', () => show(null), {
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
            () => {
              const target = targetField();
              if (target) inserters.get(target)?.(textFor(symbol));
              // Deliberately left open: the next symbol is usually one tap
              // away, and closing after each would double the work.
            },
            {
              class: 'ghost symbol-key',
              'data-symbol': symbol.char,
              title: `${symbol.char} — ${symbol.name}`,
              'aria-label': symbol.name,
            },
          ),
        ),
      ),
    );
    popover.hidden = false;
  };

  render(
    tabs,
    SYMBOL_GROUPS.map((group) =>
      button(
        group.name,
        () => show(open === group.name ? null : group.name),
        {
          class: 'ghost symbol-tab',
          'data-category': group.name,
          'aria-expanded': 'false',
        },
      ),
    ),
  );

  // The category buttons sit above the block the panel covers, so they
  // stay reachable while it is open: switching from Sets to Logic
  // mid-sentence is one tap, not close-then-reopen.
  const anchor = el('div.symbol-anchor', {}, block, popover);
  const wrapper = el('div.symbol-palette', {}, tabs, anchor);

  // Escape closes it, which is what every other overlay in the app does
  // and what a keyboard user will try first.
  wrapper.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Escape' && open !== null) {
      ev.preventDefault();
      show(null);
    }
  });

  const remembered = rememberedCategory();
  if (remembered && SYMBOL_GROUPS.some((group) => group.name === remembered)) show(remembered);

  return wrapper;
}

const SYMBOLS_CATEGORY_KEY = 'flashy.editor.symbolCategory';

function rememberedCategory(): string | null {
  try {
    return localStorage.getItem(SYMBOLS_CATEGORY_KEY);
  } catch {
    // Private browsing can refuse storage; closed is the right default
    // when we cannot know better.
    return null;
  }
}

function rememberCategory(name: string | null): void {
  try {
    if (name === null) localStorage.removeItem(SYMBOLS_CATEGORY_KEY);
    else localStorage.setItem(SYMBOLS_CATEGORY_KEY, name);
  } catch {
    // Not remembering is a small loss; failing to open the palette is not.
  }
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
