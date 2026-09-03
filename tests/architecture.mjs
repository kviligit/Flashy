/**
 * Structural checks that TypeScript cannot express.
 *
 * These are properties of the *shape* of the tree rather than of any
 * value in it, so they are checked by reading the source rather than by
 * running it. Plain JavaScript because this project has no @types/node
 * and so cannot typecheck filesystem access.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd(), 'src');
let failed = 0;

function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
}

function sourceFiles(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (entry.endsWith('.ts')) found.push(path);
  }
  return found;
}

console.log('architecture');

/*
 * The hand-written cryptographic primitives must stay behind one door.
 *
 * `src/nostr/primitives.ts` exists so that replacing secp256k1.ts and
 * chacha20.ts with an audited library is one edit. That only holds while
 * nothing reaches past it, and an import added in a hurry six months
 * from now is exactly how a single swap point turns back into a hunt
 * through the tree. So it is enforced rather than requested.
 *
 * The implementations may refer to each other, and their own tests
 * import them directly — that is what makes those tests the conformance
 * check a replacement has to pass.
 */
const ALLOWED_TO_REACH_THROUGH = new Set([
  'primitives.ts',
  'secp256k1.ts',
  'chacha20.ts',
  'secp256k1.test.ts',
  'chacha20.test.ts',
  'nip44.test.ts',
]);

const offenders = [];
for (const path of sourceFiles(ROOT)) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (ALLOWED_TO_REACH_THROUGH.has(name)) continue;
  const source = readFileSync(path, 'utf8');
  for (const module of ['secp256k1\\.js', 'chacha20\\.js']) {
    if (new RegExp(`from\\s+['"][^'"]*${module}['"]`).test(source)) {
      offenders.push(`${path.slice(ROOT.length + 1)} -> ${module.replace('\\', '')}`);
    }
  }
}
check(
  'nothing reaches past primitives.ts to the hand-written crypto',
  offenders.length === 0,
  offenders.join('; '),
);

/*
 * A warning that outlives its reason teaches people to ignore warnings.
 * If the hand-written files are gone, the flag that drives the warning
 * must have gone with them.
 */
const nostrFiles = new Set(readdirSync(join(ROOT, 'nostr')));
const handWritten = nostrFiles.has('secp256k1.ts') || nostrFiles.has('chacha20.ts');
const flag = /PRIMITIVES_ARE_HAND_WRITTEN\s*=\s*(true|false)/.exec(
  readFileSync(join(ROOT, 'nostr', 'primitives.ts'), 'utf8'),
);
check(
  'the hand-written flag matches what is actually in the tree',
  flag !== null && (flag[1] === 'true') === handWritten,
  handWritten
    ? 'the implementations are still here, so the flag must be true'
    : 'the implementations are gone; set PRIMITIVES_ARE_HAND_WRITTEN to false',
);

console.log(failed === 0 ? '\narchitecture: ok' : `\narchitecture: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
