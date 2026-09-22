import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { after, test } from 'node:test';

import { outcomeOfReason } from '../src/capture.js';
import { Config, apply, inject, name } from '../src/index.js';

const missingClaimFile = join(mkdtempSync(join(tmpdir(), 'evolver-claim-')), 'missing');
process.env.EVOLVER_CLAIM_URL_PATH = missingClaimFile;
const sharedStateDir = mkdtempSync(join(tmpdir(), 'evolver-notice-state-'));
process.env.EVOLVER_SESSION_STATE_DIR = sharedStateDir;
after(() => {
  delete process.env.EVOLVER_CLAIM_URL_PATH;
  delete process.env.EVOLVER_SESSION_STATE_DIR;
});

function fakeContext() {
  const registered = { tools: [], skills: [], commands: [] };
  const listeners = new Map();
  const ctx = {
    tools: { register: (definition) => registered.tools.push(definition) },
    skills: { registerProvider: (create) => registered.skills.push(create({})) },
    commands: { register: (definition) => registered.commands.push(definition) },
    on: (event, listener) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    inject: (_deps, callback) => callback(ctx),
  };
  return { ctx, registered, listeners };
}

function fakeAgent({ id = 'agent-test', sessionId = id, cwd } = {}) {
  const injected = [];
  const session = { id: sessionId, header: cwd ? { cwd } : {} };
  return {
    agent: { id, session, inject: (message) => injected.push(message), followup: () => {} },
    injected,
  };
}

function userMessage(text) {
  return { content: [{ type: 'text', text }], source: { kind: 'user' } };
}

async function primedBy(listeners, agent, prompt = 'add a retry to the uploader', turn = 1, step = 1) {
  const claimed = [userMessage(prompt)];
  const decision = await listeners.get('agent/pre-step')(
    { agent, messages: claimed, turn, step, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: claimed }),
  );
  assert.equal(decision.messages[0], claimed[0]);
  return decision.messages.slice(1);
}

async function untilRequest(requests, path, deadlineMs = 2_000) {
  const start = Date.now();
  while (!requests.some((request) => request.path === path)) {
    if (Date.now() - start > deadlineMs) throw new Error(`no ${path} request arrived`);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  return requests;
}

async function untilInjected(injected, count, deadlineMs = 2_000) {
  const start = Date.now();
  while (injected.length < count) {
    if (Date.now() - start > deadlineMs) throw new Error(`only ${injected.length} of ${count} messages were injected`);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  return injected;
}

function gitDirectory(prefix = 'evolver-') {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  return directory;
}

test('plugin metadata matches the Cordis v4 contract', () => {
  assert.equal(name, 'evolver');
  assert.deepEqual(inject, ['tools']);
});

test('configuration applies defaults and rejects invalid values', () => {
  const configured = Config({});
  assert.deepEqual(configured.editToolNames, ['write', 'edit', 'str_replace_editor']);
  assert.equal(configured.proxyTimeoutMs, 8_000);
  assert.equal(configured.claimNudgeEnabled, false);
  assert.equal(configured.assetPrimeEnabled, true);
  assert.equal(configured.assetPrimeWaitMs, 6_000);
  assert.ok(
    configured.assetPrimeWaitMs < configured.assetPrimeTimeoutMs,
    'a step must give up waiting before the Proxy call it is waiting on does',
  );
  assert.ok(configured.captureLockWaitMs > configured.captureLockStaleMs);
  assert.throws(() => Config({ proxyPort: 70_000 }), /proxyPort/);
  assert.throws(() => Config({ editToolNames: 'write' }), /editToolNames/);
  assert.throws(
    () => apply(fakeContext().ctx, Config({ captureLockStaleMs: 100, captureLockWaitMs: 100 })),
    /captureLockWaitMs/,
  );
  assert.throws(() => apply(fakeContext().ctx, { projectDir: join(tmpdir(), 'definitely-missing-evolver-dir') }), /not a directory/);
});

test('apply registers every surface and lifecycle listener', () => {
  const { ctx, registered, listeners } = fakeContext();
  apply(ctx, { projectDir: mkdtempSync(join(tmpdir(), 'evolver-')) });

  assert.deepEqual(
    registered.tools.map((tool) => tool.name).sort(),
    [
      'evolver_ack',
      'evolver_asset_reuse_result',
      'evolver_distill_conversation',
      'evolver_fetch_asset',
      'evolver_poll',
      'evolver_publish_asset',
      'evolver_search_assets',
      'evolver_status',
    ],
  );
  assert.equal(registered.skills.length, 1);
  assert.equal(registered.skills[0].name, 'evolver');
  assert.deepEqual(
    registered.commands.map((command) => command.name),
    [
      'evolver-distill',
      'evolver-evolve',
      'evolver-review',
      'evolver-run',
      'evolver-search',
      'evolver-solidify',
      'evolver-status',
      'evolver-sync',
    ],
  );
  assert.ok(registered.commands.every((command) => command.description.length > 0));
  assert.deepEqual([...listeners.keys()].sort(), [
    'agent/pre-step',
    'session/disposed',
    'session/event',
    'session/flush',
    'tools/result',
  ]);
});

test('command invocation preserves arguments without Claude placeholders', () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { projectDir: mkdtempSync(join(tmpdir(), 'evolver-')) });
  const messages = [];
  const command = registered.commands.find((candidate) => candidate.name === 'evolver-run');

  command.handler({ agent: { followup: (message) => messages.push(message) }, rawInput: ' --dry-run ' });
  const text = messages[0].content[0].text;
  assert.match(text, /Invocation arguments \(verbatim JSON string\): "--dry-run"/);
  assert.doesNotMatch(text, /\$ARGUMENTS|\/evolver:/);
  assert.match(command.input.hint, /--dry-run/);
});

