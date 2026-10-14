import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { Config, apply } from '../src/index.js';
import {
  fakeAgent, fakeContext, freshHome, primedBy, projectDirectory, startProxy, untilCount, untilInjected, untilRequest,
} from './support/host.js';

const SESSION = JSON.parse(readFileSync(new URL('./fixtures/fair-play-session.json', import.meta.url), 'utf8'));
const STEPS = ['Reuse this.', 'Then the next step.', 'Then the next step.', 'Then the next step.'];

function assetFromInjection(strategyText) {
  const lines = strategyText.split('\n');
  return {
    asset_id: /for (sha256:[0-9a-f]+)\.$/.exec(lines.at(-1))[1],
    short_title: /^\[Evolution Memory\] (.*) \(EvoMap network\):$/.exec(lines[0])[1],
    strategy: lines.filter((line) => /^\d+\. /.test(line)).map((line) => line.replace(/^\d+\. /, '')),
  };
}

function hubAnswering({ assets, reuse = () => ({ recorded: true, eligible: true, counted: true, weight: 0.6 }) }) {
  return (path, body) => {
    if (path === '/asset/fetch') return { assets: assets(body.text) };
    if (path === '/asset/reuse-result') return reuse(body);
    return {};
  };
}

const oneAsset = (assetId, strategy = STEPS) => hubAnswering({ assets: () => [{ asset_id: assetId, strategy }] });
const reportsIn = (requests) => requests.filter((request) => request.path === '/asset/reuse-result').map((request) => request.body);

async function runTool(listeners, agent, { name, arguments: args, result, sideEffect }) {
  return listeners.get('tools/execute')({ name, agent, arguments: args }, async () => {
    sideEffect?.();
    return result;
  });
}

function answer(listeners, agent, turn, text) {
  listeners.get('session/event')(agent.session, {
    type: 'assistant/message',
    data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  });
}

function endTurn(listeners, agent, turn, kind = 'completed') {
  listeners.get('session/event')(agent.session, { type: 'turn/end', data: { turn, reason: { kind } } });
}

const bashResult = (text) => ({ isError: false, content: [{ type: 'text', text }] });

async function harness(t, prefix, answerOf) {
  t.after(freshHome(`${prefix}-home-`));
  const proxy = await startProxy(answerOf);
  t.after(() => proxy.close());
  const projectDir = projectDirectory(`${prefix}-`);
  const { ctx, listeners, registered } = fakeContext();
  apply(ctx, Config({ projectDir, proxyPort: proxy.port }));
  return { proxy, projectDir, listeners, registered };
}

test('a recorded dsh session reports each turn with the evidence it left', async (t) => {
  const byPrompt = new Map(SESSION.turns.map((turn) => [turn.prompt, assetFromInjection(turn.strategyText)]));
  const { proxy, listeners } = await harness(t, 'evolver-replay', hubAnswering({ assets: (text) => [byPrompt.get(text)] }));
  const { agent, injected } = fakeAgent({ sessionId: 'session-fair-play' });

  for (const turn of SESSION.turns) {
    const [strategy] = await primedBy(listeners, agent, turn.prompt, turn.turn);
    assert.equal(strategy.content[0].text.split('\n')[1], turn.strategyText.split('\n')[1]);
    for (const tool of turn.tools) await runTool(listeners, agent, tool);
    answer(listeners, agent, turn.turn, turn.answer);
    endTurn(listeners, agent, turn.turn, turn.reason.kind);
    await untilCount(proxy.requests, (request) => request.path === '/asset/reuse-result', turn.turn);
  }

  const [built, explained] = reportsIn(proxy.requests);
  assert.deepEqual(built, {
    asset_id: 'sha256:872ad8edfa0d86d74140e386528acc4aee7812c946b9e3200c4464468586d0ea',
    outcome: 'success',
    task_id: 'dsh:session-fair-play:1',
    reason: 'Injected by Evolver into dsh turn 1; applied: used; last test passed.',
    evidence: { tier: 'L1', applied: 'used', check: { kind: 'test', passed: true, fail_then_pass: false }, aborted: false, stage: 'immediate' },
  });
  assert.deepEqual(explained, {
    asset_id: 'sha256:ed3b8595561c58c86c0c630e1c77f698a8a5b3e0e5d1aabd6acce1a8fa3a3750',
    outcome: 'success',
    task_id: 'dsh:session-fair-play:2',
    reason: 'Injected by Evolver into dsh turn 2; applied: unknown; no check ran.',
    evidence: { tier: 'none', applied: 'partial', aborted: false, stage: 'immediate' },
  });
  assert.deepEqual(
    injected.map((message) => message.content[0].text),
    ['[Evolution Signal] Detected: [user_feature_request] in /home/dev/fair-play/README.md.'],
  );

  await primedBy(listeners, agent, '不对，我问的是推理小说里的意思', 3);
  await untilCount(proxy.requests, (request) => request.path === '/asset/reuse-result', 3);
  assert.deepEqual(reportsIn(proxy.requests)[2], {
    asset_id: 'sha256:ed3b8595561c58c86c0c630e1c77f698a8a5b3e0e5d1aabd6acce1a8fa3a3750',
    outcome: 'failed',
    task_id: 'dsh:session-fair-play:2:correction',
    reason: "The person's next prompt read as correction of the turn that reused this strategy.",
    evidence: { tier: 'L3', applied: 'partial', stage: 'correction' },
  });
});

