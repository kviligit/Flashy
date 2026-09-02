/**
 * Storing and reclaiming media files.
 *
 * The rule that shapes this module: a note's fields are the only record of
 * which files are in use. There is no reference count to keep in step —
 * counts drift, and a drifted count either leaks files forever or deletes
 * one that is still on a card. Instead, usage is derived from the notes
 * whenever it is needed, and unused files are reclaimed on demand.
 */

import { hashContent, mediaKind, mediaRefsInFields, mediaTag, type MediaKind } from '../domain/media.js';
import type { MediaFile } from '../domain/types.js';
import type { Db } from '../storage/index.js';

/**
 * Refuse anything larger than this.
 *
 * Browser storage is finite and, on a phone, modest. A single 50MB video
 * dropped into a field would be a poor trade against the rest of the
 * collection, and the failure would show up later as a quota error during
 * an unrelated save.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface AddMediaInput {
  filename: string;
  mime: string;
  data: ArrayBuffer;
  now?: number;
}

export interface AddMediaResult {
  file: MediaFile;
  /** True when an identical file was already stored and was reused. */
  deduplicated: boolean;
  /** Markup to insert into a field. */
  tag: string;
  kind: MediaKind;
}

/** Store a file, or reuse the identical one already stored. */
export async function addMedia(db: Db, input: AddMediaInput): Promise<AddMediaResult> {
  const kind = mediaKind(input.mime);
  if (!kind) {
    throw new Error(`"${input.filename}" is not an image or a sound file.`);
  }
  if (input.data.byteLength === 0) {
    throw new Error(`"${input.filename}" is empty.`);
  }
  if (input.data.byteLength > MAX_FILE_BYTES) {
    throw new Error(
      `"${input.filename}" is too large. The limit is ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.`,
    );
  }

  const now = input.now ?? Date.now();
  const id = await hashContent(input.data);

  const existing = await db.media.get(id);
  if (existing) {
    return {
      file: existing,
      deduplicated: true,
      tag: mediaTag(id, kind, altFor(existing.filename)),
      kind,
    };
  }

  const file: MediaFile = {
    id,
    filename: input.filename,
    mime: input.mime,
    size: input.data.byteLength,
    data: input.data,
    created: now,
    modified: now,
  };
  await db.media.put(file);

  return { file, deduplicated: false, tag: mediaTag(id, kind, altFor(input.filename)), kind };
}

/** Read a file back. */
export async function getMedia(db: Db, id: string): Promise<MediaFile | null> {
  return db.media.get(id);
}

/** Every media id currently referenced by any note. */
export async function referencedMediaIds(db: Db): Promise<Set<string>> {
  const referenced = new Set<string>();
  for (const note of await db.notes.getAll()) {
    for (const id of mediaRefsInFields(note.fields)) referenced.add(id);
  }
  return referenced;
}

export interface MediaUsage {
  file: MediaFile;
  /** How many notes mention it. */
  noteCount: number;
}

/** Every stored file with a count of the notes using it, largest first. */
export async function mediaUsage(db: Db): Promise<MediaUsage[]> {
  const counts = new Map<string, number>();
  for (const note of await db.notes.getAll()) {
    for (const id of mediaRefsInFields(note.fields)) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }

  const files = await db.media.getAll();
  files.sort((a, b) => b.size - a.size);
  return files.map((file) => ({ file, noteCount: counts.get(file.id) ?? 0 }));
}

export interface CleanupResult {
  removed: number;
  bytesReclaimed: number;
  ids: string[];
}

/**
 * Delete files no note refers to any more.
 *
 * Deliberately manual rather than automatic on note deletion: two notes
 * can share an image, so "this note is gone" never implies "its files are
 * unused". Deriving usage from the notes at the moment of the sweep is the
 * only way to get that right without a reference count to keep in step.
 */
export async function cleanupUnusedMedia(db: Db): Promise<CleanupResult> {
  const referenced = await referencedMediaIds(db);
  const files = await db.media.getAll();
  const orphans = files.filter((file) => !referenced.has(file.id));

  await db.media.deleteMany(orphans.map((file) => file.id));

  return {
    removed: orphans.length,
    bytesReclaimed: orphans.reduce((sum, file) => sum + file.size, 0),
    ids: orphans.map((file) => file.id),
  };
}

/** Total bytes held in media. */
export async function mediaTotalBytes(db: Db): Promise<number> {
  return (await db.media.getAll()).reduce((sum, file) => sum + file.size, 0);
}

/** A readable alt attribute from a filename. */
function altFor(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
}
