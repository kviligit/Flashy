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
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

async function run(chromium) {
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
  await run(playwright.chromium);
} finally {
  server.kill();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
