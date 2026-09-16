import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evolverTools } from '../src/tools.js';

function harness() {
  const calls = [];
  const proxyFetch = async (...args) => {
    calls.push(args);
    return { ok: true, data: {} };
  };
  const tools = evolverTools(proxyFetch);
  const byName = (name) => tools.find((tool) => tool.name === name);
  return { calls, byName, tools };
}

test('registers the complete Proxy-supported tool surface', () => {
  const names = harness().tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'evolver_asset_reuse_result',
    'evolver_distill_conversation',
    'evolver_fetch_asset',
    'evolver_poll',
    'evolver_publish_asset',
    'evolver_search_assets',
    'evolver_status',
  ]);
});

test('rejects unknown, empty, and out-of-range tool arguments locally', async () => {
  const { byName } = harness();
  await assert.rejects(() => byName('evolver_search_assets').execute({ qurey: 'typo' }, {}), /Unknown argument/);
  await assert.rejects(() => byName('evolver_search_assets').execute({}, {}), /Provide at least one/);
  await assert.rejects(() => byName('evolver_search_assets').execute({ text: 'task', limit: 26 }, {}), /1 through 25/);
  await assert.rejects(() => byName('evolver_fetch_asset').execute({ asset_ids: [] }, {}), /at least one/);
  await assert.rejects(() => byName('evolver_publish_asset').execute({ assets: [] }, {}), /at least one/);
  await assert.rejects(
    () => byName('evolver_asset_reuse_result').execute({ asset_id: 'sha256:abc', outcome: 'success', time_saved_seconds: -1 }, {}),
    /non-negative/,
  );
  await assert.rejects(() => byName('evolver_poll').execute({ limit: 0 }, {}), /1 through 50/);
});

test('forwards caller cancellation to the Proxy', async () => {
  const { byName, calls } = harness();
  const signal = new AbortController().signal;
  await byName('evolver_status').execute({}, { signal });
  assert.equal(calls[0][3], signal);
});

test('conversation distillation persists locally by default and publishes only when asked', async () => {
  const { byName, calls } = harness();
  await byName('evolver_distill_conversation').execute({ summary: 'A concrete verified result.' }, {});
  assert.equal(calls[0][1], '/conversation/distill');
  assert.equal(calls[0][2].platform, 'dsh');
  assert.equal(calls[0][2].persist, true);
  assert.equal(calls[0][2].publish, false);
});
