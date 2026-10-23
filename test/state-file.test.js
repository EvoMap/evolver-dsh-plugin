import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

import { readState, statePath, updateState } from '../src/state-file.js';
import { freshHome } from './support/host.js';

const MODULE = new URL('../src/state-file.js', import.meta.url).href;
const WRITERS = 4;
const PER_WRITER = 15;

const CHILD = `
  const { statePath, updateState } = await import(process.argv[1]);
  for (const key of process.argv.slice(2)) {
    updateState(statePath('shared.json'), {}, (state) => ({ ...state, [key]: true }));
  }
`;

function writer(keys) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, MODULE, ...keys], { stdio: 'ignore' });
    child.on('exit', resolve);
  });
}

test('an update is read, changed and written under a lock, so parallel writers keep every entry', async (t) => {
  t.after(freshHome('evolver-state-lock-'));
  const keysOf = (writerIndex) => Array.from({ length: PER_WRITER }, (unused, index) => `w${writerIndex}-${index}`);

  await Promise.all(Array.from({ length: WRITERS }, (unused, index) => writer(keysOf(index))));

  const written = readState(statePath('shared.json'), {});
  assert.equal(Object.keys(written).length, WRITERS * PER_WRITER);
});

test('an update that changes nothing leaves the file alone and releases its lock', (t) => {
  t.after(freshHome('evolver-state-noop-'));
  updateState(statePath('kept.json'), {}, () => ({ a: 1 }));
  updateState(statePath('kept.json'), {}, () => undefined);
  assert.deepEqual(readState(statePath('kept.json'), {}), { a: 1 });
  assert.deepEqual(updateState(statePath('kept.json'), {}, (state) => ({ ...state, b: 2 })), { a: 1, b: 2 });
});