test('the same check failing and then passing behind a different tail is a turnaround', async (t) => {
  const { proxy, listeners } = await harness(t, 'evolver-turnaround', oneAsset('sha256:lru', [
    'Use a Map for O(1) key lookups', 'Move the accessed node to the head on get', 'Evict the tail node when capacity is exceeded', 'Track hits for a stats method',
  ]));
  const { agent } = fakeAgent({ sessionId: 'session-turnaround' });
  await primedBy(listeners, agent, 'write an LRU cache with stats', 1);
  await runTool(listeners, agent, { name: 'write', arguments: { file_path: '/w/lru.js', content: 'const map = new Map(); // evict tail node, move node to head, stats hits' } });
  await runTool(listeners, agent, { name: 'bash', arguments: { command: 'cd /w && node --test 2>&1 | tail -25' }, result: bashResult('ℹ pass 3\nℹ fail 1\n✖ evicts the tail\n  AssertionError: expected 2 to equal 1') });
  await runTool(listeners, agent, { name: 'bash', arguments: { command: 'cd /w && node --test 2>&1 | tail -12' }, result: bashResult('ℹ tests 4\nℹ pass 4\nℹ fail 0') });
  endTurn(listeners, agent, 1);
  await untilRequest(proxy.requests, '/asset/reuse-result');

  const [report] = reportsIn(proxy.requests);
  assert.deepEqual(report.evidence.check, { kind: 'test', passed: true, fail_then_pass: true });
  assert.equal(report.evidence.tier, 'L1');
  assert.match(report.reason, /last test passed after failing earlier/);
});

test('an interrupted turn whose last check failed reports the failure and the abort', async (t) => {
  const { proxy, listeners } = await harness(t, 'evolver-aborted', oneAsset('sha256:aborted'));
  const { agent } = fakeAgent({ sessionId: 'session-aborted' });
  await primedBy(listeners, agent, 'add a retry to the uploader', 1);
  await runTool(listeners, agent, { name: 'bash', arguments: { command: 'npm test' }, result: { isError: true, content: [{ type: 'text', text: 'exit 1' }] } });
  endTurn(listeners, agent, 1, 'aborted');
  await untilRequest(proxy.requests, '/asset/reuse-result');

  const [report] = reportsIn(proxy.requests);
  assert.equal(report.outcome, 'failed');
  assert.deepEqual(report.evidence, {
    tier: 'L1', applied: 'unused', check: { kind: 'test', passed: false, fail_then_pass: false }, aborted: true, stage: 'immediate',
  });
});

test('a turn that did nothing the strategy names reports it unused', async (t) => {
  const { proxy, listeners } = await harness(t, 'evolver-unused', oneAsset('sha256:unused', [
    'Configure the Redis client with exponential reconnect backoff', 'Wrap the client in a singleton factory module', 'Close the connection in the global teardown hook', 'Assert reconnection inside the integration suite',
  ]));
  const { agent } = fakeAgent({ sessionId: 'session-unused' });
  await primedBy(listeners, agent, 'make the flaky redis tests stable', 1);
  await runTool(listeners, agent, { name: 'write', arguments: { file_path: '/w/greeting.js', content: 'export const greeting = "hello";\n' } });
  await runTool(listeners, agent, { name: 'bash', arguments: { command: 'npm test' }, result: bashResult('ℹ pass 1\nℹ fail 0') });
  endTurn(listeners, agent, 1);
  await untilRequest(proxy.requests, '/asset/reuse-result');

  assert.deepEqual(reportsIn(proxy.requests)[0].evidence, {
    tier: 'L1', applied: 'unused', check: { kind: 'test', passed: true, fail_then_pass: false }, aborted: false, stage: 'immediate',
  });
});