test('every turn looks the Hub up with its own prompt, without repeating assets', async () => {
  const projectDir = gitDirectory('evolver-prime-');
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body);
      requests.push({ path: request.url, body: parsed });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(request.url === '/asset/search'
        ? {
          results: [
            { asset_type: 'Gene', asset_id: 'sha256:abc', has_strategy: true },
            { asset_type: 'Gene', asset_id: 'sha256:def', has_strategy: true },
          ],
        }
        : {
          assets: parsed.asset_ids.map((id) => ({
            asset_id: id,
            strategy: [id === 'sha256:abc' ? 'Retry with backoff.' : 'Chunk the download.'],
          })),
        }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), 'evolver-prime-home-'));

  try {
    const { ctx, listeners } = fakeContext();
    apply(ctx, Config({ projectDir, proxyPort: server.address().port }));
    const { agent } = fakeAgent({ cwd: projectDir });
    const first = await primedBy(listeners, agent, 'add a retry to the uploader', 1);
    const sameTurn = await primedBy(listeners, agent, 'add a retry to the uploader', 1, 2);
    const second = await primedBy(listeners, agent, 'now make the download resumable', 2);

    assert.deepEqual(
      requests.map((request) => request.path),
      ['/asset/search', '/asset/fetch', '/asset/search', '/asset/fetch'],
    );
    assert.equal(requests[0].body.text, 'add a retry to the uploader');
    assert.equal(requests[2].body.text, 'now make the download resumable');
    assert.match(first.at(-1).content[0].text, /Strategy reused from Gene sha256:abc/);
    assert.match(first.at(-1).content[0].text, /^1\. Retry with backoff\.$/m);
    assert.deepEqual(sameTurn, []);
    assert.equal(second.length, 1);
    assert.match(second[0].content[0].text, /sha256:def/);
    assert.match(second[0].content[0].text, /^1\. Chunk the download\.$/m);
    assert.doesNotMatch(second[0].content[0].text, /sha256:abc/);
  } finally {
    process.env.HOME = home;
    server.close();
  }
});

