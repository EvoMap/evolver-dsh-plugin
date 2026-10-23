import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Config, apply } from '../src/index.js';
import {
  argumentsOf, candidateOf, distillCandidate, distillPrompt, rememberCandidate, skipReason, takeCandidates,
} from '../src/session-distill.js';
import { fakeAgent, fakeContext, freshHome, primedBy, projectDirectory, startProxy, untilCount, untilRequest } from './support/host.js';

const MODEL = { provider: 'gateway', model: 'deepseek-flash' };
const GENE = { title: 'Retry uploads', summary: 'Retry a flaky upload with backoff.', strategy: '1. Measure. 2. Back off.', signals: ['retry'] };

function record(overrides = {}) {
  return { checks: [], commands: ['npm test'], paths: ['src/up.js'], edits: [], answer: 'Done: retries added.', ...overrides };
}

function fakeLlm(answer = JSON.stringify(GENE), calls = []) {
  return {
    calls,
    async *stream(request) {
      calls.push(request);
      yield { type: 'text-delta', text: answer };
      yield { type: 'usage', usage: { inputTokens: 900, outputTokens: 120 } };
    },
  };
}

function session(id) {
  return { id, header: {}, deriveMessages: () => [{ role: 'assistant', source: MODEL }] };
}

test('only a verified, completed turn that used tools and reused no strategy becomes a candidate', () => {
  assert.equal(skipReason('completed', record()), null);
  assert.equal(skipReason('aborted', record()), 'not_completed');
  assert.equal(skipReason('completed', record({ answer: '' })), 'no_answer');
  assert.equal(skipReason('completed', record({ checks: [{ command: 'npm test', failed: true }] })), 'failed_check');
  assert.equal(skipReason('completed', record({ commands: [] })), 'no_tool_use');
  assert.equal(skipReason('completed', record(), { reusedAsset: true }), 'asset_reused');
});

