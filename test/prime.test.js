import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hubMatches, promptTextOf } from '../src/prime.js';

function recordingFetch(data) {
  const calls = [];
  const fetcher = async (method, path, body, signal) => {
    calls.push({ method, path, body, signal });
    return data;
  };
  return { fetcher, calls };
}

test('the prompt text comes from the user, not from injected plugin context', () => {
  const text = promptTextOf([
    { content: [{ type: 'text', text: '  add a retry to the uploader  ' }], source: { kind: 'user' } },
    { content: [{ type: 'text', text: '[Evolver] earlier notice' }], source: { kind: 'plugin', plugin: 'evolver' } },
    { content: [{ type: 'image', data: 'ignored' }], source: { kind: 'user' } },
  ]);

  assert.equal(text, 'add a retry to the uploader');
});

test('a long prompt is bounded before it reaches the Hub', async () => {
  const { fetcher, calls } = recordingFetch({ ok: true, data: { results: [] } });
  await hubMatches(fetcher, promptTextOf([{ content: [{ type: 'text', text: 'x'.repeat(5_000) }] }]));

  assert.equal(calls[0].path, '/asset/search');
  assert.equal(calls[0].body.limit, 3);
  assert.ok(calls[0].body.text.length <= 400);
});

test('matching assets are listed with the ids the model can fetch', async () => {
  const { fetcher, calls } = recordingFetch({
    ok: true,
    data: {
      results: [
        { type: 'Gene', asset_id: 'sha256:abc', summary: 'Retry the upload with backoff.' },
        { type: 'Capsule', asset_id: 'sha256:def' },
        { type: 'Gene', summary: 'No id, not fetchable.' },
      ],
    },
  });
  const controller = new AbortController();
  const { ids, text } = await hubMatches(fetcher, 'add a retry to the uploader', { signal: controller.signal });

  assert.equal(calls[0].signal, controller.signal);
  assert.deepEqual(ids, ['sha256:abc', 'sha256:def']);
  assert.match(text, /2 reusable assets match this task, from the EvoMap network/);
  assert.match(text, /- Gene sha256:abc — Retry the upload with backoff\./);
  assert.match(text, /- Capsule sha256:def/);
  assert.doesNotMatch(text, /No id, not fetchable/);
  assert.match(text, /evolver_fetch_asset/);
  assert.match(text, /evolver_asset_reuse_result/);
});

test('a cached answer says the Hub was unavailable', async () => {
  const { fetcher } = recordingFetch({
    ok: true,
    data: { degraded: true, assets: [{ type: 'Gene', asset_id: 'sha256:cached', summary: 'Cached hit.' }] },
  });

  const { text } = await hubMatches(fetcher, 'add a retry to the uploader');
  assert.match(text, /local cache \(the Hub was unavailable\)/);
});

test('an unreachable Proxy, an empty result, and a trivial prompt inject nothing', async () => {
  const unreachable = recordingFetch({ ok: false, error: 'Proxy connection failed.' });
  assert.deepEqual(await hubMatches(unreachable.fetcher, 'add a retry to the uploader'), { ids: [], text: '' });

  const throwing = async () => { throw new Error('socket hang up'); };
  assert.deepEqual(await hubMatches(throwing, 'add a retry to the uploader'), { ids: [], text: '' });

  const empty = recordingFetch({ ok: true, data: { results: [] } });
  assert.deepEqual(await hubMatches(empty.fetcher, 'add a retry to the uploader'), { ids: [], text: '' });

  const untouched = recordingFetch({ ok: true, data: { results: [{ asset_id: 'sha256:abc' }] } });
  assert.deepEqual(await hubMatches(untouched.fetcher, 'hi'), { ids: [], text: '' });
  assert.equal(untouched.calls.length, 0);
});

test('assets already listed are not offered to the model twice', async () => {
  const { fetcher } = recordingFetch({
    ok: true,
    data: {
      results: [
        { type: 'Gene', asset_id: 'sha256:abc', summary: 'Retry the upload with backoff.' },
        { type: 'Gene', asset_id: 'sha256:new', summary: 'Chunk the upload.' },
      ],
    },
  });
  const listedIds = new Set(['sha256:abc']);

  const { ids, text } = await hubMatches(fetcher, 'add a retry to the uploader', { listedIds });
  assert.deepEqual(ids, ['sha256:new']);
  assert.match(text, /1 reusable asset matches/);
  assert.doesNotMatch(text, /sha256:abc/);

  listedIds.add('sha256:new');
  assert.deepEqual(await hubMatches(fetcher, 'add a retry to the uploader', { listedIds }), { ids: [], text: '' });
});
