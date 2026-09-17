import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { outcomeOfReason } from '../src/capture.js';
import { Config, apply, inject, name } from '../src/index.js';

const missingClaimFile = join(mkdtempSync(join(tmpdir(), 'evolver-claim-')), 'missing');
process.env.EVOLVER_CLAIM_URL_PATH = missingClaimFile;
after(() => {
  delete process.env.EVOLVER_CLAIM_URL_PATH;
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
    'agent/created',
    'agent/session-start',
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

test('session start injects recall for a workspace with memory', () => {
  const projectDir = gitDirectory();
  const graph = join(projectDir, 'graph.jsonl');
  writeFileSync(
    graph,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      signals: ['perf_bottleneck'],
      outcome: { status: 'success', score: 0.9, note: 'cached the lookup' },
      cwd: projectDir,
    })}\n`,
  );
  process.env.MEMORY_GRAPH_PATH = graph;

  const { ctx, listeners } = fakeContext();
  apply(ctx, { projectDir });
  const { agent, injected } = fakeAgent();
  listeners.get('agent/created')({ agent, source: 'startup' });
  listeners.get('agent/session-start')({ agent, source: 'startup' });

  delete process.env.MEMORY_GRAPH_PATH;
  assert.equal(injected.length, 1);
  assert.equal(injected[0].source.plugin, 'evolver');
  assert.match(injected[0].content[0].text, /cached the lookup/);
});

test('claim guidance is opt-in at session start', () => {
  const projectDir = gitDirectory('evolver-claim-opt-in-');
  const claimDir = mkdtempSync(join(tmpdir(), 'evolver-claim-enabled-'));
  const claimPath = join(claimDir, 'claim_url');
  const stateDir = mkdtempSync(join(tmpdir(), 'evolver-claim-state-'));
  writeFileSync(claimPath, 'https://evomap.ai/claim/node?token=test\n');
  process.env.EVOLVER_CLAIM_URL_PATH = claimPath;
  process.env.EVOLVER_SESSION_STATE_DIR = stateDir;

  try {
    const { ctx, listeners } = fakeContext();
    apply(ctx, Config({ projectDir, claimNudgeEnabled: true }));
    const { agent, injected } = fakeAgent({ cwd: projectDir });
    listeners.get('agent/created')({ agent, source: 'startup' });
    assert.equal(injected.length, 1);
    assert.match(injected[0].content[0].text, /https:\/\/evomap\.ai\/claim/);
  } finally {
    process.env.EVOLVER_CLAIM_URL_PATH = missingClaimFile;
    delete process.env.EVOLVER_SESSION_STATE_DIR;
  }
});

test('a non-git session receives only the inactive notice', () => {
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
  apply(ctx, { projectDir });
  const { agent, injected } = fakeAgent({ cwd: projectDir });
  listeners.get('agent/created')({ agent, source: 'startup' });

  delete process.env.MEMORY_GRAPH_PATH;
  assert.equal(injected.length, 1);
  assert.match(injected[0].content[0].text, /not a git repository/);
  assert.doesNotMatch(injected[0].content[0].text, /foreign memory/);
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

test('every live turn ending is a capturable outcome, but a synthesized one is not', () => {
  assert.equal(outcomeOfReason('completed').status, 'success');
  assert.equal(outcomeOfReason('error').status, 'failed');
  assert.equal(outcomeOfReason('aborted').status, 'failed');
  assert.equal(outcomeOfReason('blocked').status, 'failed');
  assert.equal(outcomeOfReason('max-tokens').status, 'failed');
  assert.equal(outcomeOfReason('interrupted'), null);
});

test('recall reads the session\'s own workspace, not the directory dsh started in', () => {
  const projectDir = gitDirectory();
  const sessionCwd = gitDirectory('evolver-session-');
  const graph = join(projectDir, 'graph.jsonl');
  const entry = (cwd, note) =>
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      signals: ['perf_bottleneck'],
      outcome: { status: 'success', score: 0.9, note },
      cwd,
    })}\n`;
  writeFileSync(graph, entry(projectDir, 'startup directory outcome') + entry(sessionCwd, 'session directory outcome'));
  process.env.MEMORY_GRAPH_PATH = graph;

  const { ctx, listeners } = fakeContext();
  apply(ctx, { projectDir });
  const { agent, injected } = fakeAgent();
  listeners.get('agent/created')({ agent: { ...agent, session: { header: { cwd: sessionCwd } } }, source: 'startup' });

  delete process.env.MEMORY_GRAPH_PATH;
  assert.equal(injected.length, 1);
  assert.match(injected[0].content[0].text, /session directory outcome/);
  assert.doesNotMatch(injected[0].content[0].text, /startup directory outcome/);
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
