import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { belongsToWorkspace, filterRelevant, formatSummary, recallText } from '../src/recall.js';

const now = Date.parse('2026-09-16T00:00:00Z');
const at = (days) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

const success = (days, score = 0.8) => ({
  timestamp: at(days),
  signals: ['stable_success_plateau'],
  outcome: { status: 'success', score, note: 'ok' },
});

test('keeps recent failures and high-scoring successes, newest three', () => {
  const entries = [
    success(30),
    success(1, 0.4),
    success(4),
    { ...success(3), outcome: { status: 'failed', score: 0.3, note: 'failed' } },
    success(2),
    success(1),
  ];
  const kept = filterRelevant(entries, now);
  assert.equal(kept.length, 3);
  assert.deepEqual(
    kept.map((entry) => entry.timestamp),
    [at(3), at(2), at(1)],
  );
  assert.equal(kept[0].outcome.status, 'failed');
});

test('workspace id wins over cwd when both sides know it', () => {
  assert.equal(belongsToWorkspace({ workspace_id: 'a', cwd: '/x' }, 'a', '/y'), true);
  assert.equal(belongsToWorkspace({ workspace_id: 'b', cwd: '/y' }, 'a', '/y'), false);
});

test('an unresolvable local id falls back to cwd rather than leaking', () => {
  assert.equal(belongsToWorkspace({ workspace_id: 'a', cwd: '/x' }, null, '/x'), true);
  assert.equal(belongsToWorkspace({ workspace_id: 'a', cwd: '/x' }, null, '/y'), false);
  assert.equal(belongsToWorkspace({ workspace_id: 'a' }, null, '/y'), false);
});

test('untagged legacy entries are explicit opt-in', () => {
  assert.equal(belongsToWorkspace({}, 'a', '/x'), true);
  assert.equal(belongsToWorkspace({}, 'a', '/x', { allowLegacy: false }), false);
});

test('ineligible recent rows do not hide an older eligible outcome', () => {
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'evolver-recall-')));
  const graph = join(projectDir, 'memory.jsonl');
  const rows = [
    success(1),
    ...Array.from({ length: 5 }, (_, index) => ({
      ...success(index / 10),
      outcome: { status: 'success', score: 0.1, note: 'too weak' },
      cwd: projectDir,
    })),
  ];
  rows[0].cwd = projectDir;
  writeFileSync(graph, `${rows.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  process.env.MEMORY_GRAPH_PATH = graph;
  try {
    const text = recallText(projectDir, { now, maxResults: 3 });
    assert.match(text, /score=0\.8/);
  } finally {
    delete process.env.MEMORY_GRAPH_PATH;
  }
});

test('recall reads a bounded tail without losing the newest complete row', () => {
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'evolver-recall-tail-')));
  const graph = join(projectDir, 'memory.jsonl');
  const latest = { ...success(1), cwd: projectDir };
  writeFileSync(graph, `${'x'.repeat(4_096)}\n${JSON.stringify(latest)}\n`);
  process.env.MEMORY_GRAPH_PATH = graph;
  try {
    assert.match(recallText(projectDir, { now, maxBytes: 512 }), /score=0\.8/);
  } finally {
    delete process.env.MEMORY_GRAPH_PATH;
  }
});

test('summary counts outcomes and truncates rows', () => {
  const text = formatSummary([success(1), { ...success(1), outcome: { status: 'failed', score: 0.3 } }]);
  assert.match(text, /Recent 2 outcomes \(1 success, 1 failed\)/);
  assert.ok(text.split('\n').every((line) => line.length <= 200));
});

test('a symlinked project dir resolves to one spelling', async () => {
  const { resolveProjectDir } = await import('../src/workspace.js');
  const previous = process.env.DSH_PROJECT_DIR;
  process.env.DSH_PROJECT_DIR = '/tmp';
  const resolved = resolveProjectDir();
  if (previous === undefined) delete process.env.DSH_PROJECT_DIR;
  else process.env.DSH_PROJECT_DIR = previous;

  assert.equal(resolved, realpathSync('/tmp'));
});
