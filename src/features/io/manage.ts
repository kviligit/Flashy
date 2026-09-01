/**
 * Backup, restore and CSV exchange, as a page.
 *
 * Everything happens locally: a download is a Blob URL, an upload is a
 * FileReader. Nothing is ever sent anywhere.
 */

import { button, el, field, input, render, select } from '../../ui/dom.js';
import { confirmModal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import type { AppContext } from '../../app/context.js';
import {
  exportCollection,
  exportCsv,
  importCollection,
  importCsv,
  previewCsv,
  validateExport,
  type ImportMode,
} from '../../collection/io.js';
import type { Deck, NoteType } from '../../domain/types.js';

export function managePage(ctx: AppContext): HTMLElement {
  const root = el('section', {});
  void draw(root, ctx);
  return root;
}

async function draw(root: HTMLElement, ctx: AppContext): Promise<void> {
  const noteTypes = (await ctx.db.noteTypes.getAll()).sort((a, b) => a.name.localeCompare(b.name));
  const decks = (await ctx.db.decks.getAll()).sort((a, b) => a.name.localeCompare(b.name));
  const counts = {
    decks: decks.length,
    notes: await ctx.db.notes.count(),
    cards: await ctx.db.cards.count(),
    reviews: await ctx.db.reviewLogs.count(),
  };

  render(
    root,
    el('h1', { text: 'Import & export' }),
    el('p.muted', {
      text: `${counts.decks} decks · ${counts.notes} notes · ${counts.cards} cards · ${counts.reviews} reviews. Everything happens on this device; nothing is uploaded.`,
    }),
    backupCard(ctx, () => void draw(root, ctx)),
    csvExportCard(ctx, noteTypes),
    csvImportCard(ctx, noteTypes, decks, () => void draw(root, ctx)),
  );
}

// --- JSON backup ---------------------------------------------------------

function backupCard(ctx: AppContext, refresh: () => void): HTMLElement {
  const fileInput = input({
    type: 'file',
    accept: 'application/json,.json',
    style: { display: 'none' },
    'data-role': 'backup-file',
  });

  let mode: ImportMode = 'replace';
  const modeSelect = select(
    [
      { value: 'replace', label: 'Replace — wipe this collection first' },
      { value: 'merge', label: 'Merge — keep what is here, add what is new' },
    ],
    {
      onChange: (ev: Event) => {
        mode = (ev.target as HTMLSelectElement).value as ImportMode;
      },
    },
  );

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    void restore(ctx, file, mode, refresh).finally(() => {
      fileInput.value = '';
    });
  });

  return el(
    'div.card.col',
    {},
    el('h3', { text: 'Full backup' }),
    el('p.muted', {
      text: 'A complete copy of the collection, including every card’s scheduling state and its whole review history.',
    }),
    el(
      'div.row',
      {},
      button('Export backup', () => void downloadBackup(ctx), { class: 'primary', 'data-action': 'export-backup' }),
      el('div.spacer', {}),
      field('On import', modeSelect),
      button('Restore from file…', () => fileInput.click(), { 'data-action': 'import-backup' }),
    ),
    fileInput,
  );
}

async function downloadBackup(ctx: AppContext): Promise<void> {
  const data = await exportCollection(ctx.db);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  download(
    `flashy-backup-${stamp}.json`,
    JSON.stringify(data, null, 2),
    'application/json',
  );
  toast(`Exported ${data.notes.length} notes and ${data.cards.length} cards.`, 'success');
}

async function restore(
  ctx: AppContext,
  file: File,
  mode: ImportMode,
  refresh: () => void,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
    validateExport(parsed);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error');
    return;
  }

  if (mode === 'replace') {
    const ok = await confirmModal(
      'Replace collection',
      el(
        'div',
        {},
        el('p', { text: 'This wipes the current collection and restores the backup over it.' }),
        el('p.muted', { text: 'Everything currently here — decks, notes, cards, review history — is deleted. This cannot be undone.' }),
      ),
      'Replace everything',
      true,
    );
    if (!ok) return;
  }

  try {
    const summary = await importCollection(ctx.db, parsed, mode);
    toast(
      `Imported ${summary.notes} notes, ${summary.cards} cards${summary.skipped ? `, skipped ${summary.skipped} existing` : ''}.`,
      'success',
    );
    await ctx.scheduler.load();
    refresh();
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error');
  }
}

