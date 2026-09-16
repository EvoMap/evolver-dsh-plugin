import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCaptureCoordinator } from '../src/capture-coordinator.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('snapshots immediately, commits in session order, and flush waits', async () => {
  const first = deferred();
  const order = [];
  const coordinator = createCaptureCoordinator({
    prepare: async ({ turn }) => {
      order.push(`snapshot:${turn}`);
      return { turn };
    },
    commit: async ({ turn }) => {
      order.push(`commit-start:${turn}`);
      if (turn === 1) await first.promise;
      order.push(`commit-end:${turn}`);
    },
  });

  coordinator.schedule({ sessionId: 'session-one', projectDir: '/repo', turn: 1 });
  coordinator.schedule({ sessionId: 'session-one', projectDir: '/repo', turn: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['snapshot:1', 'snapshot:2', 'commit-start:1']);

  first.resolve();
  await coordinator.flush('session-one', '/repo');
  assert.deepEqual(order, [
    'snapshot:1',
    'snapshot:2',
    'commit-start:1',
    'commit-end:1',
    'commit-start:2',
    'commit-end:2',
  ]);
});

test('captures for different sessions may settle independently', async () => {
  const blocked = deferred();
  const order = [];
  const coordinator = createCaptureCoordinator({
    prepare: async (options) => options,
    commit: async ({ sessionId }) => {
      if (sessionId === 'one') await blocked.promise;
      order.push(sessionId);
    },
  });

  coordinator.schedule({ sessionId: 'one', projectDir: '/repo-a' });
  coordinator.schedule({ sessionId: 'two', projectDir: '/repo-b' });
  await coordinator.flush('two', '/repo-b');
  assert.deepEqual(order, ['two']);

  blocked.resolve();
  await coordinator.flushAll();
  assert.deepEqual(order, ['two', 'one']);
});
