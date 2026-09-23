import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { markUndeliverable, undeliverableIds } from '../src/undeliverable.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function isolatedHome(prefix) {
  const home = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), prefix));
  return () => { process.env.HOME = home; };
}

test('an undeliverable id is remembered across processes and forgotten after a day', () => {
  const restore = isolatedHome('evolver-undeliverable-ttl-');
  try {
    const at = Date.UTC(2026, 0, 1);
    markUndeliverable(['sha256:ghost', 'sha256:other'], at);

    assert.deepEqual([...undeliverableIds(at + 60_000)].sort(), ['sha256:ghost', 'sha256:other']);
    assert.deepEqual([...undeliverableIds(at + DAY_MS - 1)].sort(), ['sha256:ghost', 'sha256:other']);
    assert.deepEqual(
      [...undeliverableIds(at + DAY_MS)],
      [],
      'the window is a reprieve, not a ban: the cause was never established',
    );
  } finally {
    restore();
  }
});

test('a fresh sighting extends only the id that was sighted', () => {
  const restore = isolatedHome('evolver-undeliverable-extend-');
  try {
    const at = Date.UTC(2026, 0, 1);
    markUndeliverable(['sha256:stale', 'sha256:fresh'], at);
    markUndeliverable(['sha256:fresh'], at + DAY_MS - 1);

    assert.deepEqual([...undeliverableIds(at + DAY_MS + 1000)], ['sha256:fresh']);
  } finally {
    restore();
  }
});

test('nothing is written for an empty list, and an unknown id is never skipped', () => {
  const restore = isolatedHome('evolver-undeliverable-empty-');
  try {
    markUndeliverable([]);
    markUndeliverable(undefined);
    assert.deepEqual([...undeliverableIds()], []);
  } finally {
    restore();
  }
});
