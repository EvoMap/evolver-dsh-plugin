import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

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
    ['evolver_fetch_asset', 'evolver_poll', 'evolver_publish_asset', 'evolver_search_assets', 'evolver_status'],
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
  assert.deepEqual([...listeners.keys()].sort(), ['agent/session-start', 'session/event', 'tools/result']);
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
  onResult({ name: 'write', agent, arguments: { path: '/a.ts', content: 'the deploy failed again' } }, {});
  onResult({ name: 'write', agent, arguments: { path: '/b.ts', content: 'all good' } }, {});
  onResult({ name: 'read', agent, arguments: { path: '/c.ts', content: 'the deploy failed' } }, {});

  assert.equal(injected.length, 1);
  assert.match(injected[0].content[0].text, /deployment_issue.*\/a\.ts/);
});

test('only a completed turn triggers capture', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'evolver-'));
  const { ctx, listeners } = fakeContext();
  apply(ctx, { projectDir });

  const onEvent = listeners.get('session/event');
  onEvent({}, { type: 'turn/start', data: { turn: 1 } });
  onEvent({}, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } });
  onEvent({}, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
});
