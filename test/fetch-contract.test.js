import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { evolverTools } from '../src/tools.js';

// Captured verbatim from a running Evolver Proxy (@evomap/evolver 2.0.18) —
// POST /asset/fetch, one hit and one miss, only the node id redacted. The
// renderer is what the model sees, so it is pinned to the real wire shape
// rather than to a hand-written envelope.
const PROXY_RESPONSE = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/asset-fetch.proxy.json', import.meta.url)), 'utf8'),
);

function renderFetch(envelope) {
  const tool = evolverTools(async () => ({ ok: true, data: envelope })).find(
    (candidate) => candidate.name === 'evolver_fetch_asset',
  );
  return tool.output.render({}, envelope)[0].text;
}

test('the Proxy returns assets and missing at the top level', () => {
  assert.ok(Array.isArray(PROXY_RESPONSE.assets));
  assert.ok(Array.isArray(PROXY_RESPONSE.missing));
  const [asset] = PROXY_RESPONSE.assets;
  assert.equal(typeof asset.asset_id, 'string');
  assert.ok(Array.isArray(asset.strategy));
  assert.ok(Array.isArray(asset.validation));
});

test('a real Proxy response renders as the part worth reusing', () => {
  const text = renderFetch(PROXY_RESPONSE);
  const [asset] = PROXY_RESPONSE.assets;

  assert.match(text, new RegExp(`## Gene ${asset.asset_id}`));
  assert.match(text, /Refactor error logging/);
  assert.match(text, new RegExp(`1\\. ${asset.strategy[0].slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(text, /Validation — run these to confirm/);
  assert.match(text, /npx vitest run/);
  assert.match(text, /Not retrievable: sha256:gone/);
  assert.doesNotMatch(text, /signals_match|source_node_id|gdi_score/);
  assert.doesNotMatch(text, /No assets returned/);
});

test('an empty result says so instead of rendering nothing', () => {
  assert.match(renderFetch({ assets: [], missing: [], query: {} }), /No assets returned/);
});
