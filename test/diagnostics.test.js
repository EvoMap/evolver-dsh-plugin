import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createRecallLog, pluginDiagnostics } from '../src/diagnostics.js';
import { hubGene } from '../src/prime.js';
import { evolverTools } from '../src/tools.js';

const PROMPT = 'add a retry to the uploader';
const steps = (count, text = 'step') => Array.from({ length: count }, (_, index) => `${text} ${index}.`);

async function outcomeOf(proxyResult, options = {}) {
  let outcome;
  await hubGene(async () => {
    if (proxyResult instanceof Error) throw proxyResult;
    return proxyResult;
  }, options.prompt ?? PROMPT, { ...options, onOutcome: (value) => { outcome = value; } });
  return outcome;
}

test('a recall reports why it ended, so an empty match is never ambiguous', async () => {
  assert.deepEqual(await outcomeOf({ ok: true, data: {} }, { prompt: 'hi' }), { status: 'skipped', reason: 'prompt_too_short' });

  const down = await outcomeOf({ ok: false, error: 'Proxy request timed out.' });
  assert.equal(down.status, 'proxy_error');
  assert.match(down.error, /timed out/);
  assert.equal((await outcomeOf(new Error('socket hang up'))).error, 'socket hang up');

  assert.deepEqual(await outcomeOf({ ok: true, data: { assets: [] } }), { status: 'no_candidates' });

  const filtered = await outcomeOf({
    ok: true,
    data: {
      assets: [
        { asset_id: 'sha256:thin', strategy: steps(3) },
        { asset_id: 'sha256:long', strategy: steps(12, 'x'.repeat(390)) },
        { asset_id: 'sha256:weak', similarity: 0.1, strategy: steps(5) },
        { asset_id: 'sha256:seen', strategy: steps(5) },
      ],
    },
  }, { listedIds: new Set(['sha256:seen']) });
  assert.deepEqual(filtered, {
    status: 'all_filtered',
    candidates: 4,
    dropped: { too_few_steps: 1, too_long: 1, low_similarity: 1, already_injected: 1 },
  });
});

test('an injected recall names the asset and what it cost', async () => {
  const injected = await outcomeOf({
    ok: true,
    data: { assets: [{ asset_id: 'sha256:thin', similarity: 0.9, strategy: steps(2) }, { asset_id: 'sha256:fit', short_title: 'Retry with jittered backoff', similarity: 0.7, strategy: steps(4) }] },
  });
  assert.equal(injected.status, 'injected');
  assert.equal(injected.asset_id, 'sha256:fit');
  assert.equal(injected.title, 'Retry with jittered backoff');
  assert.equal(injected.steps, 4);
  assert.equal(injected.similarity, 0.7);
  assert.deepEqual(injected.dropped, { too_few_steps: 1 });
  assert.ok(injected.chars > 0);
});

test('the recall log keeps the last outcome with its timing and counts every status', () => {
  let clock = 1_000;
  const log = createRecallLog(() => clock);
  log.record({ status: 'no_candidates' }, 400);
  clock = 2_500;
  log.record({ status: 'proxy_error', error: 'down' }, 2_000);
  const { last, counts } = log.snapshot();
  assert.deepEqual(counts, { no_candidates: 1, proxy_error: 1 });
  assert.equal(last.status, 'proxy_error');
  assert.equal(last.duration_ms, 500);
  assert.equal(last.at, new Date(2_500).toISOString());
});

test('evolver_status reports an unreachable Proxy instead of failing, and still shows the plugin view', async () => {
  const [status] = evolverTools(async () => ({ ok: false, error: 'Proxy connection failed: ECONNREFUSED.' }), {
    diagnostics: async () => ({ plugin: { version: '9.9.9' } }),
  });
  const report = await status.execute({}, {});
  assert.deepEqual(report.proxy, { reachable: false, error: 'Proxy connection failed: ECONNREFUSED.' });
  assert.equal(report.plugin.version, '9.9.9');

  const [up] = evolverTools(async () => ({ ok: true, data: { node_id: 'node_x', status: 'running' } }));
  assert.deepEqual(await up.execute({}, {}), { proxy: { reachable: true, node_id: 'node_x', status: 'running' } });
});

test('diagnostics flag a running Proxy older than the minimum even when PATH has a newer evolver', async () => {
  const home = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), 'evolver-diagnostics-home-'));
  try {
    mkdirSync(join(process.env.HOME, '.evolver'));
    writeFileSync(join(process.env.HOME, '.evolver', 'settings.json'), JSON.stringify({
      proxy: { url: 'http://127.0.0.1:19999', token: 'secret-token', version: '2.0.30', pid: 4242, started_at: '2026-10-01T00:00:00.000Z' },
    }));
    const report = await pluginDiagnostics({
      config: { assetPrimeWaitMs: 5_000 },
      engineVersion: Promise.resolve('2.0.39'),
      recallLog: createRecallLog(),
    });
    assert.equal(report.plugin.name, '@evomap/dsh-evolver');
    assert.equal(report.proxy_endpoint.url, 'http://127.0.0.1:19999');
    assert.equal(report.proxy_endpoint.token_present, true);
    assert.equal(report.proxy_endpoint.pid, 4242);
    assert.doesNotMatch(JSON.stringify(report), /secret-token/);
    assert.deepEqual(report.engine, {
      path_version: '2.0.39',
      running_version: '2.0.30',
      minimum_version: '2.0.39',
      meets_minimum: false,
      path_differs_from_running: true,
    });
    assert.equal(report.recall.wait_ms, 5_000);
    assert.equal(report.recall.max_strategy_chars, 4_000);
    assert.equal(report.runtime.platform, process.platform);
  } finally {
    process.env.HOME = home;
  }
});