// --- CSV export ----------------------------------------------------------

function csvExportCard(ctx: AppContext, noteTypes: NoteType[]): HTMLElement {
  let noteTypeId = '';
  let plainText = false;

  const typeSelect = select(
    [{ value: '', label: 'All note types' }, ...noteTypes.map((nt) => ({ value: nt.id, label: nt.name }))],
    {
      onChange: (ev: Event) => {
        noteTypeId = (ev.target as HTMLSelectElement).value;
      },
    },
  );

  const plainToggle = input({
    type: 'checkbox',
    style: { width: 'auto' },
    onChange: (ev: Event) => {
      plainText = (ev.target as HTMLInputElement).checked;
    },
  });

  return el(
    'div.card.col',
    {},
    el('h3', { text: 'Export notes as CSV' }),
    el('p.muted', {
      text: 'One row per note. Scheduling state is not included — use a full backup for that.',
    }),
    el(
      'div.row',
      {},
      field('Note type', typeSelect),
      el('label.field', {}, el('span', { text: 'Strip HTML' }), plainToggle),
      el('div.spacer', {}),
      button(
        'Export CSV',
        () => {
          void (async () => {
            const csv = await exportCsv(ctx.db, {
              ...(noteTypeId ? { noteTypeId } : {}),
              plainText,
            });
            download(`flashy-notes-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv');
            toast('CSV exported.', 'success');
          })();
        },
        { class: 'primary', 'data-action': 'export-csv' },
      ),
    ),
  );
}

// --- CSV import ----------------------------------------------------------

function csvImportCard(
  ctx: AppContext,
  noteTypes: NoteType[],
  decks: Deck[],
  refresh: () => void,
): HTMLElement {
  const host = el('div.card.col', {});
  let text = '';
  let fileName = '';

  const fileInput = input({
    type: 'file',
    accept: '.csv,.tsv,.txt,text/csv',
    style: { display: 'none' },
    'data-role': 'csv-file',
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    void file.text().then((content) => {
      text = content;
      fileName = file.name;
      drawCard();
    });
  });

  const drawCard = (): void => {
    if (!text) {
      render(
        host,
        el('h3', { text: 'Import notes from CSV' }),
        el('p.muted', {
          text: 'Comma, semicolon or tab separated. Columns are mapped to fields in the next step.',
        }),
        el('div.row', {}, button('Choose file…', () => fileInput.click(), { 'data-action': 'choose-csv' })),
        fileInput,
      );
      return;
    }

    const preview = previewCsv(text);
    const rows = preview.rows;
    if (rows.length === 0) {
      render(host, el('h3', { text: 'Import notes from CSV' }), el('div.empty', { text: 'That file has no rows.' }), fileInput);
      return;
    }

    let noteType = noteTypes[0]!;
    let deckId = decks[0]?.id ?? '';
    let hasHeader = true;
    let skipDuplicates = true;
    let tagsColumn = -1;
    const fieldColumns: Record<string, number> = {};

    const columnCount = Math.max(...rows.map((row) => row.length));
    const headerRow = rows[0] ?? [];

    const columnLabel = (index: number): string =>
      hasHeader && headerRow[index] ? `${index + 1}: ${headerRow[index]}` : `Column ${index + 1}`;

    const columnOptions = () => [
      { value: '-1', label: '(leave blank)' },
      ...Array.from({ length: columnCount }, (_, i) => ({ value: String(i), label: columnLabel(i) })),
    ];

    const guessColumns = (): void => {
      for (const [index, f] of noteType.fields.entries()) {
        const byName = hasHeader
          ? headerRow.findIndex((h) => h.trim().toLowerCase() === f.name.toLowerCase())
          : -1;
        fieldColumns[f.name] = byName >= 0 ? byName : index < columnCount ? index : -1;
      }
      const tagIndex = hasHeader
        ? headerRow.findIndex((h) => /^(tags|labels)$/i.test(h.trim()))
        : -1;
      tagsColumn = tagIndex;
    };
    guessColumns();

    const render1 = (): void => {
      const dataRows = hasHeader ? rows.slice(1) : rows;

      render(
        host,
        el(
          'div.row',
          {},
          el('h3', { text: 'Import notes from CSV', style: { margin: '0' } }),
          el('div.spacer', {}),
          el('span.muted', { text: `${fileName} — ${dataRows.length} rows` }),
          button('Choose another…', () => fileInput.click(), { class: 'ghost' }),
        ),
        el(
          'div.row',
          {},
          field(
            'Note type',
            (() => {
              const s = select(noteTypes.map((nt) => ({ value: nt.id, label: nt.name })), {
                onChange: (ev: Event) => {
                  noteType = noteTypes.find((nt) => nt.id === (ev.target as HTMLSelectElement).value)!;
                  guessColumns();
                  render1();
                },
              });
              s.value = noteType.id;
              return s;
            })(),
          ),
          field(
            'Deck',
            (() => {
              const s = select(decks.map((d) => ({ value: d.id, label: d.name })), {
                onChange: (ev: Event) => {
                  deckId = (ev.target as HTMLSelectElement).value;
                },
              });
              s.value = deckId;
              return s;
            })(),
          ),
          el(
            'label.field',
            {},
            el('span', { text: 'First row is a header' }),
            input({
              type: 'checkbox',
              checked: hasHeader,
              style: { width: 'auto' },
              onChange: (ev: Event) => {
                hasHeader = (ev.target as HTMLInputElement).checked;
                guessColumns();
                render1();
              },
            }),
          ),
          el(
            'label.field',
            {},
            el('span', { text: 'Skip duplicates' }),
            input({
              type: 'checkbox',
              checked: skipDuplicates,
              style: { width: 'auto' },
              onChange: (ev: Event) => {
                skipDuplicates = (ev.target as HTMLInputElement).checked;
              },
            }),
          ),
        ),
        el(
          'div.row',
          {},
          ...noteType.fields.map((f) =>
            field(
              f.name,
              (() => {
                const s = select(columnOptions(), {
                  onChange: (ev: Event) => {
                    fieldColumns[f.name] = Number((ev.target as HTMLSelectElement).value);
                  },
                });
                s.value = String(fieldColumns[f.name] ?? -1);
                return s;
              })(),
            ),
          ),
          field(
            'Tags',
            (() => {
              const s = select(columnOptions(), {
                onChange: (ev: Event) => {
                  tagsColumn = Number((ev.target as HTMLSelectElement).value);
                },
              });
              s.value = String(tagsColumn);
              return s;
            })(),
          ),
        ),
        el('div.preview-label', { text: 'First rows' }),
        el(
          'div',
          { style: { overflowX: 'auto' } },
          el(
            'table.browse',
            {},
            el('tbody', {}, dataRows.slice(0, 5).map((row) =>
              el('tr', {}, Array.from({ length: columnCount }, (_, i) =>
                el('td.q', { text: row[i] ?? '' }),
              )),
            )),
          ),
        ),
        el(
          'div.row',
          {},
          button(
            'Import',
            () => {
              void (async () => {
                try {
                  const result = await importCsv(ctx.db, text, {
                    noteTypeId: noteType.id,
                    deckId,
                    fieldColumns,
                    tagsColumn,
                    hasHeader,
                    skipDuplicates,
                    delimiter: preview.delimiter,
                  });
                  const parts = [`${result.notesAdded} notes, ${result.cardsAdded} cards`];
                  if (result.duplicatesSkipped) parts.push(`${result.duplicatesSkipped} duplicates skipped`);
                  if (result.errors.length) parts.push(`${result.errors.length} rows failed`);
                  toast(`Imported ${parts.join(' · ')}.`, result.errors.length ? 'info' : 'success');
                  text = '';
                  refresh();
                } catch (error) {
                  toast(error instanceof Error ? error.message : String(error), 'error');
                }
              })();
            },
            { class: 'primary', 'data-action': 'run-csv-import' },
          ),
          button('Cancel', () => {
            text = '';
            drawCard();
          }, { class: 'ghost' }),
        ),
        fileInput,
      );
    };

    render1();
  };

  drawCard();
  return host;
}

// --- helpers -------------------------------------------------------------

function download(filename: string, contents: string, mime: string): void {
  const blob = new Blob([contents], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename }) as HTMLAnchorElement;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
