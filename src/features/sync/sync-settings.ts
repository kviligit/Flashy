/**
 * The sync screen.
 *
 * Three things, in the order someone actually needs them: an identity, some
 * relays, and a button. The screen's other job is to be honest — about
 * where the key is kept, about what a relay can see, and about the fact
 * that this is hand-written cryptography that no one has audited. None of
 * that is buried in a help page.
 */

import { button, el, field, input, render } from '../../ui/dom.js';
import { confirmModal, modal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import type { AppContext } from '../../app/context.js';
import { abbreviate, detectNip07, npubEncode, nsecEncode } from '../../nostr/index.js';
import {
  createLocalKey,
  defaultStore,
  forgetIdentity,
  importLocalKey,
  isRelayUrl,
  readAccount,
  readiness,
  revealSecretKey,
  setAuto,
  setRelays,
  SUGGESTED_RELAYS,
  useExtension,
  type SyncAccount,
} from '../../sync/index.js';
import { describeOutcome, runSync } from '../../sync/run.js';
import type { TransportProblem } from '../../sync/nostr-transport.js';

export function syncPage(ctx: AppContext): HTMLElement {
  const root = el('section', {});
  draw(root, ctx);
  return root;
}

function draw(root: HTMLElement, ctx: AppContext): void {
  const refresh = () => draw(root, ctx);
  const account = readAccount();
  const status = el('p.faint', { text: '', 'data-role': 'sync-status' });

  render(
    root,
    el('h1', { text: 'Sync' }),
    warningCard(),
    identityCard(account, refresh),
    account.mode === 'off' ? null : relayCard(account, refresh),
    account.mode === 'off' ? null : runCard(ctx, account, status, refresh),
  );
}

/**
 * The first thing on the page, because it is the thing a user cannot
 * discover for themselves.
 */
function warningCard(): HTMLElement {
  return el(
    'div.card.col',
    { 'data-card': 'sync-warning', style: { borderColor: 'var(--hard)' } },
    el('h3', { text: 'Read this first' }),
    el('p', {
      text:
        'Sync sends your collection to nostr relays — servers run by strangers. The contents are encrypted so only your key can read them, but the encryption here was written from scratch for this app, has been checked only against the specifications’ own test vectors, and has never been audited. Treat it as better than nothing, not as proven.',
    }),
    el('p', {
      text:
        'A relay still learns that your key syncs, from how many devices, how often, and roughly how much. That is inherent to using relays and nothing here hides it.',
    }),
    el('p.faint', {
      text:
        'Your collection stays on this device either way. Sync adds a copy elsewhere; it does not move anything.',
    }),
  );
}

function identityCard(account: SyncAccount, refresh: () => void): HTMLElement {
  const extension = detectNip07();
  const rows: HTMLElement[] = [];

  if (account.publicKey) {
    const npub = npubEncode(account.publicKey);
    rows.push(
      el(
        'div.row',
        {},
        el('code', {
          'data-role': 'npub',
          text: abbreviate(npub),
          title: npub,
          style: { fontSize: '0.9em' },
        }),
        el('div.spacer', {}),
        button('Copy', () => void copy(npub, 'Public key copied.'), {}),
      ),
    );
    rows.push(
      el('p.faint', {
        text:
          account.mode === 'extension'
            ? 'Your key is held by a browser extension. This page never sees it, which is the safest arrangement available in a browser.'
            : 'Your key is stored in this browser. Anything that can run code on this page can read it — including, if the app ever had a flaw, a card you imported from someone else. Back it up somewhere safe, and use it only for this.',
      }),
    );
  } else {
    rows.push(
      el('p', {
        text: 'A nostr key is the identity your devices share. All of them use the same one.',
      }),
    );
  }

  const actions: HTMLElement[] = [];
  if (account.mode === 'off') {
    actions.push(
      button('Create a key', () => {
        createLocalKey();
        toast('A new key was created and stored in this browser.', 'success');
        refresh();
      }, { class: 'primary', 'data-action': 'create-key' }),
      button('Use an existing key', () => void importKey(refresh), {}),
    );
    if (extension) {
      actions.push(
        button('Use my extension', () => void connectExtension(refresh), {}),
      );
    }
  } else {
    if (account.hasLocalKey) {
      actions.push(
        button('Show secret key', () => void showSecret(), { 'data-action': 'show-secret' }),
      );
    }
    if (extension && account.mode === 'local') {
      actions.push(button('Switch to my extension', () => void connectExtension(refresh), {}));
    }
    actions.push(
      button(
        'Forget this key',
        () => void forget(refresh),
        { class: 'danger' },
      ),
    );
  }

  return el(
    'div.card.col',
    { 'data-card': 'sync-identity' },
    el('h3', { text: 'Identity' }),
    ...rows,
    !extension && account.mode !== 'extension'
      ? el('p.faint', {
          text:
            'No nostr extension was found. On iPhone there are none, so a key stored in the browser is the only option.',
        })
      : null,
    el('div.row', {}, actions),
  );
}

async function importKey(refresh: () => void): Promise<void> {
  const box = input({ placeholder: 'nsec1…', 'aria-label': 'Secret key', autocapitalize: 'off', spellcheck: 'false' });
  const error = el('p.faint', { text: '', style: { color: 'var(--danger)' } });

  const confirmed = await modal<boolean>({
    title: 'Use an existing key',
    body: el(
      'div.col',
      {},
      el('p', { text: 'Paste the nsec from another device. It is stored in this browser.' }),
      field('Secret key', box),
      error,
    ),
    dismissValue: false,
    actions: [
      { label: 'Cancel', value: false },
      { label: 'Use this key', value: true, primary: true },
    ],
  });
  if (!confirmed) return;

  try {
    importLocalKey(box.value);
    toast('Key stored.', 'success');
    refresh();
  } catch (problem) {
    toast(problem instanceof Error ? problem.message : String(problem), 'error');
  }
}

async function connectExtension(refresh: () => void): Promise<void> {
  const provider = detectNip07();
  if (!provider) {
    toast('No nostr extension is available in this browser.', 'error');
    return;
  }
  try {
    useExtension(await provider.getPublicKey());
    toast('Using your extension. Any key stored here has been removed.', 'success');
    refresh();
  } catch (problem) {
    toast(problem instanceof Error ? problem.message : String(problem), 'error');
  }
}

async function showSecret(): Promise<void> {
  const hex = revealSecretKey();
  if (!hex) return;
  const nsec = nsecEncode(hex);

  await modal<boolean>({
    title: 'Your secret key',
    body: el(
      'div.col',
      {},
      el('p', {
        text: 'Anyone with this can read and change your collection on every device. Write it down somewhere private; do not paste it into anything else.',
      }),
      el('code', { text: nsec, style: { wordBreak: 'break-all', fontSize: '0.9em' } }),
    ),
    dismissValue: false,
    actions: [
      { label: 'Copy', value: true, primary: true },
      { label: 'Close', value: false },
    ],
  }).then((copyIt) => (copyIt ? copy(nsec, 'Secret key copied.') : undefined));
}

async function forget(refresh: () => void): Promise<void> {
  const ok = await confirmModal(
    'Forget this key?',
    el(
      'div.col',
      {},
      el('p', {
        text: 'This device stops syncing. Your cards stay here, untouched.',
      }),
      el('p', {
        text: 'If this is the only place the key is stored, anything already on the relays becomes unreadable. Show and save the key first if you might want it back.',
      }),
    ),
    'Forget it',
    true,
  );
  if (!ok) return;
  forgetIdentity();
  toast('Key forgotten. Sync is off.', 'success');
  refresh();
}

function relayCard(account: SyncAccount, refresh: () => void): HTMLElement {
  const rows = account.relays.map((url) =>
    el(
      'div.row',
      {},
      el('code', { text: url, style: { fontSize: '0.9em' } }),
      el('div.spacer', {}),
      button('Remove', () => {
        setRelays(account.relays.filter((other) => other !== url));
        refresh();
      }, {}),
    ),
  );

  const box = input({
    placeholder: 'wss://relay.example',
    'aria-label': 'Relay address',
    autocapitalize: 'off',
    spellcheck: 'false',
  });
  const add = () => {
    const url = box.value.trim();
    if (!isRelayUrl(url)) {
      toast('A relay address looks like wss://relay.example', 'error');
      return;
    }
    setRelays([...account.relays, url]);
    box.value = '';
    refresh();
  };
  box.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') {
      ev.preventDefault();
      add();
    }
  });

  const suggestions = SUGGESTED_RELAYS.filter((url) => !account.relays.includes(url));

  return el(
    'div.card.col',
    { 'data-card': 'sync-relays' },
    el('h3', { text: 'Relays' }),
    account.relays.length === 0
      ? el('p', { text: 'No relays yet. Your devices meet on whichever relays they share.' })
      : null,
    ...rows,
    el('div.row', {}, field('Add a relay', box), button('Add', add, {})),
    suggestions.length > 0
      ? el(
          'div.col',
          {},
          el('p.faint', {
            text: 'Public relays you could start with. Each one is a third party — pick deliberately, or run your own.',
          }),
          el(
            'div.row',
            {},
            suggestions.map((url) =>
              button(url.replace('wss://', ''), () => {
                setRelays([...account.relays, url]);
                refresh();
              }, {}),
            ),
          ),
        )
      : null,
  );
}