test('a follow-up prompt labels the turn once: approval, correction, or nothing', async (t) => {
  const { proxy, listeners } = await harness(t, 'evolver-follow-up', oneAsset('sha256:kept'));
  const { agent } = fakeAgent({ sessionId: 'session-follow-up' });
  const closeTurn = async (turn, prompt) => {
    await primedBy(listeners, agent, prompt, turn);
    endTurn(listeners, agent, turn);
  };

  await closeTurn(1, 'add a retry to the uploader');
  await untilCount(proxy.requests, (request) => request.path === '/asset/reuse-result', 1);
  await closeTurn(2, '好了，谢谢');
  await untilCount(proxy.requests, (request) => request.path === '/asset/reuse-result', 2);
  await closeTurn(3, '还是不行，报一样的错');
  await new Promise((resolve) => { setTimeout(resolve, 200); });

  const reports = reportsIn(proxy.requests);
  assert.deepEqual(reports.map((report) => [report.task_id, report.outcome, report.evidence.stage]), [
    ['dsh:session-follow-up:1', 'success', 'immediate'],
    ['dsh:session-follow-up:1:correction', 'success', 'correction'],
  ], 'turn 2 had no injection of its own, so the complaint after it revises nothing');
});

test('an ordinary next prompt sends no follow-up', async (t) => {
  const { proxy, listeners } = await harness(t, 'evolver-no-label', oneAsset('sha256:plain'));
  const { agent } = fakeAgent({ sessionId: 'session-no-label' });
  await primedBy(listeners, agent, 'add a retry to the uploader', 1);
  endTurn(listeners, agent, 1);
  await untilRequest(proxy.requests, '/asset/reuse-result');
  await primedBy(listeners, agent, '这样行不行？再帮我加一个功能', 2);
  await new Promise((resolve) => { setTimeout(resolve, 150); });
  assert.equal(reportsIn(proxy.requests).length, 1);
});

for (const [verdict, change, outcome] of [
  ['kept', () => {}, 'success'],
  ['reverted', (file) => rmSync(file), 'failed'],
]) {
  test(`edits the next session finds ${verdict} send a retention follow-up`, async (t) => {
    const { proxy, projectDir, listeners } = await harness(t, `evolver-retention-${verdict}`, oneAsset('sha256:retained'));
    const file = join(projectDir, 'uploader.js');
    const first = fakeAgent({ sessionId: `session-${verdict}-a`, cwd: projectDir }).agent;
    await primedBy(listeners, first, 'add a retry to the uploader', 1);
    await runTool(listeners, first, {
      name: 'write',
      arguments: { file_path: 'uploader.js', content: 'export const retry = 3;\n' },
      result: { isError: false, content: [] },
      sideEffect: () => writeFileSync(file, 'export const retry = 3;\n'),
    });
    endTurn(listeners, first, 1);
    await untilRequest(proxy.requests, '/asset/reuse-result');

    change(file);
    listeners.get('agent/session-start')({ agent: fakeAgent({ sessionId: 'session-elsewhere', cwd: projectDirectory('evolver-other-') }).agent, source: 'startup' });
    listeners.get('agent/session-start')({ agent: first, source: 'resume' });
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    assert.equal(reportsIn(proxy.requests).length, 1, 'only a different session in the same project judges retention');

    listeners.get('agent/session-start')({ agent: fakeAgent({ sessionId: `session-${verdict}-b`, cwd: projectDir }).agent, source: 'startup' });
    await untilCount(proxy.requests, (request) => request.path === '/asset/reuse-result', 2);
    assert.deepEqual(reportsIn(proxy.requests)[1], {
      asset_id: 'sha256:retained',
      outcome,
      task_id: `dsh:session-${verdict}-a:1:retention`,
      reason: `By the next session the files the turn edited were ${verdict}.`,
      evidence: { tier: 'L2', applied: 'unused', stage: 'retention' },
    });

    listeners.get('agent/session-start')({ agent: fakeAgent({ sessionId: `session-${verdict}-c`, cwd: projectDir }).agent, source: 'startup' });
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    assert.equal(reportsIn(proxy.requests).length, 2, 'retention is judged once');
  });
}

