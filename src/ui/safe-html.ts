/**
 * The single place untrusted HTML is allowed into the page.
 *
 * Card content is authored by whoever made the deck, and decks are shared.
 * A restored backup carries note fields and card templates verbatim, so
 * "somebody else's HTML" is the normal case, not an edge case.
 *
 * This replaces an earlier regex-based sanitiser, which was bypassable and
 * — more importantly — was never going to be fixable. Regexes do not parse
 * HTML the way a browser does: the old one stripped `onerror` only when a
 * space preceded it, and browsers also accept `/` and a closing quote as
 * attribute separators, so `<img src="x"/onerror=...>` sailed through and
 * fired. There is no version of that approach worth trusting.
 *
 * The approach here instead:
 *
 *   1. Parse into an inert `<template>`, which builds a real DOM without
 *      running scripts, loading resources or executing handlers.
 *   2. Walk it and keep only elements on an allow-list; unwrap the rest so
 *      their text survives.
 *   3. Keep only attributes on an allow-list, and re-check every URL after
 *      the parser has decoded entities — which is what makes
 *      `&#106;avascript:` no different from `javascript:`.
 *
 * An allow-list is used rather than a block-list because the failure modes
 * point opposite ways: something forgotten from an allow-list renders
 * plainly, while something forgotten from a block-list executes.
 */

/** Elements permitted in card content. */
const ALLOWED_ELEMENTS = new Set([
  'a', 'abbr', 'audio', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption',
  'cite', 'code', 'col', 'colgroup', 'dd', 'details', 'dfn', 'div', 'dl',
  'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'img', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 'rp', 'rt',
  'ruby', 's', 'samp', 'small', 'source', 'span', 'strong', 'sub', 'summary',
  'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u',
  'ul', 'var', 'video', 'wbr',
]);

/**
 * Elements removed outright rather than unwrapped.
 *
 * For everything else, dropping the tag but keeping the text is the kinder
 * failure. For these the content is not text a reader wants.
 */
const DROPPED_ELEMENTS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
  'form', 'input', 'button', 'select', 'textarea', 'noscript', 'template',
  'svg', 'math', 'frame', 'frameset', 'applet', 'title', 'head',
]);

/** Attributes permitted on any allowed element. */
const GLOBAL_ATTRIBUTES = new Set(['class', 'dir', 'lang', 'title']);

/** Additional attributes permitted on specific elements. */
const ELEMENT_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(['href', 'target', 'rel']),
  img: new Set(['src', 'alt', 'width', 'height', 'loading', 'data-media-src']),
  audio: new Set(['src', 'controls', 'preload', 'loop', 'data-media-src']),
  video: new Set(['src', 'controls', 'preload', 'loop', 'poster', 'width', 'height', 'data-media-src']),
  source: new Set(['src', 'type', 'data-media-src']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
  ol: new Set(['start', 'reversed', 'type']),
  time: new Set(['datetime']),
  details: new Set(['open']),
};

/** Attributes whose value is a URL and must have its scheme checked. */
const URL_ATTRIBUTES = new Set(['href', 'src', 'poster']);

/**
 * URL schemes allowed in card content.
 *
 * `blob:` is absent deliberately: the media resolver assigns those itself,
 * after sanitising, so there is no reason for authored HTML to contain one.
 * `data:` is absent because a data URL can carry an SVG, and an SVG can
 * carry script.
 */
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** True when a URL is safe to keep. Relative URLs are fine. */
export function isSafeUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return false;
  // A scheme-relative URL (//host/path) inherits the page's scheme.
  if (trimmed.startsWith('//')) return true;
  try {
    // Resolving against a base makes relative URLs parse; an absolute URL
    // keeps its own scheme regardless of the base.
    const url = new URL(trimmed, 'https://flashy.invalid/');
    return ALLOWED_SCHEMES.has(url.protocol);
  } catch {
    return false;
  }
}

/**
 * Parse `html` and return a fragment containing only what is allowed.
 *
 * Uses `<template>`, whose content is an inert document fragment: nothing
 * in it loads, runs or fires while it is being inspected.
 */
export function sanitiseToFragment(html: string, doc: Document = document): DocumentFragment {
  const template = doc.createElement('template');
  template.innerHTML = html;
  const fragment = template.content;

  // Collect first: the walker must not be mutated while it is walking.
  const elements: Element[] = [];
  const walker = doc.createTreeWalker(fragment, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    elements.push(node as Element);
  }

  // Deepest first, so unwrapping a parent cannot strand children that have
  // not been examined yet.
  for (const element of elements.reverse()) {
    const name = element.tagName.toLowerCase();

    if (DROPPED_ELEMENTS.has(name)) {
      element.remove();
      continue;
    }

    if (!ALLOWED_ELEMENTS.has(name)) {
      unwrap(element);
      continue;
    }

    cleanAttributes(element, name);
  }

  return fragment;
}

function cleanAttributes(element: Element, name: string): void {
  const permitted = ELEMENT_ATTRIBUTES[name];

  for (const attribute of Array.from(element.attributes)) {
    const attributeName = attribute.name.toLowerCase();

    // Every event handler, however it was spelled or separated. The parser
    // has already normalised the name by this point, which is exactly what
    // the old regex could not do.
    if (attributeName.startsWith('on')) {
      element.removeAttribute(attribute.name);
      continue;
    }

    const allowed = GLOBAL_ATTRIBUTES.has(attributeName) || permitted?.has(attributeName) === true;
    if (!allowed) {
      element.removeAttribute(attribute.name);
      continue;
    }

    // The parser has decoded entities, so an obfuscated scheme is now
    // plainly visible.
    if (URL_ATTRIBUTES.has(attributeName) && !isSafeUrl(attribute.value)) {
      element.removeAttribute(attribute.name);
    }
  }

  // A link that leaves the app should not hand the destination a referrer
  // or a handle on the opener.
  if (name === 'a' && element.hasAttribute('href')) {
    element.setAttribute('rel', 'noopener noreferrer nofollow');
    element.setAttribute('target', '_blank');
  }
}

/** Replace an element with its children, keeping the text. */
function unwrap(element: Element): void {
  const parent = element.parentNode;
  if (!parent) {
    element.remove();
    return;
  }
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  parent.removeChild(element);
}

/**
 * Replace `element`'s contents with sanitised `html`.
 *
 * The only supported way to put card content on the page. `el({ html })`
 * assigns innerHTML directly and is for markup this codebase wrote itself.
 */
export function setSafeHtml(element: Element, html: string): void {
  element.replaceChildren(sanitiseToFragment(html, element.ownerDocument ?? document));
}

/** Sanitised HTML as a string, for previews and tests. */
export function sanitiseToString(html: string, doc: Document = document): string {
  const holder = doc.createElement('div');
  holder.appendChild(sanitiseToFragment(html, doc));
  return holder.innerHTML;
}
