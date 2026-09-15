/**
 * Getting a file out of the app — which on an iPhone is not a download.
 *
 * `<a download>` is the desktop answer and it is the wrong one here. Safari
 * on iOS only grew a download manager in iOS 13, and a web app launched
 * from the Home Screen — which is exactly how this one has to be run, since
 * that is what exempts it from Safari's storage eviction — routinely does
 * nothing at all when such a link is clicked. There is no error; the file
 * simply never appears.
 *
 * The share sheet is the path that works: `navigator.share({ files })` puts
 * Save to Files, AirDrop and Mail in front of the user, and AirDrop is the
 * short road from a phone to the computer running Anki.
 *
 * Two rules come out of that and both are load-bearing:
 *
 *  - The file must already exist when the button is pressed. Safari grants
 *    a click a brief window of "transient activation" and `share()` outside
 *    it throws NotAllowedError, so anything that has to read IndexedDB
 *    first must have done so on an earlier press.
 *  - Dismissing the share sheet is not a failure. It rejects with
 *    AbortError, and reporting that as an error — or quietly falling back
 *    to a download the user did not ask for — is worse than silence.
 */

export type DeliveryMethod = 'share' | 'download';

export interface Delivery {
  method: DeliveryMethod;
  /** False only when the user dismissed the share sheet themselves. */
  completed: boolean;
}

/** The slice of `navigator` this needs, so the decision can be tested. */
export interface ShareCapableNavigator {
  share?: (data: { files?: File[]; title?: string; text?: string }) => Promise<void>;
  canShare?: (data: { files?: File[] }) => boolean;
}

/**
 * Whether the share sheet can take this file.
 *
 * Both halves matter: `canShare` without `share` exists in browsers that
 * implement only Level 1 of the spec, and `share` without file support
 * throws when handed files. Asking `canShare` about the actual file is the
 * only reliable check, because some platforms refuse particular types.
 */
export function canShareFile(file: File, nav: ShareCapableNavigator | undefined): boolean {
  if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false;
  try {
    return nav.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/** True when a rejection means "the user closed the sheet", not "it broke". */
export function isShareDismissal(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Build the file once, ahead of the click that shares it. */
export function textFile(filename: string, contents: string, mime: string): File {
  return new File([contents], filename, { type: `${mime};charset=utf-8` });
}

/**
 * The desktop path: a blob URL behind a link that clicks itself.
 */
export function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Hand the file to the user by whichever route this device has.
 *
 * Must be called directly from a click handler, with `file` already built.
 */
export async function deliverFile(
  file: File,
  options: {
    title?: string;
    navigator?: ShareCapableNavigator;
    /** The fallback, injectable so the choice can be tested without a DOM. */
    download?: (file: File) => void;
  } = {},
): Promise<Delivery> {
  const nav = options.navigator ?? (globalThis.navigator as ShareCapableNavigator | undefined);

  if (canShareFile(file, nav)) {
    try {
      await nav!.share!({ files: [file], ...(options.title ? { title: options.title } : {}) });
      return { method: 'share', completed: true };
    } catch (error) {
      if (isShareDismissal(error)) return { method: 'share', completed: false };
      // Anything else — a platform that advertised sharing and then refused
      // — is worth falling back from rather than reporting.
    }
  }

  (options.download ?? downloadFile)(file);
  return { method: 'download', completed: true };
}
