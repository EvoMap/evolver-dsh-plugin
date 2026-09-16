import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

import { captureOutcome, collectDiff, forgetCaptures, summarize } from '../src/capture.js';
import { detectSignalsInDiff } from '../src/signals.js';

const logDir = mkdtempSync(join(tmpdir(), 'evolver-log-'));
process.env.EVOLVER_HOOK_LOG_DIR = logDir;

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'evolver-repo-')));
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run('init', '--quiet');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'app.js'), 'export const rate = 1;\n');
  run('add', '.');
  run('commit', '--quiet', '-m', 'first');
  return { dir, run };
}

function graphFor(_dir) {
  const path = join(mkdtempSync(join(tmpdir(), 'evolver-graph-')), 'graph.jsonl');
  process.env.MEMORY_GRAPH_PATH = path;
  return path;
}

function entries(graphPath) {
  try {
    return readFileSync(graphPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

beforeEach(() => forgetCaptures());

after(() => {
  delete process.env.MEMORY_GRAPH_PATH;
  rmSync(logDir, { recursive: true, force: true });
});

test('a clean tree records nothing, however many commits it has', async () => {
  const { dir, run } = repo();
  writeFileSync(join(dir, 'app.js'), 'export const rate = 2;\n');
  run('add', '.');
  run('commit', '--quiet', '-m', 'second');
  const graph = graphFor(dir);

  assert.equal(await captureOutcome(dir, 'completed'), null);
  assert.deepEqual(entries(graph), []);
});

test('an untracked new file is this turn\'s work', async () => {
  const { dir } = repo();
  writeFileSync(join(dir, 'added.js'), 'export const added = true;\n');
  const graph = graphFor(dir);

  assert.ok(await captureOutcome(dir, 'completed'));
  const [recorded] = entries(graph);
  assert.equal(recorded.outcome.status, 'success');
  assert.match(recorded.outcome.note, /added\.js/);
});

test('the same working tree is recorded once, not once per turn', async () => {
  const { dir } = repo();
  writeFileSync(join(dir, 'app.js'), 'export const rate = 3;\n');
  const graph = graphFor(dir);

  assert.ok(await captureOutcome(dir, 'completed'));
  assert.equal(await captureOutcome(dir, 'completed'), null);
  assert.equal(entries(graph).length, 1);

  writeFileSync(join(dir, 'app.js'), 'export const rate = 4;\n');
  assert.ok(await captureOutcome(dir, 'completed'));
  assert.equal(entries(graph).length, 2);
});

test('a failed turn is recorded as a failure', async () => {
  const { dir } = repo();
  writeFileSync(join(dir, 'app.js'), 'export const rate = 5;\n');
  const graph = graphFor(dir);

  assert.ok(await captureOutcome(dir, 'error'));
  const [recorded] = entries(graph);
  assert.equal(recorded.outcome.status, 'failed');
  assert.match(recorded.outcome.note, /Turn error/);
});

test('a written test is not a failing test', () => {
  const diff = ['+++ b/app.test.js', '+test("charges once", () => {', '+  expect(charge(order)).toBe(1);', '+});'].join('\n');
  assert.deepEqual(detectSignalsInDiff(diff), []);

  const reported = ['+// note', '+the deploy failed on ci'].join('\n');
  assert.deepEqual(detectSignalsInDiff(reported), ['deployment_issue', 'log_error']);
});

test('a completed turn stays a success even when the diff mentions a recurring error', () => {
  const outcome = summarize(
    { statText: ' 1 file changed, 1 insertion(+)', body: '+the same error keeps failing here', untracked: [] },
    'completed',
  );
  assert.deepEqual(outcome.signals, ['recurring_error']);
  assert.equal(outcome.status, 'success');
});

test('a symlinked memory graph inside the project is never appended to', async () => {
  const { dir } = repo();
  const outside = mkdtempSync(join(tmpdir(), 'evolver-outside-'));
  const target = join(outside, 'secret.jsonl');
  writeFileSync(target, '');
  const planted = join(dir, 'graph.jsonl');
  symlinkSync(target, planted);
  process.env.MEMORY_GRAPH_PATH = planted;
  writeFileSync(join(dir, 'app.js'), 'export const rate = 6;\n');

  await captureOutcome(dir, 'completed');
  assert.equal(readFileSync(target, 'utf8'), '');
});

test('a directory outside git reports no repository', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-plain-'));
  const diff = await collectDiff(dir);
  assert.equal(diff.isRepo, false);
  assert.equal(await captureOutcome(dir, 'completed'), null);
});