test('a report the Hub refuses is settled, shown in evolver_status and never resent', async (t) => {
  const refuse = () => ({ recorded: false, terminal: true, reason: 'invalid_evidence', status: 400 });
  const { proxy, listeners, registered } = await harness(t, 'evolver-refused', hubAnswering({ assets: () => [{ asset_id: 'sha256:refused', strategy: STEPS }], reuse: refuse }));
  const { agent } = fakeAgent({ sessionId: 'session-refused' });
  await primedBy(listeners, agent, 'add a retry to the uploader', 1);
  endTurn(listeners, agent, 1);
  await untilRequest(proxy.requests, '/asset/reuse-result');
  endTurn(listeners, agent, 2);
  await new Promise((resolve) => { setTimeout(resolve, 150); });
  assert.equal(reportsIn(proxy.requests).length, 1);

  const status = await registered.tools.find((tool) => tool.name === 'evolver_status').execute({}, {});
  assert.deepEqual(status.reuse_reports.rejected.map(({ task_id: taskId, reason, status: code }) => ({ taskId, reason, code })), [
    { taskId: 'dsh:session-refused:1', reason: 'invalid_evidence', code: 400 },
  ]);
  const outbox = JSON.parse(readFileSync(join(process.env.HOME, '.evolver', 'state', 'reports-outbox.json'), 'utf8'));
  assert.deepEqual(Object.values(outbox)[0].rejection, { reason: 'invalid_evidence', status: 400 });
});

test('a report the Hub could not take yet is resent at the next turn end and written locally once', async (t) => {
  let answers = 0;
  const { proxy, listeners, registered } = await harness(t, 'evolver-retried', hubAnswering({
    assets: () => [{ asset_id: 'sha256:retried', strategy: STEPS }],
    reuse: () => (answers++ === 0 ? { recorded: false, reason: 'hub 404' } : { recorded: true, eligible: true, counted: true, weight: 0.6 }),
  }));
  const { agent } = fakeAgent({ sessionId: 'session-retried' });
  await primedBy(listeners, agent, 'add a retry to the uploader', 1);
  await runTool(listeners, agent, { name: 'edit', arguments: { file_path: '/w/uploader.js', new_string: 'Reuse this. Then the next step.' } });
  await runTool(listeners, agent, { name: 'bash', arguments: { command: 'npm test' }, result: bashResult('ℹ pass 2\nℹ fail 0') });
  endTurn(listeners, agent, 1);
  await untilRequest(proxy.requests, '/asset/reuse-result');
  await new Promise((resolve) => { setTimeout(resolve, 150); });
  endTurn(listeners, agent, 2);
  await untilCount(proxy.requests, (request) => request.path === '/asset/reuse-result', 2);
  await new Promise((resolve) => { setTimeout(resolve, 150); });

  const [first, second] = reportsIn(proxy.requests);
  assert.deepEqual(second, first);
  const status = await registered.tools.find((tool) => tool.name === 'evolver_status').execute({}, {});
  assert.deepEqual(status.reuse_reports.delivered.map(({ eligible, counted, weight }) => ({ eligible, counted, weight })), [
    { eligible: true, counted: true, weight: 0.6 },
  ]);

  const log = join(process.env.HOME, '.evomap', 'evolution', 'root_events.jsonl');
  const events = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => [event.type, event.payload.assetId, event.payload.cycleId]), [
    ['value.reuse_hit', 'sha256:retried', 'dsh:session-retried'],
  ]);
});

test('a report with no evidence never reaches the local ledger', async (t) => {
  const { proxy, listeners } = await harness(t, 'evolver-exposure', oneAsset('sha256:exposure'));
  const { agent } = fakeAgent({ sessionId: 'session-exposure' });
  await primedBy(listeners, agent, 'add a retry to the uploader', 1);
  endTurn(listeners, agent, 1);
  await untilRequest(proxy.requests, '/asset/reuse-result');
  await new Promise((resolve) => { setTimeout(resolve, 150); });
  assert.equal(existsSync(join(process.env.HOME, '.evomap', 'evolution', 'root_events.jsonl')), false);
});

