/** Id generation. Isolated so tests can make ids deterministic. */

let counter = 0;

/** A unique id. Uses `crypto.randomUUID` where available. */
export function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  counter += 1;
  return `id-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}