test('the prompt is a digest of the turn, never its whole history, and asks for no answer values', () => {
  const candidate = candidateOf({ prompt: 'add a retry to the uploader', record: record({ checks: [{ command: 'npm test', failed: false }] }), model: MODEL, turn: 1 });
  const prompt = distillPrompt(candidate, 'the backoff');
  assert.match(prompt, /## Task\nadd a retry to the uploader/);
  assert.match(prompt, /- npm test/);
  assert.match(prompt, /- passed: npm test/);
  assert.match(prompt, /Focus on: the backoff/);
  assert.match(prompt, /Do not include the answer itself/);
});

test('a list the model wrote as one numbered paragraph becomes steps', () => {
  assert.deepEqual(argumentsOf(JSON.stringify(GENE)).strategy, ['Measure.', 'Back off.']);
  assert.equal(argumentsOf('no json here'), null);
  assert.equal(argumentsOf('{"title":"no summary"}'), null);
});

test('a candidate is distilled through the host model and sent to the Proxy with its own cost', async () => {
  const sent = [];
  const proxyFetch = async (method, path, body) => { sent.push({ path, body }); return { ok: true, data: { id: 'gene_x' } }; };
  const candidate = candidateOf({ prompt: 'add a retry', record: record(), model: MODEL, turn: 1 });
  const llm = fakeLlm();
  const outcome = await distillCandidate({ proxyFetch, llm, candidate, timeoutMs: 1_000 });

  assert.equal(outcome.status, 'sent');
  assert.deepEqual(llm.calls[0].provider, 'gateway');
  assert.equal(sent[0].path, '/conversation/distill');
  assert.equal(sent[0].body.trigger, 'session_end');
  assert.equal(sent[0].body.persist, true);
  assert.equal(sent[0].body.publish, false);
  assert.deepEqual(sent[0].body.distill_usage, { inputTokens: 900, outputTokens: 120 });
  assert.equal((await distillCandidate({ proxyFetch, llm, candidate: { ...candidate, model: null }, timeoutMs: 1_000 })).status, 'no_model');
});

test("a session's candidate is taken once; another session's only once it has gone stale", (t) => {
  t.after(freshHome('evolver-candidates-'));
  rememberCandidate('live', { at: 1_000 });
  rememberCandidate('killed', { at: 0 });
  assert.deepEqual(takeCandidates({ sessionId: null, staleMs: 5_000, now: 2_000 }), []);
  assert.deepEqual(takeCandidates({ sessionId: 'live', staleMs: Infinity, now: 2_000 }).map((due) => due.sessionId), ['live']);
  assert.deepEqual(takeCandidates({ sessionId: 'live', staleMs: Infinity, now: 2_000 }), []);
  assert.deepEqual(takeCandidates({ sessionId: null, staleMs: 5_000, now: 10_000 }).map((due) => due.sessionId), ['killed']);
});

async function harness(t, prefix, answerOf) {
  t.after(freshHome(`${prefix}-home-`));
  const proxy = await startProxy(answerOf);
  t.after(() => proxy.close());
  const { ctx, listeners } = fakeContext();
  ctx.llm = fakeLlm();
  apply(ctx, Config({ projectDir: projectDirectory(`${prefix}-`), proxyPort: proxy.port }));
  return { proxy, listeners, llm: ctx.llm };
}

const proxyAnswer = (assets = []) => (path) => (path === '/asset/fetch' ? { assets } : { recorded: true });

async function verifiedTurn(listeners, agent, turn = 1) {
  await primedBy(listeners, agent, 'add a retry to the uploader', turn);
  await listeners.get('tools/execute')({ name: 'bash', agent, arguments: { command: 'npm test' } }, async () => ({ isError: false, content: [{ type: 'text', text: 'ℹ pass 2\nℹ fail 0' }] }));
  listeners.get('session/event')(agent.session, { type: 'assistant/message', data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Retries added.' }] } } });
  listeners.get('session/event')(agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
}

test('a verified turn is distilled once, when the session ends, outside the conversation', async (t) => {
  const { proxy, listeners, llm } = await harness(t, 'evolver-session-end', proxyAnswer());
  const agent = { ...fakeAgent({ sessionId: 'session-end' }).agent, session: session('session-end') };

  await verifiedTurn(listeners, agent, 1);
  assert.equal(llm.calls.length, 0, 'nothing runs at turn end');
  await listeners.get('session/flush')(agent.session);
  await untilRequest(proxy.requests, '/conversation/distill');
  await listeners.get('session/flush')(agent.session);

  assert.equal(llm.calls.length, 1);
  assert.equal(proxy.requests.filter((request) => request.path === '/conversation/distill').length, 1);
});

test('a turn the next prompt corrects is not distilled', async (t) => {
  const { proxy, listeners, llm } = await harness(t, 'evolver-corrected', proxyAnswer());
  const agent = { ...fakeAgent({ sessionId: 'session-corrected' }).agent, session: session('session-corrected') };

  await verifiedTurn(listeners, agent, 1);
  await primedBy(listeners, agent, '不对，这样不行', 2);
  await listeners.get('session/flush')(agent.session);

  assert.equal(llm.calls.length, 0);
  assert.equal(proxy.requests.filter((request) => request.path === '/conversation/distill').length, 0);
});

test('a strategy whose turn never ended is reported failed when the session goes away', async (t) => {
  const { proxy, listeners } = await harness(t, 'evolver-disposed', proxyAnswer([{ asset_id: 'sha256:cut', strategy: ['a.', 'b.', 'c.', 'd.'] }]));
  const agent = { ...fakeAgent({ sessionId: 'session-cut' }).agent, session: session('session-cut') };

  await primedBy(listeners, agent, 'add a retry to the uploader', 1);
  listeners.get('session/disposed')(agent.session);
  await untilCount(proxy.requests, (request) => request.path === '/asset/reuse-result', 1);

  const [report] = proxy.requests.filter((request) => request.path === '/asset/reuse-result').map((request) => request.body);
  assert.equal(report.asset_id, 'sha256:cut');
  assert.equal(report.outcome, 'failed');
  assert.equal(report.task_id, 'dsh:session-cut:1');
  assert.equal(report.evidence.aborted, true);
});

test("the next session reports a killed session's open strategies and distills its leftover candidate", async (t) => {
  const { proxy, listeners, llm } = await harness(t, 'evolver-killed', proxyAnswer());
  const { rememberInjected } = await import('../src/injected-assets.js');
  const { statePath } = await import('../src/state-file.js');
  const { readdirSync, utimesSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const old = (Date.now() - 3 * 60 * 60 * 1000) / 1000;

  rememberInjected('session-killed', 'sha256:orphan', { turn: 4, strategyText: '1. a.' });
  const dir = dirname(statePath('x'));
  for (const file of readdirSync(dir).filter((name) => name.startsWith('injected-'))) utimesSync(join(dir, file), old, old);
  rememberCandidate('session-killed', { ...candidateOf({ prompt: 'p', record: record(), model: MODEL, turn: 4 }), at: Date.now() - 3 * 60 * 60 * 1000 });

  const agent = { ...fakeAgent({ sessionId: 'session-next' }).agent, session: session('session-next') };
  listeners.get('agent/session-start')({ agent });
  await untilRequest(proxy.requests, '/asset/reuse-result');
  await untilRequest(proxy.requests, '/conversation/distill');

  const [report] = proxy.requests.filter((request) => request.path === '/asset/reuse-result').map((request) => request.body);
  assert.equal(report.asset_id, 'sha256:orphan');
  assert.equal(report.task_id, 'dsh:session-killed:4');
  assert.equal(report.outcome, 'failed');
  assert.equal(llm.calls.length, 1);
});
