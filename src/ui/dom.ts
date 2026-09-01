/**
 * Minimal DOM helpers. This is the entire "view framework" — deliberately
 * tiny so that no feature is coupled to a component library.
 *
 * Nothing here knows about flashcards. Keep it that way.
 */

export type Child = Node | string | number | null | undefined | false | Child[];

export interface Props {
  class?: string;
  text?: string;
  html?: string;
  /** Any other attribute; `null`/`false`/`undefined` removes it. */
  [key: string]: unknown;
}

/** Create an element. `el('div.card', { text: 'hi' })` — tag supports `.class` shorthand. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K | string,
  props: Props = {},
  ...children: Child[]
): HTMLElement {
  const [name = 'div', ...classes] = tag.split('.');
  const node = document.createElement(name);
  if (classes.length) node.classList.add(...classes);

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.classList.add(...String(value).split(/\s+/).filter(Boolean));
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }

  append(node, children);
  return node;
}

/** Append arbitrarily-nested children, skipping nullish/false entries. */
export function append(parent: Node, children: Child): void {
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) {
    for (const child of children) append(parent, child);
  } else if (children instanceof Node) {
    parent.appendChild(children);
  } else {
    parent.appendChild(document.createTextNode(String(children)));
  }
}

/** Replace a container's contents in one go. */
export function render(container: Element, ...children: Child[]): void {
  container.replaceChildren();
  append(container, children);
}

/** `<button>` with a click handler. */
export function button(
  label: Child,
  onClick: (ev: MouseEvent) => void,
  props: Props = {},
): HTMLButtonElement {
  const b = el('button', props) as HTMLButtonElement;
  b.addEventListener('click', onClick as EventListener);
  append(b, label);
  return b;
}

/** Labelled form field wrapping an input/textarea/select. */
export function field(label: string, control: HTMLElement): HTMLElement {
  return el('label.field', {}, el('span', { text: label }), control);
}

export function input(props: Props = {}): HTMLInputElement {
  return el('input', props) as HTMLInputElement;
}

export function textarea(props: Props = {}): HTMLTextAreaElement {
  return el('textarea', props) as HTMLTextAreaElement;
}

export function select(
  options: Array<{ value: string; label: string }>,
  props: Props = {},
): HTMLSelectElement {
  const s = el('select', props) as HTMLSelectElement;
  for (const o of options) s.appendChild(el('option', { value: o.value, text: o.label }));
  return s;
}

/** Escape text for safe interpolation into an HTML string. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