test('claim guidance is opt-in', async () => {
  const projectDir = gitDirectory('evolver-claim-opt-in-');
  const claimDir = mkdtempSync(join(tmpdir(), 'evolver-claim-enabled-'));
  const claimPath = join(claimDir, 'claim_url');
  const stateDir = mkdtempSync(join(tmpdir(), 'evolver-claim-state-'));
  writeFileSync(claimPath, 'https://evomap.ai/claim/node?token=test\n');
  process.env.EVOLVER_CLAIM_URL_PATH = claimPath;
  process.env.EVOLVER_SESSION_STATE_DIR = stateDir;

  try {
    const { ctx, listeners } = fakeContext();
    apply(ctx, Config({ projectDir, claimNudgeEnabled: true, assetPrimeEnabled: false }));
    const { agent } = fakeAgent({ cwd: projectDir });
    const primed = await primedBy(listeners, agent);
    assert.equal(primed.length, 1);
    assert.match(primed[0].content[0].text, /https:\/\/evomap\.ai\/claim/);
  } finally {
    process.env.EVOLVER_CLAIM_URL_PATH = missingClaimFile;
    process.env.EVOLVER_SESSION_STATE_DIR = sharedStateDir;
  }
});

test('a search slower than the wait budget injects itself instead of holding the step', async () => {
  const projectDir = gitDirectory('evolver-slow-prime-');
  const server = createServer((request, response) => {
    request.on('data', () => {});
    request.on('end', () => {
      const body = request.url === '/asset/search'
        ? { results: [{ asset_type: 'Gene', asset_id: 'sha256:slow', has_strategy: true }] }
        : { assets: [{ asset_id: 'sha256:slow', strategy: ['Arrived late.'] }] };
      setTimeout(() => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(body));
      }, 150);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), 'evolver-slow-home-'));

  try {
    const { ctx, listeners } = fakeContext();
    apply(ctx, Config({ projectDir, proxyPort: server.address().port, assetPrimeWaitMs: 20 }));
    const { agent, injected } = fakeAgent({ cwd: projectDir });
    const started = Date.now();
    const primed = await primedBy(listeners, agent);

    assert.ok(Date.now() - started < 120, 'the step waited for the slow search');
    assert.deepEqual(primed, []);
    await untilInjected(injected, 1);
    assert.match(injected[0].content[0].text, /Strategy reused from Gene sha256:slow/);
    assert.match(injected[0].content[0].text, /^1\. Arrived late\.$/m);
  } finally {
    process.env.HOME = home;
    server.close();
  }
});

test('the non-git notice is repeated per directory, not per session', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'evolver-nongit-state-'));
  process.env.EVOLVER_SESSION_STATE_DIR = stateDir;
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'evolver-nongit-once-')));
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'evolver-nongit-other-')));

  try {
    const { ctx, listeners } = fakeContext();
    apply(ctx, Config({ projectDir, assetPrimeEnabled: false }));

    const first = await primedBy(listeners, fakeAgent({ id: 'a', cwd: projectDir }).agent);
    const second = await primedBy(listeners, fakeAgent({ id: 'b', cwd: projectDir }).agent);
    const other = await primedBy(listeners, fakeAgent({ id: 'c', cwd: elsewhere }).agent);

    assert.match(first[0].content[0].text, /not a git repository/);
    assert.deepEqual(second, []);
    assert.match(other[0].content[0].text, /not a git repository/);
  } finally {
    process.env.EVOLVER_SESSION_STATE_DIR = sharedStateDir;
  }
});

