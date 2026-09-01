/**
 * Platform detection, kept in one place and kept honest.
 *
 * User-agent sniffing is normally a bad habit, but two things genuinely
 * cannot be feature-detected and change what the app should tell the user:
 *
 *  - iOS has no install prompt API, so an install can only be *explained*,
 *    and the instructions are specific to Safari's share sheet.
 *  - Safari caps script-writable storage for ordinary browsing, and exempts
 *    web apps launched from the Home Screen. On an iPhone that is the
 *    difference between a collection that survives and one that does not,
 *    and no API reports it.
 *
 * Everything here takes its inputs as arguments so it can be tested without
 * a browser.
 */

export interface PlatformInputs {
  userAgent: string;
  /** `navigator.maxTouchPoints`, used to spot an iPad pretending to be a Mac. */
  maxTouchPoints?: number;
  /** `navigator.standalone`, which only iOS sets. */
  navigatorStandalone?: boolean;
  /** Whether `(display-mode: standalone)` matches. */
  displayModeStandalone?: boolean;
}

/** iPhone, iPad or iPod — including an iPad claiming to be a Mac. */
export function isIos(input: PlatformInputs): boolean {
  const ua = input.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  // iPadOS 13+ reports a desktop Macintosh UA; touch points give it away.
  return /Macintosh/i.test(ua) && (input.maxTouchPoints ?? 0) > 1;
}

/**
 * Safari proper, rather than a browser using WebKit under Apple's rules.
 *
 * On iOS every browser is WebKit, but only Safari has the share sheet with
 * "Add to Home Screen", so the instructions differ.
 */
export function isIosSafari(input: PlatformInputs): boolean {
  if (!isIos(input)) return false;
  const ua = input.userAgent;
  // Chrome (CriOS), Firefox (FxiOS), Edge (EdgiOS), Opera (OPiOS).
  return !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//i.test(ua);
}

/** Running as an installed app rather than in a browser tab. */
export function isStandalone(input: PlatformInputs): boolean {
  return Boolean(input.navigatorStandalone) || Boolean(input.displayModeStandalone);
}

/** Read the current environment. */
export function currentPlatform(): PlatformInputs {
  const nav = globalThis.navigator as
    | (Navigator & { standalone?: boolean })
    | undefined;
  let displayModeStandalone = false;
  try {
    displayModeStandalone =
      globalThis.matchMedia?.('(display-mode: standalone)').matches ?? false;
  } catch {
    displayModeStandalone = false;
  }
  return {
    userAgent: nav?.userAgent ?? '',
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    navigatorStandalone: nav?.standalone ?? false,
    displayModeStandalone,
  };
}

export const StorageOutlook = {
  /** Installed to the Home Screen: Safari's storage cap does not apply. */
  IosInstalled: 'ios-installed',
  /** An iOS browser tab: storage may be cleared after a period of disuse. */
  IosBrowser: 'ios-browser',
  /** Elsewhere, where navigator.storage.persist() is the deciding factor. */
  Other: 'other',
} as const;
export type StorageOutlook = (typeof StorageOutlook)[keyof typeof StorageOutlook];

/**
 * How safe the collection is, in terms that match the platform.
 *
 * On iOS the durable-storage API is not the thing that decides it, so
 * reporting `persisted` there would be misleading either way.
 */
export function storageOutlook(input: PlatformInputs): StorageOutlook {
  if (!isIos(input)) return StorageOutlook.Other;
  return isStandalone(input) ? StorageOutlook.IosInstalled : StorageOutlook.IosBrowser;
}

/** Step-by-step install instructions, or null where the app cannot say. */
export function installInstructions(input: PlatformInputs): string[] | null {
  if (!isIos(input) || isStandalone(input)) return null;
  if (!isIosSafari(input)) {
    return ['Open this page in Safari — only Safari can add a web app to the Home Screen on iOS.'];
  }
  return [
    'Tap the Share button at the bottom of Safari.',
    'Scroll down and tap "Add to Home Screen".',
    'Tap Add, then open Flashy from the new icon.',
  ];
}
