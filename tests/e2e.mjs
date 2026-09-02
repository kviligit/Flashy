/**
 * End-to-end smoke test: drives a real browser through the paths that
 * matter — add a note, study it, undo, browse, back up, restore.
 *
 * Run with `npm run e2e`. It needs Playwright and a Chromium; if neither is
 * available it says so and skips rather than pretending to pass.
 *
 * The unit suite (`npm test`) covers the algorithm and the services. This
 * covers the wiring between them, which unit tests cannot see.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const PORT = Number(process.env.PORT ?? 5199);
const BASE = `http://127.0.0.1:${PORT}/index.html`;

async function loadPlaywright() {
  const candidates = [
    'playwright',
    'playwright-core',
    '/opt/node22/lib/node_modules/playwright/index.mjs',
  ];
  for (const id of candidates) {
    try {
      return await import(id);
    } catch {
      // try the next one
    }
  }
  // Fall back to a CommonJS resolution, which finds local installs.
  try {
    const require = createRequire(import.meta.url);
    return require('playwright');
  } catch {
    return null;
  }
}

function startServer() {
  const child = spawn('python3', ['-m', 'http.server', String(PORT)], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: 'ignore',
  });
  return child;
}

async function waitForServer(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(BASE);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`server did not start on port ${PORT}`);
}

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function run(playwright) {
  const { chromium, devices } = playwright;
  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  const scratch = mkdtempSync(join(tmpdir(), 'flashy-e2e-'));

  try {
    // --- the app starts and seeds itself ---
    await page.goto(`${BASE}#/`);
    await page.waitForSelector('.deck-row', { timeout: 15000 });
    check('starts with a seeded Default deck', (await page.locator('.deck-row').count()) === 1);

    // --- adding notes ---
    await page.goto(`${BASE}#/add`);
    await page.waitForSelector('textarea[data-field]');
    for (const [front, back] of [['un', 'one'], ['deux', 'two'], ['trois', 'three']]) {
      await page.fill('textarea[data-field="Front"]', front);
      await page.fill('textarea[data-field="Back"]', back);
      await page.click('button:has-text("Add note")');
      await page.waitForTimeout(80);
    }
    check('the editor clears after adding', (await page.inputValue('textarea[data-field="Front"]')) === '');

    // --- a reversed note makes two cards ---
    await page.selectOption('select', { label: 'Basic (and reversed card)' });
    await page.fill('textarea[data-field="Front"]', 'merci');
    await page.fill('textarea[data-field="Back"]', 'thanks');
    check(
      'a reversed note previews two cards',
      (await page.getAttribute('[data-card-count]', 'data-card-count')) === '2',
    );
    await page.click('button:has-text("Add note")');
    await page.waitForTimeout(150);

    // --- deck counts ---
    await page.goto(`${BASE}#/`);
    await page.waitForSelector('.deck-row');
    const counts = (await page.locator('[data-deck="Default"] .deck-counts').innerText()).split('\n');
    check('the deck shows 5 new cards', counts[0] === '5', `saw ${counts.join('/')}`);

    // --- studying ---
    await page.locator('[data-deck="Default"] .name').click();
    await page.waitForSelector('.review-content');
    check('a question is shown first', (await page.getAttribute('.review-content', 'data-side')) === 'question');

    await page.keyboard.press('Space');
    await page.waitForSelector('[data-rating]');
    check('space reveals the answer', (await page.getAttribute('.review-content', 'data-side')) === 'answer');
    check('all four ratings are offered', (await page.locator('[data-rating]').count()) === 4);

    const labels = await page.locator('[data-rating] .ivl').allInnerTexts();
    check('every rating shows an interval', labels.every((label) => label.trim().length > 0), labels.join(','));

    await page.keyboard.press('3');
    await page.waitForTimeout(200);
    const afterAnswer = (await page.locator('.review-header').innerText()).split('\n');
    check('answering moves a card out of the new queue', afterAnswer.includes('4'), afterAnswer.join('/'));

    await page.keyboard.press('u');
    await page.waitForTimeout(300);
    const afterUndo = (await page.locator('.review-header').innerText()).split('\n');
    check('undo puts it back', afterUndo.includes('5'), afterUndo.join('/'));

    // --- finish the deck ---
    for (let i = 0; i < 80; i++) {
      if (await page.locator('[data-done]').count()) break;
      if (!(await page.locator('[data-rating]').count())) {
        await page.keyboard.press('Space');
        await page.waitForTimeout(50);
      }
      await page.keyboard.press('3');
      await page.waitForTimeout(60);
    }
    check('the deck can be finished', (await page.locator('[data-done]').count()) > 0);

    // --- browsing ---
    await page.goto(`${BASE}#/browse`);
    await page.waitForSelector('table.browse tbody tr');
    check('every card is listed', (await page.getAttribute('[data-count]', 'data-count')) === '5');
    await page.fill('input[type="search"]', 'merci');
    await page.waitForTimeout(150);
    check('search narrows the list', (await page.getAttribute('[data-count]', 'data-count')) === '2');
    await page.fill('input[type="search"]', 'is:suspended');
    await page.waitForTimeout(150);
    check('state search works', (await page.getAttribute('[data-count]', 'data-count')) === '0');

    // --- stats ---
    await page.goto(`${BASE}#/stats`);
    await page.waitForSelector('[data-stat="retention"]');
    check('stats render every chart', (await page.locator('[data-chart]').count()) >= 4);

    // --- backup and restore ---
    await page.goto(`${BASE}#/manage`);
    await page.waitForSelector('[data-action="export-backup"]');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('[data-action="export-backup"]'),
    ]);
    const backupPath = join(scratch, 'backup.json');
    await download.saveAs(backupPath);
    const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
    check('the backup contains every note', backup.notes.length === 4, `saw ${backup.notes.length}`);
    check('the backup contains every card', backup.cards.length === 5, `saw ${backup.cards.length}`);
    check('the backup contains the review history', backup.reviewLogs.length > 0);

    await page.goto(`${BASE}#/debug/sample`);
    await page.waitForSelector('button:has-text("Wipe collection")');
    await page.click('button:has-text("Wipe collection")');
    await page.click('.modal footer button.danger');
    await page.waitForTimeout(700);

    await page.goto(`${BASE}#/browse`);
    await page.waitForSelector('.empty, table.browse');
    check('wiping empties the collection', (await page.locator('table.browse tbody tr').count()) === 0);

    await page.goto(`${BASE}#/manage`);
    // The file inputs are hidden by design and driven by a button, so wait
    // for them to be attached rather than visible.
    await page.waitForSelector('[data-role="backup-file"]', { state: 'attached' });
    await page.setInputFiles('[data-role="backup-file"]', backupPath);
    await page.click('.modal footer button.danger');
    await page.waitForTimeout(1200);
    await page.goto(`${BASE}#/browse`);
    await page.waitForSelector('table.browse tbody tr');
    check('restoring brings everything back', (await page.getAttribute('[data-count]', 'data-count')) === '5');

    // --- CSV import ---
    const csvPath = join(scratch, 'import.csv');
    writeFileSync(csvPath, 'Front,Back,Tags\nhola,hello,spanish\ngracias,"thanks, a lot",spanish\n');
    await page.goto(`${BASE}#/manage`);
    await page.waitForSelector('[data-role="csv-file"]', { state: 'attached' });
    await page.setInputFiles('[data-role="csv-file"]', csvPath);
    await page.waitForSelector('[data-action="run-csv-import"]');
    await page.click('[data-action="run-csv-import"]');
    await page.waitForTimeout(700);
    await page.goto(`${BASE}#/browse`);
    await page.waitForSelector('table.browse tbody tr');
    await page.fill('input[type="search"]', 'gracias');
    await page.waitForTimeout(150);
    check('CSV import handles quoted commas', (await page.getAttribute('[data-count]', 'data-count')) === '1');

    // --- settings ---
    await page.goto(`${BASE}#/settings`);
    await page.waitForSelector('[data-preset]');
    check('settings lists the note types', (await page.locator('[data-notetype]').count()) === 3);

    // --- accessibility basics ---
    await page.goto(`${BASE}#/`);
    await page.waitForSelector('.deck-row');
    const unnamed = await page.locator('button').evaluateAll((buttons) =>
      buttons.filter((b) => !b.textContent.trim() && !b.getAttribute('aria-label')).length,
    );
    check('every button has an accessible name', unnamed === 0, `${unnamed} unnamed`);
    check('there is a skip link', (await page.locator('.skip-link').count()) === 1);
    check('the main region is addressable', (await page.locator('main#main').count()) === 1);

    // --- editor snippets ---
    await page.goto(`${BASE}#/add`);
    await page.waitForSelector('[data-snippet="Definer:"]');
    await page.click('[data-snippet="Definer:"]');
    check(
      'the Definer button starts the card',
      (await page.inputValue('textarea[data-field="Front"]')) === 'Definer: ',
    );
    await page.keyboard.type('entropi');
    await page.click('[data-snippet="Definer:"]');
    check(
      'pressing it again does not double the opening',
      (await page.inputValue('textarea[data-field="Front"]')) === 'Definer: entropi',
    );
    await page.click('textarea[data-field="Back"]');
    await page.keyboard.type('svar');
    await page.click('[data-snippet="Definer:"]');
    check(
      'it acts on the field you were last in',
      (await page.inputValue('textarea[data-field="Back"]')) === 'Definer: svar',
    );
    await page.fill('textarea[data-field="Front"]', '');
    await page.fill('textarea[data-field="Back"]', '');

    // --- media ---
    // Attaching a file, seeing it decoded on a real card, and getting it
    // back after a restore. An image that survives everything except the
    // backup would be the worst kind of bug: invisible until it matters.
    await page.goto(`${BASE}#/add`);
    await page.waitForSelector('textarea[data-field]');
    await page.selectOption('select', { label: 'Basic' });
    await page.fill('textarea[data-field="Back"]', 'a red square');
    await page.setInputFiles('[data-media-input="Front"]', `${FIXTURES}red.png`);
    await page.waitForTimeout(400);

    const inserted = await page.inputValue('textarea[data-field="Front"]');
    check('attaching inserts a media reference', /^<img src="flashy-media:[0-9a-f]{32}"/.test(inserted), inserted);
    check(
      'an image-only field still produces a card',
      (await page.getAttribute('[data-card-count]', 'data-card-count')) === '1',
    );

    const previewed = await page.locator('[data-preview="question"] img').evaluate((node) => ({
      blob: node.getAttribute('src').startsWith('blob:'),
      width: node.naturalWidth,
    }));
    check('the preview shows a decoded image', previewed.blob && previewed.width === 8, JSON.stringify(previewed));

    // The same bytes under a different name must not be stored twice.
    await page.setInputFiles('[data-media-input="Back"]', `${FIXTURES}red.png`);
    await page.waitForTimeout(400);
    await page.click('button:has-text("Add note")');
    await page.waitForTimeout(300);

    await page.fill('textarea[data-field="Front"]', 'a sound');
    await page.setInputFiles('[data-media-input="Back"]', `${FIXTURES}beep.wav`);
    await page.waitForTimeout(400);
    await page.click('button:has-text("Add note")');
    await page.waitForTimeout(300);

    const mediaCount = await page.evaluate(async () => {
      const request = indexedDB.open('flashy');
      const db = await new Promise((resolve) => {
        request.onsuccess = () => resolve(request.result);
      });
      return new Promise((resolve) => {
        const query = db.transaction('media').objectStore('media').count();
        query.onsuccess = () => resolve(query.result);
      });
    });
    check('identical files are stored once', mediaCount === 2, `saw ${mediaCount} files`);

    await page.goto(`${BASE}#/manage`);
    await page.waitForSelector('[data-card="media"]');
    check('the media manager lists every file', (await page.locator('[data-media]').count()) === 2);
    const summary = await page.locator('[data-card="media"] p.muted').innerText();
    check('the media manager reports usage', /Every file is in use/.test(summary), summary);

    const [mediaBackup] = await Promise.all([
      page.waitForEvent('download'),
      page.click('[data-action="export-backup"]'),
    ]);
    const mediaBackupPath = join(scratch, 'media-backup.json');
    await mediaBackup.saveAs(mediaBackupPath);
    const withMedia = JSON.parse(readFileSync(mediaBackupPath, 'utf8'));
    check('the backup carries the media', withMedia.media.length === 2, `saw ${withMedia.media.length}`);
    check('media bytes travel as base64', typeof withMedia.media[0].data === 'string');

    await page.goto(`${BASE}#/debug/sample`);
    await page.waitForSelector('button:has-text("Wipe collection")');
    await page.click('button:has-text("Wipe collection")');
    await page.click('.modal footer button.danger');
    await page.waitForTimeout(700);

    await page.goto(`${BASE}#/manage`);
    await page.waitForSelector('[data-role="backup-file"]', { state: 'attached' });
    await page.setInputFiles('[data-role="backup-file"]', mediaBackupPath);
    await page.click('.modal footer button.danger');
    await page.waitForTimeout(1200);

    // Find the note with the image rather than assuming it is first in the
    // queue — after a restore the collection holds everything, and the
    // queue order is the scheduler's business, not this test's.
    await page.goto(`${BASE}#/browse`);
    await page.waitForSelector('table.browse tbody tr');
    await page.fill('input[type="search"]', 'red square');
    await page.waitForTimeout(200);
    await page.locator('table.browse tbody tr button:has-text("Info")').first().click();
    await page.waitForSelector('.modal .preview-card');
    const restoredImage = await page
      .locator('.modal .preview-card img')
      .first()
      .evaluate((node) => ({
        blob: (node.getAttribute('src') ?? '').startsWith('blob:'),
        width: node.naturalWidth,
      }));
    check(
      'a restored image still decodes on a card',
      restoredImage.blob && restoredImage.width === 8,
      JSON.stringify(restoredImage),
    );
    await page.click('.modal footer button');
    await page.waitForTimeout(200);

    // Deleting the notes should leave the files orphaned but present, and
    // the manager should then be able to reclaim them.
    await page.goto(`${BASE}#/browse`);
    await page.waitForSelector('table.browse tbody tr');
    // Navigating to the hash we are already on fires no hashchange, so the
    // route is not rebuilt and the previous search is still in force.
    // Clear it explicitly rather than assuming a fresh view.
    await page.fill('input[type="search"]', '');
    await page.waitForTimeout(300);

    // Every note, so that both files are genuinely orphaned — picking two
    // rows at random leaves whichever media the other note still uses.
    //
    // Wait for the table to match the count the page reports before
    // counting rows: reading mid-redraw sees a partial table, ticks a
    // fraction of it, and then "delete everything" quietly deletes one
    // thing.
    const expectedRows = Number(await page.getAttribute('[data-count]', 'data-count'));
    await page.waitForFunction(
      (n) => document.querySelectorAll('table.browse tbody tr').length === n,
      expectedRows,
      { timeout: 5000 },
    );

    const boxes = page.locator('table.browse tbody tr input[type="checkbox"]');
    const rowCount = await boxes.count();
    check('the browser lists every card before selecting', rowCount === expectedRows, `${rowCount} of ${expectedRows}`);
    for (let i = 0; i < rowCount; i++) await boxes.nth(i).check();

    // The count the toolbar reports is the selection the bulk actions will
    // act on. If a tick is registered against a selection that a re-render
    // has already replaced, the two diverge and delete removes the wrong
    // notes — silently. Redrawing is asynchronous, so wait for the count to
    // settle rather than reading it mid-flight.
    let reported = '';
    try {
      await page.waitForFunction(
        (expected) =>
          document.querySelector('.browse-toolbar strong')?.textContent === `${expected} selected`,
        rowCount,
        { timeout: 5000 },
      );
      reported = `${rowCount} selected`;
    } catch {
      reported = (await page.locator('.browse-toolbar strong').innerText().catch(() => 'nothing')) || 'nothing';
    }
    check(
      'every ticked row is actually selected',
      reported === `${rowCount} selected`,
      `${rowCount} ticked, toolbar says "${reported}"`,
    );

    await page.click('button:has-text("Delete notes…")');
    await page.waitForSelector('.modal');
    const confirmText = (await page.locator('.modal .body').innerText()).replace(/\n/g, ' ');
    await page.click('.modal footer button.danger');
    await page.waitForTimeout(800);

    const afterDelete = await page.evaluate(async () => {
      const request = indexedDB.open('flashy');
      const db = await new Promise((resolve) => {
        request.onsuccess = () => resolve(request.result);
      });
      return new Promise((resolve) => {
        const query = db.transaction('notes').objectStore('notes').count();
        query.onsuccess = () => resolve(query.result);
      });
    });
    check(
      'deleting the whole selection removes every note',
      afterDelete === 0,
      `${afterDelete} left after "${confirmText}" (${rowCount} cards selected)`,
    );

    await page.goto(`${BASE}#/manage`);
    await page.waitForSelector('[data-card="media"]');
    const orphanSummary = await page.locator('[data-card="media"] p.muted').innerText();
    check('orphaned files are reported, not silently deleted', /no longer used/.test(orphanSummary), orphanSummary);

    await page.click('[data-action="cleanup-media"]');
    await page.click('.modal footer button.danger');
    await page.waitForTimeout(800);

    // Read the database rather than counting rows: whether the files are
    // gone is the actual claim, and the table is redrawn asynchronously.
    const afterCleanup = await page.evaluate(async () => {
      const request = indexedDB.open('flashy');
      const db = await new Promise((resolve) => {
        request.onsuccess = () => resolve(request.result);
      });
      const readAll = (store) =>
        new Promise((resolve) => {
          const query = db.transaction(store).objectStore(store).getAll();
          query.onsuccess = () => resolve(query.result);
        });
      const [media, notes] = await Promise.all([readAll('media'), readAll('notes')]);
      return { media: media.length, notes: notes.length };
    });
    check(
      'cleanup reclaims the orphans',
      afterCleanup.media === 0,
      `${afterCleanup.media} file(s) left, ${afterCleanup.notes} note(s) remain`,
    );

    // --- schema migration ---
    // A collection created by v1 must survive the upgrade to v2 with its
    // data intact and its new indexes in place. This is the one path that
    // can silently destroy someone's review history.
    const migration = await page.evaluate(async () => {
      const NAME = 'flashy-migration-test';
      await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase(NAME);
        request.onsuccess = resolve;
        request.onerror = resolve;
        request.onblocked = resolve;
      });

      // Build the v1 schema by hand: no deletions store, no modified index
      // on decks.
      const v1 = await new Promise((resolve, reject) => {
        const request = indexedDB.open(NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          for (const [name, indexes] of [
            ['decks', ['name', 'configId']],
            ['deckConfigs', ['name']],
            ['noteTypes', ['name']],
            ['notes', ['noteTypeId', 'modified']],
            ['cards', ['noteId', 'deckId', 'due', 'state', 'position', 'modified']],
            ['reviewLogs', ['cardId', 'reviewedAt']],
            ['meta', []],
          ]) {
            const store = db.createObjectStore(name, { keyPath: 'id' });
            for (const index of indexes) store.createIndex(index, index, { unique: false });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      await new Promise((resolve, reject) => {
        const tx = v1.transaction('decks', 'readwrite');
        tx.objectStore('decks').put({
          id: 'legacy-deck',
          name: 'From v1',
          configId: 'cfg',
          description: '',
          collapsed: false,
          created: 1,
          modified: 42,
        });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      v1.close();

      // Now open it the way the app does, which triggers the upgrade.
      const { IdbDb, deleteDatabase } = await import('../dist/storage/indexeddb.js');
      const db = await IdbDb.open(NAME);
      const survived = await db.decks.get('legacy-deck');
      const byModified = await db.decks.byRange('modified', { lower: 0 });
      await db.deletions.put({
        id: 'decks:x',
        store: 'decks',
        recordId: 'x',
        deletedAt: 1,
      });
      const tombstones = await db.deletions.count();
      db.close();
      await deleteDatabase(NAME);

      return {
        survivedName: survived ? survived.name : null,
        scannedByModified: byModified.length,
        tombstones,
      };
    });

    check('v1 data survives the upgrade to v2', migration.survivedName === 'From v1', String(migration.survivedName));
    check('the upgrade adds the modified index to an existing store', migration.scannedByModified === 1);
    check('the upgrade adds the deletions store', migration.tombstones === 1);

    // --- durable storage ---
    const storage = await page.evaluate(async () => {
      if (!navigator.storage || !navigator.storage.persisted) return { supported: false };
      return { supported: true, persisted: await navigator.storage.persisted() };
    });
    check('durable storage was requested', storage.supported === false || typeof storage.persisted === 'boolean');

    // --- offline ---
    await page.goto(`${BASE}#/`);
    await page.waitForSelector('.deck-row');
    await page.waitForTimeout(1200); // let the service worker install
    // serviceWorker.ready never rejects, so it must be raced against a
    // timeout or a failed registration hangs the suite indefinitely.
    const swReady = await page.evaluate(() => {
      if (!navigator.serviceWorker) return false;
      return Promise.race([
        navigator.serviceWorker.ready.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
      ]).catch(() => false);
    });
    check('a service worker is registered', swReady === true);

    if (swReady) {
      await context.setOffline(true);
      await page.reload();
      await page.waitForSelector('.deck-row', { timeout: 15000 });
      check('the app loads with no network', (await page.locator('.deck-row').count()) > 0);
      await context.setOffline(false);
    }

    check('no uncaught errors anywhere', errors.length === 0, errors.slice(0, 3).join(' | '));

    // --- iOS ---
    // Safari clears script-writable storage for sites the user has not
    // returned to, and exempts Home Screen apps. There is no API for this,
    // so the app has to tell the user — and must not nag anyone else.
    const iosErrors = [];

    const iosTab = await browser.newContext({ ...devices['iPhone 13'] });
    const tabPage = await iosTab.newPage();
    tabPage.on('pageerror', (error) => iosErrors.push(String(error)));
    await tabPage.goto(`${BASE}#/`);
    await tabPage.waitForSelector('.deck-row');
    check('an iOS browser tab is told to install', (await tabPage.locator('[data-hint="install"]').count()) === 1);

    await tabPage.goto(`${BASE}#/settings`);
    await tabPage.waitForSelector('[data-card="storage"]');
    const tabState = await tabPage.locator('[data-role="storage-state"]').innerText();
    check('an iOS tab reports its storage as at risk', /at risk/i.test(tabState), tabState);

    await tabPage.goto(`${BASE}#/`);
    await tabPage.waitForSelector('[data-hint="install"]');
    await tabPage.click('[data-action="dismiss-install-hint"]');
    await tabPage.waitForTimeout(200);
    await tabPage.reload();
    await tabPage.waitForSelector('.deck-row');
    check('dismissing the install hint sticks', (await tabPage.locator('[data-hint="install"]').count()) === 0);
    await iosTab.close();

    // The iPhone SE is the tightest modern iPhone — 375x667, and no
    // safe-area insets because it still has a home button — so the
    // installed-app checks run at that size rather than a roomier one.
    const iosApp = await browser.newContext({
      viewport: { width: 375, height: 647 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent: devices['iPhone 13'].userAgent,
    });
    await iosApp.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { get: () => true, configurable: true });
    });
    const appPage = await iosApp.newPage();
    appPage.on('pageerror', (error) => iosErrors.push(String(error)));
    await appPage.goto(`${BASE}#/`);
    await appPage.waitForSelector('.deck-row');
    check('an installed iOS app is not nagged', (await appPage.locator('[data-hint="install"]').count()) === 0);

    await appPage.goto(`${BASE}#/settings`);
    await appPage.waitForSelector('[data-card="storage"]');
    const appState = await appPage.locator('[data-role="storage-state"]').innerText();
    check('an installed iOS app reports its storage as protected', /protected/i.test(appState), appState);

    // Touch targets have to survive the narrower iPhone viewport too.
    await appPage.goto(`${BASE}#/add`);
    await appPage.waitForSelector('textarea[data-field]');
    await appPage.fill('textarea[data-field="Front"]', 'ios');
    await appPage.fill('textarea[data-field="Back"]', 'test');
    await appPage.click('button:has-text("Add note")');
    await appPage.waitForTimeout(200);
    await appPage.goto(`${BASE}#/`);
    await appPage.waitForSelector('.deck-row');
    await appPage.locator('.deck-row .name').first().click();
    await appPage.waitForSelector('.review-content');
    await appPage.locator('[data-action="show-answer"]').click();
    await appPage.waitForSelector('[data-rating]');
    const sizes = await appPage
      .locator('[data-rating]')
      .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)));
    check('answer buttons stay tappable on an iPhone', sizes.every((h) => h >= 44), sizes.join(','));
    const layout = await appPage.evaluate(() => {
      const bar = document.querySelector('.answer-bar');
      const rect = bar.getBoundingClientRect();
      const nav = document.querySelector('.topbar nav');
      return {
        noOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
        barVisible: rect.top >= 0 && rect.bottom <= window.innerHeight,
        navFits: nav ? nav.scrollWidth <= nav.clientWidth + 1 : true,
        scrolls: document.documentElement.scrollHeight > window.innerHeight,
      };
    });
    check('nothing overflows the iPhone SE viewport', layout.noOverflow);
    check('the nav fits without clipping on an iPhone SE', layout.navFits);
    check('the answer buttons are reachable without scrolling', layout.barVisible);
    check('the review screen needs no scrolling on an iPhone SE', !layout.scrolls);
    await iosApp.close();

    check('no uncaught errors on iOS', iosErrors.length === 0, iosErrors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
  }
}

const playwright = await loadPlaywright();
if (!playwright?.chromium) {
  console.log('Playwright is not installed — skipping the end-to-end suite.');
  console.log('Install it with `npm i -D playwright && npx playwright install chromium`.');
  process.exit(0);
}

const server = startServer();
try {
  await waitForServer();
  console.log(`Running end-to-end suite against ${BASE}\n`);
  await run(playwright);
} finally {
  server.kill();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