function runCard(
  ctx: AppContext,
  account: SyncAccount,
  status: HTMLElement,
  refresh: () => void,
): HTMLElement {
  const state = readiness(account);
  const detail = el('div.col', {});

  const go = button(
    'Sync now',
    () => {
      go.disabled = true;
      status.textContent = 'Syncing…';
      detail.replaceChildren();
      void (async () => {
        const outcome = await runSync(ctx.db);
        status.textContent = describeOutcome(outcome);
        render(detail, ...problemNotes(outcome.problems));
        if (outcome.ok) {
          // A round can change decks, cards and the day's queue, so the
          // scheduler's cached view of the collection is now stale.
          await ctx.scheduler.load();
        } else {
          toast(describeOutcome(outcome), 'error');
        }
        go.disabled = false;
      })();
    },
    { class: 'primary', 'data-action': 'sync-now' },
  );
  go.disabled = !state.ready;

  const auto = el('input', {
    type: 'checkbox',
    checked: account.auto,
    onChange: (ev: Event) => {
      setAuto((ev.target as HTMLInputElement).checked);
      refresh();
    },
  });

  return el(
    'div.card.col',
    { 'data-card': 'sync-run' },
    el('h3', { text: 'Sync' }),
    state.ready ? null : el('p.faint', { text: state.reason }),
    el('div.row', {}, go, el('div.spacer', {})),
    status,
    detail,
    el('label.row', {}, auto, el('span', { text: 'Sync automatically after studying' })),
    el('p.faint', {
      text: 'Every device that uses this key and shares a relay will end up with the same cards and the same review history. Where two devices edited the same card, the later edit wins; answers are never lost, because they are only ever added.',
    }),
  );
}

/**
 * Problems worth surfacing after a round.
 *
 * A record that did not fit is the one that matters: it means a card looks
 * different on the other device, and nothing else in the app would ever
 * say so.
 */
function problemNotes(problems: readonly TransportProblem[]): HTMLElement[] {
  const oversized = problems.filter((problem) => problem.kind === 'oversized');
  const failed = problems.filter((problem) => problem.kind === 'relay-failed');
  const notes: HTMLElement[] = [];

  if (oversized.length > 0) {
    notes.push(
      el('p', {
        style: { color: 'var(--hard)' },
        text: `${oversized.length} ${oversized.length === 1 ? 'file was' : 'files were'} too large to send — relays cap one message at 64KB. Those cards will look different on your other devices.`,
      }),
    );
  }
  for (const problem of failed) {
    if (problem.kind !== 'relay-failed') continue;
    notes.push(el('p.faint', { text: `${problem.url}: ${problem.error.message}` }));
  }
  return notes;
}

async function copy(text: string, message: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(message, 'success');
  } catch {
    toast('This browser would not let the page copy. Select the text instead.', 'error');
  }
}
