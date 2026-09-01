/**
 * Modal dialogs. Every one resolves a promise, so callers read as
 * straight-line code: `if (await confirm(...)) { ... }`.
 */

import { append, button, el, type Child } from './dom.js';

export interface ModalAction<T> {
  label: string;
  value: T;
  primary?: boolean;
  danger?: boolean;
  /** Return false to keep the modal open (e.g. validation failed). */
  validate?: () => boolean;
}

export interface ModalOptions<T> {
  title: string;
  body: Child;
  actions: Array<ModalAction<T>>;
  /** Value resolved when dismissed with Escape or a backdrop click. */
  dismissValue: T;
  wide?: boolean;
  /** Focus this element once the modal is on screen. */
  focus?: HTMLElement;
}

export function modal<T>(options: ModalOptions<T>): Promise<T> {
  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const close = (value: T): void => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      previouslyFocused?.focus?.();
      resolve(value);
    };

    const footer = el('footer', {});
    for (const action of options.actions) {
      footer.appendChild(
        button(
          action.label,
          () => {
            if (action.validate && !action.validate()) return;
            close(action.value);
          },
          { class: action.primary ? 'primary' : action.danger ? 'danger' : '' },
        ),
      );
    }

    const body = el('div.body', {});
    append(body, options.body);

    const box = el(
      options.wide ? 'div.modal.wide' : 'div.modal',
      { role: 'dialog', 'aria-modal': 'true', 'aria-label': options.title },
      el('header', { text: options.title }),
      body,
      footer,
    );

    const backdrop = el('div.backdrop', {}, box);
    backdrop.addEventListener('mousedown', (ev) => {
      if (ev.target === backdrop) close(options.dismissValue);
    });

    // Escape closes; Tab is trapped inside the dialog.
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        close(options.dismissValue);
        return;
      }
      if (ev.key !== 'Tab') return;
      const focusable = box.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(backdrop);
    (options.focus ?? box.querySelector<HTMLElement>('input, textarea, button.primary, button'))?.focus();
  });
}

/** Yes/no. Resolves true only on the confirming action. */
export function confirmModal(
  title: string,
  body: Child,
  confirmLabel = 'OK',
  danger = false,
): Promise<boolean> {
  return modal<boolean>({
    title,
    body,
    dismissValue: false,
    actions: [
      { label: 'Cancel', value: false },
      { label: confirmLabel, value: true, primary: !danger, danger },
    ],
  });
}

/** A single-line text prompt. Resolves null when cancelled or left empty. */
export function promptModal(
  title: string,
  label: string,
  initial = '',
  confirmLabel = 'Save',
): Promise<string | null> {
  const input = el('input', { value: initial, 'aria-label': label }) as HTMLInputElement;
  const field = el('label.field', {}, el('span', { text: label }), input);

  // Enter submits, which is what everyone expects from a one-field dialog.
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      (input.closest('.modal')?.querySelector('footer button.primary') as HTMLElement | null)?.click();
    }
  });

  return modal<string | null>({
    title,
    body: field,
    dismissValue: null,
    focus: input,
    actions: [
      { label: 'Cancel', value: null },
      {
        label: confirmLabel,
        value: '__value__',
        primary: true,
        validate: () => input.value.trim().length > 0,
      },
    ],
  }).then((result) => (result === '__value__' ? input.value.trim() : null));
}
