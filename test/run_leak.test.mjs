// Kontrola úniku v test/run.sh: test, ktorý nechá položku v TMPDIR, zlyhá.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'run-leak-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// Vonkajší TMPDIR pre prípad, že run.sh vlastný nenastaví.
const outer = join(dir, 'outer');
mkdirSync(outer);
const leak = join(dir, 'leak.test.sh');
const clean = join(dir, 'clean.test.sh');
writeFileSync(leak, '#!/usr/bin/env bash\nmkdir "$TMPDIR/leaked"\nexit 0\n');
writeFileSync(clean, '#!/usr/bin/env bash\nd=$(mktemp -d)\nrm -rf "$d"\nexit 0\n');

function runSh(file) {
  return spawnSync('bash', [join(ROOT, 'test/run.sh'), file], { encoding: 'utf8', cwd: ROOT, env: { ...process.env, TMPDIR: outer } });
}

test('test s únikom v TMPDIR zlyhá a vypíše položku', () => {
  const r = runSh(leak);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /ÚNIK TMP/);
  assert.match(r.stderr, /leaked/);
});

test('test, ktorý po sebe zmaže, prejde', () => {
  const r = runSh(clean);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
