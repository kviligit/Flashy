/**
 * Media references inside note fields.
 *
 * A field stores markup that points at a stored file by id, never at a
 * blob URL — those are per-page-load and would rot the moment the note was
 * saved. Resolving a reference to something a browser can display happens
 * at render time, in the UI layer, so this module stays pure.
 *
 * The scheme is deliberately not a real URL. `flashy-media:abc123` cannot
 * accidentally hit the network if a resolver is missing; it just renders as
 * a broken image, which is a visible failure rather than a silent one.
 */

export const MEDIA_SCHEME = 'flashy-media:';

/** Files we are willing to store and can actually display. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];
export const AUDIO_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/mp4', 'audio/aac'];

export type MediaKind = 'image' | 'audio';

export function mediaKind(mime: string): MediaKind | null {
  const type = mime.toLowerCase().split(';')[0]?.trim() ?? '';
  if (IMAGE_TYPES.includes(type)) return 'image';
  if (AUDIO_TYPES.includes(type)) return 'audio';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  return null;
}

/** `flashy-media:<id>` */
export function mediaUrl(id: string): string {
  return `${MEDIA_SCHEME}${id}`;
}

/** The id inside a reference, or null if it is not one. */
export function mediaIdFrom(url: string): string | null {
  if (!url.startsWith(MEDIA_SCHEME)) return null;
  const id = url.slice(MEDIA_SCHEME.length).trim();
  return id.length > 0 ? id : null;
}

/**
 * The markup inserted into a field.
 *
 * Audio carries `controls` so a card is playable without any scripting,
 * and `preload="none"` so a deck full of audio does not fetch everything
 * the moment a card appears.
 */
export function mediaTag(id: string, kind: MediaKind, alt = ''): string {
  const src = mediaUrl(id);
  if (kind === 'audio') return `<audio src="${src}" controls preload="none"></audio>`;
  return `<img src="${src}" alt="${escapeAttribute(alt)}">`;
}

/** Every media id referenced by a piece of markup, in order, deduplicated. */
export function mediaRefsIn(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/(?:src|href)\s*=\s*["']?(flashy-media:[^"'\s>]+)/gi)) {
    const id = mediaIdFrom(match[1] ?? '');
    if (id) found.add(id);
  }
  return [...found];
}

/** Every media id referenced anywhere in a note's fields. */
export function mediaRefsInFields(fields: Record<string, string>): string[] {
  const found = new Set<string>();
  for (const value of Object.values(fields)) {
    for (const id of mediaRefsIn(value)) found.add(id);
  }
  return [...found];
}

/** Remove every reference to a given media id from a field's markup. */
export function stripMediaRef(html: string, id: string): string {
  const url = mediaUrl(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html
    .replace(new RegExp(`<img[^>]*src\\s*=\\s*["']?${url}["']?[^>]*>`, 'gi'), '')
    .replace(new RegExp(`<audio[^>]*src\\s*=\\s*["']?${url}["']?[^>]*>\\s*</audio>`, 'gi'), '');
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** The attribute a deferred reference is parked in until it is resolved. */
export const MEDIA_DEFER_ATTRIBUTE = 'data-media-src';

/**
 * Move media references out of `src` so the browser does not try to fetch
 * them.
 *
 * A stored field keeps the canonical `src="flashy-media:id"` form, which is
 * self-describing and portable. But the moment that markup enters the DOM
 * the browser attempts to load the custom scheme, fails, and shows a broken
 * element until the resolver catches up. Parking the reference in a data
 * attribute means nothing is ever requested that cannot be served.
 */
export function deferMediaSrc(html: string): string {
  return html.replace(
    /\ssrc\s*=\s*(["'])(flashy-media:[^"']+)\1/gi,
    (_match, _quote: string, url: string) => {
      const id = mediaIdFrom(url);
      return id ? ` ${MEDIA_DEFER_ATTRIBUTE}="${id}"` : '';
    },
  );
}

/** A human-readable size, for the editor and the media manager. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * A content hash, so the same file added twice is stored once.
 *
 * Deduplication matters more than it looks: the obvious way to build a
 * deck is to paste the same diagram onto twenty cards, and storing twenty
 * copies would fill a phone's quota for no reason.
 */
export async function hashContent(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex.slice(0, 32);
}

/** Base64, for embedding media in a JSON backup. */
export function toBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let binary = '';
  // Chunked so a large file cannot blow the argument limit of fromCharCode.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(encoded: string): ArrayBuffer {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
