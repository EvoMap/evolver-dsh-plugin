import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hubGene, promptTextOf } from '../src/prime.js';

function stubProxy({ search, fetch: fetched }) {
  const calls = [];
  const proxyFetch = async (method, path, body, signal) => {
    calls.push({ method, path, body, signal });
    const data = path === '/asset/search' ? search : fetched;
    if (data instanceof Error) throw data;
    return data === undefined ? { ok: false, error: 'nope' } : { ok: true, data };
  };
  return { proxyFetch, calls };
}

const HIT = { asset_id: 'sha256:abc', asset_type: 'Gene', has_strategy: true };
const ASSET = {
  asset_id: 'sha256:abc',
  summary: 'Retry the upload with backoff.',
  strategy: ['  Measure the failure rate first.  ', 'Add jittered backoff.', ''],
  validation: ['npm test'],
};

test('the prompt text comes from the user, not from dsh\'s own injections', () => {
  const text = promptTextOf([
    { content: [{ type: 'text', text: '  add a retry to the uploader  ' }], source: { kind: 'user' } },
    { content: [{ type: 'text', text: '[Evolver] earlier notice' }], source: { kind: 'plugin', plugin: 'evolver' } },
    { content: [{ type: 'text', text: '<system-reminder> the skill catalog' }], source: { kind: 'skill-catalog' } },
    { content: [{ type: 'image', data: 'ignored' }], source: { kind: 'user' } },
  ]);

  assert.equal(text, 'add a retry to the uploader');
});

test('one asset is fetched and injected as its strategy alone', async () => {
  const { proxyFetch, calls } = stubProxy({
    search: { results: [HIT, { asset_id: 'sha256:second', has_strategy: true }] },
    fetch: { assets: [ASSET] },
  });
  const controller = new AbortController();
  const { ids, text } = await hubGene(proxyFetch, 'add a retry to the uploader', { signal: controller.signal });

  assert.deepEqual(calls.map((call) => call.path), ['/asset/search', '/asset/fetch']);
  assert.deepEqual(calls[1].body, { asset_ids: ['sha256:abc'] });
  assert.equal(calls[0].signal, controller.signal);
  assert.deepEqual(ids, ['sha256:abc']);
  assert.match(text, /Strategy reused from Gene sha256:abc \(EvoMap network\)/);
  assert.match(text, /^1\. Measure the failure rate first\.$/m);
  assert.match(text, /^2\. Add jittered backoff\.$/m);
  assert.doesNotMatch(text, /Retry the upload with backoff|npm test|sha256:second/);
  assert.match(text, /evolver_asset_reuse_result/);
});

test('a bounded prompt reaches the Hub, and a trivial one never does', async () => {
  const long = stubProxy({ search: { results: [] } });
  await hubGene(long.proxyFetch, 'x'.repeat(5_000));
  assert.ok(long.calls[0].body.text.length <= 5_000);
  assert.equal(long.calls[0].body.limit, 5);

  const trivial = stubProxy({ search: { results: [HIT] }, fetch: { assets: [ASSET] } });
  assert.deepEqual(await hubGene(trivial.proxyFetch, 'hi'), { ids: [], text: '' });
  assert.equal(trivial.calls.length, 0);
});

test('hits without a strategy are skipped before they cost a fetch', async () => {
  const { proxyFetch, calls } = stubProxy({
    search: { results: [{ asset_id: 'sha256:thin', has_strategy: false }] },
    fetch: { assets: [ASSET] },
  });

  assert.deepEqual(await hubGene(proxyFetch, 'add a retry to the uploader'), { ids: [], text: '' });
  assert.deepEqual(calls.map((call) => call.path), ['/asset/search']);
});

test('an asset already injected this session is passed over', async () => {
  const { proxyFetch, calls } = stubProxy({
    search: { results: [HIT, { asset_id: 'sha256:next', asset_type: 'Capsule', has_strategy: true }] },
    fetch: { results: [{ asset_id: 'sha256:next', payload: { strategy: 'Drain the queue first.' } }] },
  });

  const { ids, text } = await hubGene(proxyFetch, 'add a retry to the uploader', {
    listedIds: new Set(['sha256:abc']),
  });

  assert.deepEqual(calls[1].body, { asset_ids: ['sha256:next'] });
  assert.deepEqual(ids, ['sha256:next']);
  assert.match(text, /Capsule sha256:next/);
  assert.match(text, /^1\. Drain the queue first\.$/m);
});

test('a cached answer says the Hub was unavailable', async () => {
  const { proxyFetch } = stubProxy({ search: { degraded: true, results: [HIT] }, fetch: { assets: [ASSET] } });
  const { text } = await hubGene(proxyFetch, 'add a retry to the uploader');

  assert.match(text, /local cache, the Hub was unavailable/);
});

test('a failing Proxy, an empty result, and a strategy-less asset inject nothing', async () => {
  const down = stubProxy({ search: undefined });
  assert.deepEqual(await hubGene(down.proxyFetch, 'add a retry to the uploader'), { ids: [], text: '' });

  const throwing = stubProxy({ search: new Error('socket hang up') });
  assert.deepEqual(await hubGene(throwing.proxyFetch, 'add a retry to the uploader'), { ids: [], text: '' });

  const empty = stubProxy({ search: { results: [] } });
  assert.deepEqual(await hubGene(empty.proxyFetch, 'add a retry to the uploader'), { ids: [], text: '' });

  const hollow = stubProxy({ search: { results: [HIT] }, fetch: { assets: [{ asset_id: 'sha256:abc', summary: 'only prose' }] } });
  assert.deepEqual(await hubGene(hollow.proxyFetch, 'add a retry to the uploader'), { ids: [], text: '' });

  const missed = stubProxy({ search: { results: [HIT] }, fetch: undefined });
  assert.deepEqual(await hubGene(missed.proxyFetch, 'add a retry to the uploader'), { ids: [], text: '' });
});