test("the model's own report carries L5 evidence, passes the Hub verdict through, and leaves the automatic one in place", async (t) => {
  const { proxy, listeners, registered } = await harness(t, 'evolver-self-report', hubAnswering({
    assets: () => [{ asset_id: 'sha256:owned', strategy: STEPS }],
    reuse: (body) => ({ recorded: true, eligible: true, counted: body.evidence.tier !== 'L5', weight: body.evidence.tier === 'L5' ? 0.1 : 0 }),
  }));
  const { agent } = fakeAgent({ sessionId: 'session-owned' });
  await primedBy(listeners, agent, 'add a retry to the uploader', 1);

  const tool = registered.tools.find((candidate) => candidate.name === 'evolver_asset_reuse_result');
  const receipt = await tool.execute({ asset_id: 'sha256:owned', outcome: 'mismatched', reason: 'not a fit' }, {});
  assert.deepEqual(receipt, { recorded: true, eligible: true, counted: false, weight: 0.1 });
  endTurn(listeners, agent, 1);
  await untilCount(proxy.requests, (request) => request.path === '/asset/reuse-result', 2);

  const [own, automatic] = reportsIn(proxy.requests);
  assert.deepEqual(own.evidence, { tier: 'L5', applied: 'unused', stage: 'immediate' });
  assert.equal(automatic.task_id, 'dsh:session-owned:1');
  assert.equal(automatic.evidence.tier, 'none');
});

test('an injected asset is reported from disk after the process that injected it is gone', async (t) => {
  const { proxy, projectDir, listeners } = await harness(t, 'evolver-durable', oneAsset('sha256:durable'));
  const { agent } = fakeAgent({ sessionId: 'session-durable', cwd: projectDir });
  await primedBy(listeners, agent, 'add a retry to the uploader', 1);

  const restarted = fakeContext();
  apply(restarted.ctx, Config({ projectDir, proxyPort: proxy.port }));
  restarted.listeners.get('session/event')(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await untilRequest(proxy.requests, '/asset/reuse-result');
  assert.equal(reportsIn(proxy.requests)[0].asset_id, 'sha256:durable');
});

test('a strategy that lands after its turn ended is reported with the turn that saw it', async (t) => {
  t.after(freshHome('evolver-late-home-'));
  const proxy = await startProxy(oneAsset('sha256:late'), { delayMs: (path) => (path === '/asset/fetch' ? 150 : 0) });
  t.after(() => proxy.close());
  const { ctx, listeners } = fakeContext();
  apply(ctx, Config({ projectDir: projectDirectory('evolver-late-'), proxyPort: proxy.port, assetPrimeWaitMs: 20 }));
  const { agent, injected } = fakeAgent({ sessionId: 'session-late' });

  assert.deepEqual(await primedBy(listeners, agent, 'add a retry to the uploader', 1), []);
  endTurn(listeners, agent, 1);
  await untilInjected(injected, 1);
  await new Promise((resolve) => { setTimeout(resolve, 100); });
  assert.deepEqual(reportsIn(proxy.requests), []);

  endTurn(listeners, agent, 2);
  await untilRequest(proxy.requests, '/asset/reuse-result');
  assert.equal(reportsIn(proxy.requests)[0].task_id, 'dsh:session-late:2');
});

test('subagent turns and synthesized turn ends report nothing', async (t) => {
  const { proxy, listeners } = await harness(t, 'evolver-subagent', oneAsset('sha256:child'));
  const child = { id: 'session-child', header: { origin: 'subagent' } };
  const { agent } = fakeAgent({ sessionId: 'session-parent' });
  await primedBy(listeners, { ...agent, session: child }, 'add a retry to the uploader', 1);
  await primedBy(listeners, agent, 'add a retry to the uploader', 1);
  listeners.get('session/event')(child, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  endTurn(listeners, agent, 1, 'interrupted');
  await new Promise((resolve) => { setTimeout(resolve, 150); });
  assert.deepEqual(reportsIn(proxy.requests), []);
});