test('a non-git session receives only the inactive notice', async () => {
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'evolver-nongit-')));
  const graph = join(projectDir, 'graph.jsonl');
  writeFileSync(
    graph,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      signals: ['perf_bottleneck'],
      outcome: { status: 'success', score: 0.9, note: 'foreign memory' },
      cwd: projectDir,
    })}\n`,
  );
  process.env.MEMORY_GRAPH_PATH = graph;

  const { ctx, listeners } = fakeContext();
  apply(ctx, Config({ projectDir, assetPrimeEnabled: false }));
  const { agent } = fakeAgent({ cwd: projectDir });
  const primed = await primedBy(listeners, agent);

  delete process.env.MEMORY_GRAPH_PATH;
  assert.equal(primed.length, 1);
  assert.match(primed[0].content[0].text, /not a git repository/);
  assert.doesNotMatch(primed[0].content[0].text, /foreign memory/);
  assert.equal(existsSync(join(projectDir, '.evolver', 'workspace-id')), false);
});

test('an edit carrying a signal nudges the agent once', () => {
  const { ctx, listeners } = fakeContext();
  apply(ctx, { projectDir: mkdtempSync(join(tmpdir(), 'evolver-')) });
  const { agent, injected } = fakeAgent();

  const onResult = listeners.get('tools/result');
  onResult({ name: 'write', agent, arguments: { path: '/a.ts', content: 'the deploy failed again' } }, { isError: false });
  onResult({ name: 'write', agent, arguments: { path: '/a.ts', content: 'the deploy failed again' } }, { isError: false });
  onResult({ name: 'write', agent, arguments: { path: '/b.ts', content: 'all good' } }, { isError: false });
  onResult({ name: 'read', agent, arguments: { path: '/c.ts', content: 'the deploy failed' } }, { isError: false });
  onResult({ name: 'write', agent, arguments: { path: '/d.ts', content: 'the deploy failed' } }, { isError: true });

  assert.equal(injected.length, 1);
  assert.match(injected[0].content[0].text, /deployment_issue.*\/a\.ts/);
  assert.equal(injected[0].source.form, 'notice');
  assert.ok(injected[0].source.summary.length > 0 && injected[0].source.summary.length <= 120);
});

test('edit signals and turn capture share the session key seam', async () => {
  const projectDir = gitDirectory('evolver-signal-session-');
  writeFileSync(join(projectDir, 'app.js'), 'export const deploy = "failed";\n');
  const graph = join(mkdtempSync(join(tmpdir(), 'evolver-signal-graph-')), 'graph.jsonl');
  process.env.MEMORY_GRAPH_PATH = graph;

  const { ctx, listeners } = fakeContext();
  apply(ctx, Config({ projectDir }));
  const { agent } = fakeAgent({ id: 'agent-fixture-id', sessionId: 'session-shared', cwd: projectDir });
  listeners.get('tools/result')(
    { name: 'write', agent, arguments: { path: join(projectDir, 'app.js'), content: 'the deploy failed' } },
    { isError: false },
  );
  listeners.get('session/event')(agent.session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
  });
  await listeners.get('session/flush')(agent.session);

  delete process.env.MEMORY_GRAPH_PATH;
  const [recorded] = readFileSync(graph, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(recorded.session_id, 'session-shared');
  assert.ok(recorded.signals.includes('deployment_issue'));
});

test('an injected strategy is reported back when the turn ends', async () => {
  const projectDir = gitDirectory('evolver-reuse-');
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body);
      requests.push({ path: request.url, body: parsed });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(
        request.url === '/asset/search'
          ? { results: [{ asset_type: 'Gene', asset_id: 'sha256:used', has_strategy: true, similarity: 0.9 }] }
          : request.url === '/asset/fetch'
            ? { assets: [{ asset_id: 'sha256:used', strategy: ['Reuse this.'] }] }
            : { ok: true },
      ));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), 'evolver-reuse-home-'));

  try {
    const { ctx, listeners } = fakeContext();
    apply(ctx, Config({ projectDir, proxyPort: server.address().port }));
    const { agent } = fakeAgent({ sessionId: 'session-reuse', cwd: projectDir });
    const primed = await primedBy(listeners, agent);
    assert.match(primed.at(-1).content[0].text, /Strategy reused from Gene sha256:used/);

    listeners.get('session/event')(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    await untilRequest(requests, '/asset/reuse-result');

    const [report] = requests.filter((request) => request.path === '/asset/reuse-result');
    assert.equal(report.body.asset_id, 'sha256:used');
    assert.equal(report.body.outcome, 'success');
    assert.equal(report.body.task_id, 'session-reuse:1');
    assert.match(report.body.reason, /not confirmed as applied/);
  } finally {
    process.env.HOME = home;
    server.close();
  }
});

test('a strategy the model reported itself is not reported again', async () => {
  const projectDir = gitDirectory('evolver-reuse-own-');
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ path: request.url, body: JSON.parse(body) });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(
        request.url === '/asset/search'
          ? { results: [{ asset_type: 'Gene', asset_id: 'sha256:owned', has_strategy: true, similarity: 0.9 }] }
          : { assets: [{ asset_id: 'sha256:owned', strategy: ['Reuse this.'] }] },
      ));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), 'evolver-reuse-own-home-'));

  try {
    const { ctx, listeners } = fakeContext();
    apply(ctx, Config({ projectDir, proxyPort: server.address().port }));
    const { agent } = fakeAgent({ sessionId: 'session-owned', cwd: projectDir });
    await primedBy(listeners, agent);

    listeners.get('tools/result')(
      { name: 'evolver_asset_reuse_result', agent, arguments: { asset_id: 'sha256:owned', outcome: 'success' } },
      { isError: false },
    );
    listeners.get('session/event')(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    await new Promise((resolve) => { setTimeout(resolve, 150); });

    assert.deepEqual(requests.filter((request) => request.path === '/asset/reuse-result'), []);
  } finally {
    process.env.HOME = home;
    server.close();
  }
});

test('every live turn ending is a capturable outcome, but a synthesized one is not', () => {
  assert.equal(outcomeOfReason('completed').status, 'success');
  assert.equal(outcomeOfReason('error').status, 'failed');
  assert.equal(outcomeOfReason('aborted').status, 'failed');
  assert.equal(outcomeOfReason('blocked').status, 'failed');
  assert.equal(outcomeOfReason('max-tokens').status, 'failed');
  assert.equal(outcomeOfReason('interrupted'), null);
});

test('a fetched asset renders as reusable prose, not the raw envelope', async () => {
  const { evolverTools } = await import('../src/tools.js');
  const envelope = {
    assets: [
      {
        type: 'Gene',
        asset_id: 'sha256:abc',
        summary: 'Fix the pool.',
        strategy: ['Step one.', 'Step two.'],
        validation: ['npm test'],
        signals_match: ['log_error', 'perf_bottleneck'],
        source_node_id: 'node_x',
        gdi_score: 78.5,
      },
    ],
    missing: ['sha256:gone'],
  };
  const fetchTool = evolverTools(async () => ({ ok: true, data: envelope })).find(
    (tool) => tool.name === 'evolver_fetch_asset',
  );
  const text = fetchTool.output.render({}, await fetchTool.execute({ asset_ids: ['sha256:abc'] }, {}))[0].text;

  assert.match(text, /1\. Step one\./);
  assert.match(text, /- npm test/);
  assert.match(text, /sha256:gone/);
  assert.doesNotMatch(text, /signals_match|source_node_id|gdi_score/);
});

test('a strategy that arrived after its own turn ended is still reported, under that turn', async () => {
  const projectDir = gitDirectory('evolver-late-report-');
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body);
      requests.push({ path: request.url, body: parsed });
      const payload = request.url === '/asset/search'
        ? { results: [{ asset_type: 'Gene', asset_id: 'sha256:late', has_strategy: true, similarity: 0.9 }] }
        : request.url === '/asset/fetch'
          ? { assets: [{ asset_id: 'sha256:late', strategy: ['Arrived after the turn.'] }] }
          : { ok: true };
      const delay = request.url === '/asset/reuse-result' ? 0 : 150;
      setTimeout(() => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(payload));
      }, delay);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), 'evolver-late-report-home-'));

  try {
    const { ctx, listeners } = fakeContext();
    apply(ctx, Config({ projectDir, proxyPort: server.address().port, assetPrimeWaitMs: 20 }));
    const { agent, injected } = fakeAgent({ sessionId: 'session-late', cwd: projectDir });

    assert.deepEqual(await primedBy(listeners, agent, 'add a retry to the uploader', 1, 1), []);
    listeners.get('session/event')(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

    await untilInjected(injected, 1);
    assert.match(injected[0].content[0].text, /Strategy reused from Gene sha256:late/);
    assert.deepEqual(requests.filter((request) => request.path === '/asset/reuse-result'), []);

    listeners.get('session/event')(agent.session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
    await untilRequest(requests, '/asset/reuse-result');

    const [report] = requests.filter((request) => request.path === '/asset/reuse-result');
    assert.equal(report.body.asset_id, 'sha256:late');
    assert.equal(report.body.task_id, 'session-late:1');
    assert.match(report.body.reason, /into dsh turn 1/);
  } finally {
    process.env.HOME = home;
    server.close();
  }
});
