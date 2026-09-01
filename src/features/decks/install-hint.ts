/**
 * A one-time nudge to install the app, shown only where it actually
 * matters and only where the platform gives no prompt of its own.
 *
 * On iOS this is not a growth nudge, it is data safety: Safari clears
 * script-writable storage for sites the user has not returned to in a
 * while, and web apps launched from the Home Screen are exempt. Someone
 * studying in a Safari tab can lose months of history without ever being
 * told, and there is no API that will warn them — so the app has to.
 */

import { button, el } from '../../ui/dom.js';
import { currentPlatform, installInstructions, storageOutlook, StorageOutlook } from '../../ui/platform.js';

const DISMISS_KEY = 'flashy.install-hint.dismissed';

function dismissed(): boolean {
  try {
    return globalThis.localStorage?.getItem(DISMISS_KEY) === '1';
  } catch {
    // Private browsing can make localStorage throw; showing the hint again
    // is a far smaller problem than the data loss it warns about.
    return false;
  }
}

function remember(): void {
  try {
    globalThis.localStorage?.setItem(DISMISS_KEY, '1');
  } catch {
    // Nothing to do; it will be shown again next time.
  }
}

/**
 * The banner, or null when there is nothing useful to say — already
 * installed, not a platform with this problem, or previously dismissed.
 */
export function installHint(onDismiss: () => void): HTMLElement | null {
  const platform = currentPlatform();
  if (storageOutlook(platform) !== StorageOutlook.IosBrowser) return null;
  if (dismissed()) return null;

  const steps = installInstructions(platform);
  if (!steps) return null;

  return el(
    'div.install-hint',
    { 'data-hint': 'install' },
    el('h3', { text: 'Add Flashy to your Home Screen' }),
    el('p.why', {
      text: 'Safari clears saved data for sites you have not opened in a while. Apps on the Home Screen are exempt, so installing Flashy is what keeps your review history safe.',
    }),
    el('ol', {}, steps.map((step) => el('li', { text: step }))),
    el(
      'div.row',
      {},
      button(
        'Got it',
        () => {
          remember();
          onDismiss();
        },
        { class: 'primary', 'data-action': 'dismiss-install-hint' },
      ),
    ),
  );
}
