import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { outcomeOfReason } from '../src/capture.js';
import { apply, inject, name } from '../src/index.js';

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

function fakeAgent() {
  const injected = [];
  return { agent: { inject: (message) => injected.push(message), followup: () => {} }, injected };
}

test('plugin metadata matches the Cordis v4 contract', () => {
  assert.equal(name, 'evolver');
  assert.deepEqual(inject, ['tools']);
});

test('apply registers every surface and lifecycle listener', () => {
  const { ctx, registered, listeners } = fakeContext();
  apply(ctx, { projectDir: mkdtempSync(join(tmpdir(), 'evolver-')) });

  assert.deepEqual(
    registered.tools.map((tool) => tool.name).sort(),
    [
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
    'session/event',
    'tools/result',
  ]);
});

test('session start injects recall for a workspace with memory', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'evolver-'));
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

test('an edit carrying a signal nudges the agent once', () => {
  const { ctx, listeners } = fakeContext();
  apply(ctx, { projectDir: mkdtempSync(join(tmpdir(), 'evolver-')) });
  const { agent, injected } = fakeAgent();

  const onResult = listeners.get('tools/result');
  onResult({ name: 'write', agent, arguments: { path: '/a.ts', content: 'the deploy failed again' } }, { isError: false });
  onResult({ name: 'write', agent, arguments: { path: '/b.ts', content: 'all good' } }, { isError: false });
  onResult({ name: 'read', agent, arguments: { path: '/c.ts', content: 'the deploy failed' } }, { isError: false });
  onResult({ name: 'write', agent, arguments: { path: '/d.ts', content: 'the deploy failed' } }, { isError: true });

  assert.equal(injected.length, 1);
  assert.match(injected[0].content[0].text, /deployment_issue.*\/a\.ts/);
  assert.equal(injected[0].source.form, 'notice');
  assert.ok(injected[0].source.summary.length > 0 && injected[0].source.summary.length <= 120);
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
  const projectDir = mkdtempSync(join(tmpdir(), 'evolver-'));
  const sessionCwd = realpathSync(mkdtempSync(join(tmpdir(), 'evolver-session-')));
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
