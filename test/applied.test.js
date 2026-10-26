import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { appliedVerdictOf, concreteFeaturesOf, strategyStepsOf } from '../src/applied.js';

const STRATEGY = [
  '[Evolution Memory] Fix flaky Redis connection in tests (EvoMap network):',
  '1. Set `maxRetriesPerRequest` to null in lib/redis.js',
  '2. Run npm test to confirm the suite passes',
  '3. Wrap the client in a singleton factory module',
  '4. Close the connection in the global teardown hook',
  '',
  'Apply them where they fit.',
].join('\n');

test('only the numbered steps of an injected strategy are matched', () => {
  assert.equal(strategyStepsOf(STRATEGY).length, 4);
});

test('backticked names, paths and commands are concrete features', () => {
  assert.deepEqual(concreteFeaturesOf('Set `maxRetriesPerRequest` to null in lib/redis.js'), ['maxretriesperrequest', 'lib/redis.js']);
  assert.deepEqual(concreteFeaturesOf('Run npm test to confirm'), ['npm test']);
});

test('a turn that touched the named file and ran the named command used the strategy', () => {
  const verdict = appliedVerdictOf({
    strategyText: STRATEGY,
    commands: ['npm test'],
    paths: ['/repo/lib/redis.js'],
    answer: 'I wrapped the client in a singleton factory module.',
  });
  assert.equal(verdict.verdict, 'used');
  assert.equal(verdict.hits, 3);
  assert.equal(verdict.steps, 4);
});

test('one matching step out of four is partial', () => {
  const verdict = appliedVerdictOf({ strategyText: STRATEGY, commands: ['npm test'], paths: [], answer: 'Done.' });
  assert.equal(verdict.verdict, 'partial');
  assert.equal(verdict.ratio, 0.25);
});

test('a turn sharing nothing with the strategy left it unused', () => {
  const verdict = appliedVerdictOf({ strategyText: STRATEGY, commands: ['ls'], paths: ['/repo/README.md'], answer: 'Renamed the heading.' });
  assert.equal(verdict.verdict, 'unused');
  assert.equal(verdict.hits, 0);
});

test('generic words alone do not count as following a prose step', () => {
  const prose = '1. Make sure you always check the result before you report the outcome';
  assert.equal(appliedVerdictOf({ strategyText: prose, commands: ['ls'], paths: [], answer: 'make sure always check before report outcome' }).verdict, 'unused');
});

test('a strategy with no steps cannot be judged', () => {
  assert.deepEqual(appliedVerdictOf({ strategyText: '', commands: ['npm test'], paths: [], answer: '' }), { verdict: 'unknown', hits: 0, steps: 0, ratio: 0 });
});

const CJK_STRATEGY = [
  '[Evolution Memory] 小红书种草快速起号 (EvoMap network):',
  '1. 先定位一个细分赛道和目标人群，写清账号人设',
  '2. 拆解同赛道 10 篇爆款笔记的封面、标题和结构',
  '3. 按“痛点-体验-结论”模板写笔记，封面用大字标题',
  '4. 固定节奏发布并看后台数据，按点击率和收藏率迭代选题',
  '',
  'Apply them where they fit.',
].join('\n');

test('a Chinese answer that follows Chinese steps in its own words used the strategy', () => {
  const answer = [
    '先做账号定位：选一个细分赛道，想清楚目标人群是谁，人设要稳定。',
    '然后拆解同赛道的爆款笔记，记录封面写了什么、标题用了什么结构。',
    '正文按痛点、真实体验、结论来写，封面用大字标题。',
  ].join('\n');
  const verdict = appliedVerdictOf({ strategyText: CJK_STRATEGY, commands: [], paths: [], answer });
  assert.equal(verdict.verdict, 'used');
  assert.equal(verdict.hits, 3);
});

test('a Chinese answer about something else leaves Chinese steps unused, even on the same platform', () => {
  const answer = '小红书上的笔记大多是用户分享的生活经验，很多人在上面看美妆和旅游内容。';
  const verdict = appliedVerdictOf({ strategyText: CJK_STRATEGY, commands: ['ls'], paths: [], answer });
  assert.equal(verdict.verdict, 'unused');
  assert.equal(verdict.hits, 0);
});

test('a step mixing English words and Chinese is matched on both', () => {
  const strategy = '1. 用 retries 和 backoff 包住上传请求，失败后指数退避重试';
  const verdict = appliedVerdictOf({ strategyText: strategy, commands: ['ls'], paths: [], answer: '我给上传请求加了 retries 和 backoff，失败时指数退避。' });
  assert.equal(verdict.verdict, 'used');
});

const SESSION = JSON.parse(readFileSync(new URL('./fixtures/fair-play-session.json', import.meta.url), 'utf8'));

function turnOf({ strategyText, tools, answer }) {
  const args = tools.map((tool) => tool.arguments);
  return {
    strategyText,
    commands: args.map((input) => input.command).filter((command) => typeof command === 'string'),
    paths: args.flatMap((input) => [input.path, input.file_path]).filter((value) => typeof value === 'string'),
    edits: tools.filter((tool) => ['write', 'edit'].includes(tool.name)).map((tool) => tool.arguments.content ?? tool.arguments.new_string),
    answer,
  };
}

const BUILD_TURN = turnOf(SESSION.turns[0]);

test('a strategy carried out in the code the turn wrote is used', () => {
  const verdict = appliedVerdictOf(BUILD_TURN);
  assert.equal(verdict.verdict, 'used');
  assert.equal(verdict.steps, 4);
  assert.ok(verdict.hits >= 3, `hits ${verdict.hits}`);
});

test('a prose word that reads like a command does not stop a step from matching on its terms', () => {
  const step = '1. On get, move the accessed node to the head of the list to mark it as most recently used';
  const edits = ['moveToHead(node) { if (node === this.head) return } // most recently used'];
  assert.equal(appliedVerdictOf({ strategyText: step, commands: [], paths: [], edits, answer: '' }).verdict, 'used');
});

test('work that shares nothing with the strategy is unused', () => {
  const verdict = appliedVerdictOf({ ...BUILD_TURN, edits: ['export const greeting = "hello";\n'], commands: ['ls'], paths: ['/tmp/x/greeting.js'], answer: '好了。' });
  assert.equal(verdict.verdict, 'unused');
});

test('a turn that left only an answer, or a strategy without steps, cannot be judged', () => {
  assert.equal(appliedVerdictOf(turnOf(SESSION.turns[1])).verdict, 'unknown');
  assert.equal(appliedVerdictOf({ strategyText: 'no numbered steps here', commands: ['npm test'], paths: [], edits: [], answer: '' }).verdict, 'unknown');
});
