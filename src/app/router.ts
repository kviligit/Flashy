/**
 * Hash router. Routes are plain strings like `#/decks` or `#/review/:deckId`.
 * A route handler returns the element to mount into <main>.
 */

export type RouteParams = Record<string, string>;
export type RouteHandler = (params: RouteParams, query: URLSearchParams) => Node | Promise<Node>;

interface Route {
  pattern: string;
  segments: string[];
  handler: RouteHandler;
}

export class Router {
  private routes: Route[] = [];
  private fallback: RouteHandler | null = null;
  private outlet: Element | null = null;
  private onNavigate: ((path: string) => void) | null = null;
  private token = 0;

  add(pattern: string, handler: RouteHandler): this {
    this.routes.push({ pattern, segments: split(pattern), handler });
    return this;
  }

  notFound(handler: RouteHandler): this {
    this.fallback = handler;
    return this;
  }

  /** Called after every successful navigation, with the matched path. */
  observe(fn: (path: string) => void): this {
    this.onNavigate = fn;
    return this;
  }

  start(outlet: Element): void {
    this.outlet = outlet;
    window.addEventListener('hashchange', () => void this.resolve());
    void this.resolve();
  }

  async resolve(): Promise<void> {
    if (!this.outlet) return;
    const raw = window.location.hash.replace(/^#/, '') || '/';
    const [path = '/', queryString = ''] = raw.split('?');
    const query = new URLSearchParams(queryString);
    const segments = split(path);

    // Bump the token so a slow handler that resolves after a newer
    // navigation cannot overwrite the newer view.
    const token = ++this.token;

    for (const route of this.routes) {
      const params = match(route.segments, segments);
      if (!params) continue;
      const node = await route.handler(params, query);
      if (token !== this.token) return;
      this.outlet.replaceChildren(node);
      this.onNavigate?.(path);
      return;
    }

    if (this.fallback) {
      const node = await this.fallback({}, query);
      if (token !== this.token) return;
      this.outlet.replaceChildren(node);
      this.onNavigate?.(path);
    }
  }
}

export function navigate(path: string): void {
  window.location.hash = path.startsWith('#') ? path : `#${path}`;
}

/** Re-run the current route (e.g. after a mutation). */
export function reload(router: Router): void {
  void router.resolve();
}

function split(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** Match route segments against path segments; `:name` captures. */
function match(pattern: string[], path: string[]): RouteParams | null {
  if (pattern.length !== path.length) return null;
  const params: RouteParams = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    const v = path[i]!;
    if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(v);
    else if (p !== v) return null;
  }
  return params;
}
