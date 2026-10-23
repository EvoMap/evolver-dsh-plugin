import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rewrittenQueryOf } from '../src/recall-query.js';

function stubLlm(chunks) {
  const calls = [];
  const llm = {
    async *stream(options) {
      calls.push(options);
      yield* chunks;
    },
  };
  return { llm, calls };
}

const ROUTE = { provider: 'session-provider', model: 'session-model' };

test('the rewrite runs on the session\'s own provider and model and returns the bare query', async () => {
  const { llm, calls } = stubLlm([
    { type: 'reasoning-delta', index: 0, text: 'thinking' },
    { type: 'text-delta', index: 1, text: '  "reconcile ledger ' },
    { type: 'text-delta', index: 1, text: 'against bank export"\n' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);

  assert.equal(await rewrittenQueryOf(llm, ROUTE, 't'.repeat(9_000)), 'reconcile ledger against bank export');
  assert.equal(calls[0].provider, 'session-provider');
  assert.equal(calls[0].model, 'session-model');
  const prompt = calls[0].messages[0].content[0].text;
  assert.match(prompt, /^Rewrite the task below into ONE search query/);
  assert.ok(prompt.endsWith(`## Task\n${'t'.repeat(6_000)}`));
});

test('a task with dollar signs is placed into the prompt verbatim', async () => {
  const { llm, calls } = stubLlm([{ type: 'text-delta', index: 0, text: 'q' }, { type: 'finish', reason: { kind: 'stop' } }]);
  await rewrittenQueryOf(llm, ROUTE, 'cost is $& and $1');
  assert.ok(calls[0].messages[0].content[0].text.endsWith('## Task\ncost is $& and $1'));
});

test('a failed or empty rewrite throws, so the caller can fall back to the prompt prefix', async () => {
  const failed = stubLlm([{ type: 'finish', reason: { kind: 'error', failure: { message: 'provider returned 503', code: 'http' } } }]);
  await assert.rejects(rewrittenQueryOf(failed.llm, ROUTE, 'task'), /provider returned 503/);

  const empty = stubLlm([{ type: 'text-delta', index: 0, text: '  ""  ' }, { type: 'finish', reason: { kind: 'stop' } }]);
  await assert.rejects(rewrittenQueryOf(empty.llm, ROUTE, 'task'), /came back empty/);
});
