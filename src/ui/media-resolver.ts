/**
 * Turning `flashy-media:` references into something the browser will show.
 *
 * Object URLs are the only way to display a stored blob, and each one holds
 * its data in memory until it is explicitly revoked. A long study session
 * would otherwise accumulate one per image per card. So a resolver owns
 * every URL it creates, hands out the same URL for a repeated file, and
 * releases the lot on `dispose()`.
 *
 * Ownership is per screen: the reviewer keeps one for a whole session, the
 * editor one per mount.
 */

import { MEDIA_DEFER_ATTRIBUTE, mediaIdFrom, mediaKind } from '../domain/media.js';
import type { Db } from '../storage/index.js';

export class MediaResolver {
  private urls = new Map<string, string>();
  private disposed = false;

  constructor(private readonly db: Db) {}

  /**
   * Replace every media reference inside `container` with a usable URL.
   *
   * Elements whose file is missing are marked rather than left pointing at
   * a dead reference, so a lost file is visible instead of mysterious.
   */
  async resolve(container: ParentNode): Promise<void> {
    // Both forms are handled: the deferred attribute, which is what
    // `deferMediaSrc` produces and what callers should use, and a raw
    // `src` for anything that slipped through. The second case still
    // works, it just costs one failed request first.
    const nodes = [
      ...container.querySelectorAll<HTMLElement>(`[${MEDIA_DEFER_ATTRIBUTE}]`),
      ...container.querySelectorAll<HTMLElement>('[src^="flashy-media:"]'),
    ];
    await Promise.all(nodes.map((node) => this.resolveOne(node)));
  }

  private async resolveOne(node: HTMLElement): Promise<void> {
    const deferred = node.getAttribute(MEDIA_DEFER_ATTRIBUTE);
    const id = deferred ?? mediaIdFrom(node.getAttribute('src') ?? '');
    if (!id) return;

    node.removeAttribute(MEDIA_DEFER_ATTRIBUTE);

    const url = await this.urlFor(id);
    if (!url) {
      node.removeAttribute('src');
      node.setAttribute('data-media-missing', id);
      node.setAttribute('alt', 'Missing file');
      node.setAttribute('title', 'This file is no longer in the collection.');
      return;
    }
    node.setAttribute('src', url);
  }

  /** A displayable URL for a stored file, created once and reused. */
  async urlFor(id: string): Promise<string | null> {
    if (this.disposed) return null;
    const existing = this.urls.get(id);
    if (existing) return existing;

    const file = await this.db.media.get(id);
    if (!file) return null;

    // A second caller may have resolved the same id while we were reading.
    const raced = this.urls.get(id);
    if (raced) return raced;

    // Clamp the type at the point the URL is made, not only where the file
    // was stored. This is the sink: whatever a record claims, an object URL
    // here is only ever an image or a sound, so nothing downstream can be
    // talked into treating one as a document.
    const type = mediaKind(file.mime) ? file.mime : 'application/octet-stream';
    const url = URL.createObjectURL(new Blob([file.data], { type }));
    if (this.disposed) {
      URL.revokeObjectURL(url);
      return null;
    }
    this.urls.set(id, url);
    return url;
  }

  /** Release every URL this resolver created. */
  dispose(): void {
    this.disposed = true;
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }

  /** How many URLs are currently held, for tests. */
  get size(): number {
    return this.urls.size;
  }
}

/**
 * Resolve media inside a container that is already on the page, tying the
 * resolver's lifetime to that container.
 *
 * Convenient where a screen renders once and is later replaced wholesale by
 * the router, which is most of them.
 */
export function resolveMediaIn(container: HTMLElement, db: Db): MediaResolver {
  const resolver = new MediaResolver(db);
  void resolver.resolve(container);
  return resolver;
}
