import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, test } from 'node:test';

import { MIN_EVOLVER_VERSION, installedEvolverVersion, isOlderThan, upgradeNoticeText } from '../src/engine-version.js';

const previousPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = previousPath;
});

function evolverOnPath(script) {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-bin-'));
  const bin = join(dir, 'evolver');
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  process.env.PATH = `${dir}${delimiter}${previousPath}`;
}

test('compares release numbers numerically, not as text', () => {
  assert.equal(isOlderThan('2.0.38', '2.0.39'), true);
  assert.equal(isOlderThan('2.0.39', '2.0.39'), false);
  assert.equal(isOlderThan('2.0.100', '2.0.39'), false);
  assert.equal(isOlderThan('2.1.0', '2.0.39'), false);
  assert.equal(isOlderThan('1.99.99', '2.0.39'), true);
  assert.equal(isOlderThan('not a version', '2.0.39'), false);
});

test('asks for an upgrade only below the minimum', () => {
  assert.match(upgradeNoticeText('2.0.38'), /2\.0\.38.*2\.0\.39.*npm install -g @evomap\/evolver@latest/s);
  assert.equal(upgradeNoticeText(MIN_EVOLVER_VERSION), null);
  assert.equal(upgradeNoticeText('2.1.0'), null);
  assert.equal(upgradeNoticeText(null), null);
});

test('reads the version the installed CLI prints', { skip: process.platform === 'win32' }, async () => {
  evolverOnPath('echo "evolver v2.0.38"');
  assert.equal(await installedEvolverVersion(), '2.0.38');
});

test('reports no version when the CLI is missing or fails', { skip: process.platform === 'win32' }, async () => {
  evolverOnPath('exit 1');
  assert.equal(await installedEvolverVersion(), null);
  process.env.PATH = mkdtempSync(join(tmpdir(), 'evolver-empty-path-'));
  assert.equal(await installedEvolverVersion(), null);
});
