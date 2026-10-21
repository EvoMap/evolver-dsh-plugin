import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRecallJudge } from '../src/recall-judge.js';

function gateway(answer) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, headers: init.headers, body });
    const reply = typeof answer === 'function' ? answer(body) : answer;
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'number') return { ok: false, status: reply, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: reply } }] }) };
  };
  return { fetchImpl, requests };
}

const ASSET = {
  asset_id: 'sha256:a',
  short_title: 'Reconcile a ledger',
  payload: { summary: 's'.repeat(900), category: 'finance', signals_match: ['ledger', 'bank export'] },
};

test('no gateway key means no judge', () => {
  assert.equal(createRecallJudge({ apiKey: '' }), null);
});

test('the rewrite sends the bounded task to gemini-3.5-flash and returns the bare query', async () => {
  const { fetchImpl, requests } = gateway('  "reconcile ledger against bank export"\n');
  const judge = createRecallJudge({ apiKey: 'k', fetchImpl });

  assert.equal(await judge.searchQueryOf('t'.repeat(9_000)), 'reconcile ledger against bank export');
  assert.equal(requests[0].url, 'https://api.evomap.ai/v1/chat/completions');
  assert.equal(requests[0].headers.Authorization, 'Bearer k');
  assert.equal(requests[0].body.model, 'gemini-3.5-flash');
  const prompt = requests[0].body.messages[0].content;
  assert.match(prompt, /^Rewrite the task below into ONE search query/);
  assert.ok(prompt.endsWith(`## Task\n${'t'.repeat(6_000)}`));
});

test('an empty or failed rewrite throws, so the caller can fall back', async () => {
  await assert.rejects(createRecallJudge({ apiKey: 'k', fetchImpl: gateway('  ').fetchImpl }).searchQueryOf('task'), /empty/);
  await assert.rejects(createRecallJudge({ apiKey: 'k', fetchImpl: gateway(503).fetchImpl }).searchQueryOf('task'), /HTTP 503/);
});

test('each candidate is judged on its own card against the bounded task', async () => {
  const { fetchImpl, requests } = gateway((body) => (body.messages[0].content.includes('Title: keep') ? '{"use": true}' : '{"use": false}'));
  const judge = createRecallJudge({ apiKey: 'k', fetchImpl });
  const keep = { ...ASSET, asset_id: 'sha256:keep', short_title: 'keep' };

  const { usable, failed } = await judge.usableOf('t'.repeat(5_000), [ASSET, keep]);
  assert.deepEqual(usable.map((asset) => asset.asset_id), ['sha256:keep']);
  assert.equal(failed, 0);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].body.response_format, { type: 'json_object' });
  const prompt = requests[0].body.messages[0].content;
  assert.ok(prompt.includes(`## Task\n${'t'.repeat(4_000)}\n\n## Playbook`));
  assert.match(prompt, /^Title: Reconcile a ledger$/m);
  assert.match(prompt, new RegExp(`^Summary: ${'s'.repeat(600)}$`, 'm'));
  assert.match(prompt, /^Category: finance$/m);
  assert.match(prompt, /^Triggers: ledger; bank export$/m);
  assert.match(prompt, /Answer with JSON only: \{"use": true\|false\}$/);
});

test('a candidate whose verdict failed is not used; the review fails only when every verdict did', async () => {
  const mixed = gateway((body) => (body.messages[0].content.includes('Title: keep') ? '{"use": true}' : 'not json'));
  const { usable, failed } = await createRecallJudge({ apiKey: 'k', fetchImpl: mixed.fetchImpl })
    .usableOf('task', [ASSET, { ...ASSET, short_title: 'keep' }]);
  assert.deepEqual(usable.map((asset) => asset.short_title), ['keep']);
  assert.equal(failed, 1);

  await assert.rejects(createRecallJudge({ apiKey: 'k', fetchImpl: gateway(new Error('timeout')).fetchImpl }).usableOf('task', [ASSET]), /timeout/);
});

test('a recalled GEP body without a short title is judged by its local id and trigger', async () => {
  const { fetchImpl, requests } = gateway('{"use": true}');
  await createRecallJudge({ apiKey: 'k', fetchImpl }).usableOf('task', [{
    id: 'capsule_legal_writer', asset_id: 'sha256:c', type: 'Capsule', summary: 'Draft legal documents.', trigger: ['draft a contract', 'write a legal memo'],
  }]);
  const prompt = requests[0].body.messages[0].content;
  assert.match(prompt, /^Title: capsule_legal_writer$/m);
  assert.match(prompt, /^Summary: Draft legal documents\.$/m);
  assert.match(prompt, /^Triggers: draft a contract; write a legal memo$/m);
});

test('a busy or failing gateway is retried twice with backoff, a refusal is not', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  let calls = 0;
  const flaky = gateway(() => (++calls < 3 ? 429 : 'ledger reconciliation'));
  assert.equal(await createRecallJudge({ apiKey: 'k', fetchImpl: flaky.fetchImpl, sleep }).searchQueryOf('task'), 'ledger reconciliation');
  assert.deepEqual(waits, [1_000, 3_000]);

  const busy = gateway(503);
  await assert.rejects(createRecallJudge({ apiKey: 'k', fetchImpl: busy.fetchImpl, sleep }).searchQueryOf('task'), /HTTP 503/);
  assert.equal(busy.requests.length, 3);

  const refused = gateway(401);
  await assert.rejects(createRecallJudge({ apiKey: 'k', fetchImpl: refused.fetchImpl, sleep }).searchQueryOf('task'), /HTTP 401/);
  assert.equal(refused.requests.length, 1);
});
