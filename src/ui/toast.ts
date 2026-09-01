/** Transient status messages. One container, appended to <body> on demand. */

import { el } from './dom.js';

export type ToastKind = 'info' | 'success' | 'error';

let container: HTMLElement | null = null;

function host(): HTMLElement {
  if (!container || !container.isConnected) {
    container = el('div.toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(container);
  }
  return container;
}

export function toast(message: string, kind: ToastKind = 'info', ms = 3200): void {
  const node = el(`div.toast.${kind}`, { text: message });
  host().appendChild(node);
  window.setTimeout(() => node.remove(), ms);
}
