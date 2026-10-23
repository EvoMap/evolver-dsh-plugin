import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { Config, apply, inject, name } from '../src/index.js';
import {
  evolverOnPath, fakeAgent, fakeContext, freshHome, missingClaimFile, primedBy, projectDirectory, sharedStateDir, startProxy, untilCount, untilInjected,
} from './support/host.js';

test('plugin metadata matches the Cordis v4 contract', () => {
  assert.equal(name, 'evolver');
  assert.deepEqual(inject, ['tools']);
});

test('configuration applies defaults and rejects invalid values', () => {
  const configured = Config({});
  assert.deepEqual(configured.editToolNames, ['write', 'edit', 'str_replace_editor']);
  assert.equal(configured.proxyTimeoutMs, 8_000);
  assert.equal(configured.claimNudgeEnabled, false);
  assert.equal(configured.skillEnabled, false);
  assert.equal(configured.assetPrimeEnabled, true);
  assert.equal(configured.assetPrimeWaitMs, 6_000);
  assert.ok(
    configured.assetPrimeWaitMs < configured.assetPrimeTimeoutMs,
    'a step must give up waiting before the Proxy call it is waiting on does',
  );
  assert.throws(() => Config({ proxyPort: 70_000 }), /proxyPort/);
  assert.throws(() => Config({ editToolNames: 'write' }), /editToolNames/);
  assert.throws(() => apply(fakeContext().ctx, { projectDir: join(tmpdir(), 'definitely-missing-evolver-dir') }), /not a directory/);
});

test('apply puts nothing of Evolver in the model context: no tools, no skill, only commands and listeners', () => {
  const { ctx, registered, listeners } = fakeContext();
  apply(ctx, { projectDir: mkdtempSync(join(tmpdir(), 'evolver-')) });

  assert.deepEqual(registered.tools, []);
  assert.deepEqual(registered.skills, []);
  assert.deepEqual(
    registered.commands.map((command) => command.name).sort(),
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
    'agent/session-start',
    'session/disposed',
    'session/event',
    'session/flush',
    'tools/execute',
  ]);
});

test('the capability-evolver skill is registered only when configured', () => {
  const off = fakeContext();
  apply(off.ctx, Config({ projectDir: mkdtempSync(join(tmpdir(), 'evolver-')) }));
  assert.deepEqual(off.registered.skills, []);

  const on = fakeContext();
  apply(on.ctx, Config({ projectDir: mkdtempSync(join(tmpdir(), 'evolver-')), skillEnabled: true }));
  assert.equal(on.registered.skills.length, 1);
  assert.deepEqual(on.registered.tools, []);
});

test('engine commands run the evolver executable with the given arguments, without the model', async () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { projectDir: mkdtempSync(join(tmpdir(), 'evolver-')) });
  const messages = [];
  const command = registered.commands.find((candidate) => candidate.name === 'evolver-run');
  assert.match(command.input.hint, /--dry-run/);

  const { evolverCommands } = await import('../src/commands.js');
  const calls = [];
  const run = evolverCommands({ status: async () => ({}), search: async () => ({}), distillNow: async () => ({}),
    runCli: async (args) => { calls.push(args); return { kind: 'success', text: 'ok' }; } })
    .find((candidate) => candidate.name === 'evolver-run');
  const result = await run.handler({ agent: { followup: (message) => messages.push(message) }, rawInput: ' --dry-run  --loop ' });

  assert.deepEqual(calls, [['run', '--dry-run', '--loop']]);
  assert.deepEqual(result, { kind: 'success', text: 'ok' });
  assert.deepEqual(messages, [], 'nothing reaches the model');
});

test('command arguments keep quoted words together, and a missing evolver falls back to a pinned npx', async () => {
  const { argumentsOf, runEvolverCli } = await import('../src/commands.js');
  const { MIN_EVOLVER_VERSION } = await import('../src/engine-version.js');
  assert.deepEqual(argumentsOf(' --dry-run --summary="two words" '), ['--dry-run', '--summary=two words']);
  assert.deepEqual(argumentsOf('--summary="a \\"quoted\\" word" --intent=a\\ b'), ['--summary=a "quoted" word', '--intent=a b']);

  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    return file === 'evolver' ? { error: Object.assign(new Error('spawn evolver ENOENT'), { code: 'ENOENT' }) } : { error: null, output: 'synced' };
  };
  assert.deepEqual(await runEvolverCli(['sync', '--dry-run'], { run }), { kind: 'success', text: 'synced' });
  assert.deepEqual(calls, [['evolver', 'sync', '--dry-run'], ['npx', '-y', `@evomap/evolver@^${MIN_EVOLVER_VERSION}`, 'sync', '--dry-run']]);
});

test('/evolver-evolve is the one command that hands the agent an instruction', () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { projectDir: mkdtempSync(join(tmpdir(), 'evolver-')) });
  const messages = [];
  const command = registered.commands.find((candidate) => candidate.name === 'evolver-evolve');

  command.handler({ agent: { followup: (message) => messages.push(message) }, rawInput: ' the retry path ' });
  const text = messages[0].content[0].text;
  assert.match(text, /Focus: the retry path$/);
  assert.doesNotMatch(text, /evolver_[a-z_]+/, 'no tool the agent does not have');
});

test('every turn looks the Hub up with its own prompt, without repeating assets', async () => {
  const projectDir = projectDirectory('evolver-prime-');
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ path: request.url, body: JSON.parse(body) });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        assets: [
          { asset_type: 'Gene', asset_id: 'sha256:abc', strategy: ['Retry with backoff.', 'Then the next step.', 'Then the next step.', 'Then the next step.'] },
          { asset_type: 'Gene', asset_id: 'sha256:def', strategy: ['Chunk the download.', 'Then the next step.', 'Then the next step.', 'Then the next step.'] },
        ],
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
      ['/asset/fetch', '/asset/fetch'],
    );
    assert.equal(requests[0].body.text, 'add a retry to the uploader');
    assert.equal(requests[1].body.text, 'now make the download resumable');
    assert.match(first.at(-1).content[0].text, /\n\nApply them where they fit\.$/);
    assert.doesNotMatch(first.at(-1).content[0].text, /sha256:|evolver_/, 'no id or tool the agent cannot use');
    assert.match(first.at(-1).content[0].text, /^1\. Retry with backoff\.$/m);
    assert.deepEqual(sameTurn, []);
    assert.equal(second.length, 1);
    assert.match(second[0].content[0].text, /^1\. Chunk the download\.$/m);
    assert.doesNotMatch(second[0].content[0].text, /sha256:abc/);
  } finally {
    process.env.HOME = home;
    server.close();
  }
});

test('claim guidance is opt-in', async () => {
  const projectDir = projectDirectory('evolver-claim-opt-in-');
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

function startSession(listeners, id, projectDir) {
  listeners.get('agent/session-start')({ agent: fakeAgent({ id, cwd: projectDir }).agent, source: 'startup' });
}

async function setupNotice(listeners, projectDir) {
  startSession(listeners, 'setup-session', projectDir);
  const deadline = Date.now() + 15_000;
  for (let turn = 1; Date.now() < deadline; turn += 1) {
    const notices = await primedBy(listeners, fakeAgent({ id: `setup-${turn}`, cwd: projectDir }).agent, 'add a retry to the uploader', turn);
    if (notices.length > 0) return notices;
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
  throw new Error('no setup notice arrived');
}

const unixOnly = { skip: process.platform === 'win32' };

test('an Evolver older than 2.0.39 is upgraded to the latest release and its Proxy restarted', unixOnly, async () => {
  const projectDir = projectDirectory('evolver-old-engine-');
  const calls = evolverOnPath('2.0.38', { npmInstalls: '2.0.42' });
  try {
    const { ctx, listeners } = fakeContext();
    apply(ctx, Config({ projectDir, assetPrimeEnabled: false }));
    const [notice] = await setupNotice(listeners, projectDir);
    assert.equal(notice.content[0].text, '[Evolver] Evolver 2.0.38 is older than the 2.0.39 network recall needs, so this plugin upgraded it to 2.0.42 and restarted its Proxy.');
    assert.deepEqual(calls(), ['evolver --version', 'npm install -g @evomap/evolver@latest', 'evolver --version', 'evolver lifecycle restart']);
    assert.deepEqual(await primedBy(listeners, fakeAgent({ id: 'setup-again', cwd: projectDir }).agent, 'add a retry to the uploader', 99), []);
    startSession(listeners, 'setup-session-again', projectDir);
    assert.equal(calls().length, 4, 'setup runs once per dsh process');
  } finally {
    evolverOnPath('2.0.39');
  }
});

test('a missing Evolver is installed and its Proxy started', unixOnly, async () => {
  const projectDir = projectDirectory('evolver-no-engine-');
  const calls = evolverOnPath(null, { npmInstalls: '2.0.42' });
  try {
    const { ctx, listeners } = fakeContext();
    apply(ctx, Config({ projectDir, assetPrimeEnabled: false }));
    const [notice] = await setupNotice(listeners, projectDir);
    assert.equal(notice.content[0].text, '[Evolver] Evolver was not installed, so this plugin installed 2.0.42 and started its Proxy.');
    assert.deepEqual(calls(), ['evolver --version', 'npm install -g @evomap/evolver@latest', 'evolver --version', 'evolver lifecycle start']);
  } finally {
    evolverOnPath('2.0.39');
  }
});

test('an install that fails says how to do it by hand', unixOnly, async () => {
  const projectDir = projectDirectory('evolver-install-fails-');
  evolverOnPath('2.0.38');
  try {
    const { ctx, listeners } = fakeContext();
    apply(ctx, Config({ projectDir, assetPrimeEnabled: false }));
    const [notice] = await setupNotice(listeners, projectDir);
    assert.match(notice.content[0].text, /Evolver 2\.0\.38 is older than 2\.0\.39 and installing the latest release failed \(EACCES: permission denied\)\. Run `npm install -g @evomap\/evolver@latest`/);
  } finally {
    evolverOnPath('2.0.39');
  }
});

test('a current Evolver whose Proxy is down is started; one already serving is left alone', unixOnly, async () => {
  const projectDir = projectDirectory('evolver-start-');
  const calls = evolverOnPath('2.0.42');
  const restoreHome = freshHome('evolver-start-home-');
  try {
    const down = fakeContext();
    apply(down.ctx, Config({ projectDir, assetPrimeEnabled: false, proxyPort: 1 }));
    const [notice] = await setupNotice(down.listeners, projectDir);
    assert.equal(notice.content[0].text, '[Evolver] The Evolver Proxy was not running, so this plugin started it (Evolver 2.0.42).');
    assert.deepEqual(calls(), ['evolver --version', 'evolver lifecycle start']);

    const proxy = await startProxy(() => ({ status: 'running' }));
    const served = evolverOnPath('2.0.42');
    try {
      const up = fakeContext();
      apply(up.ctx, Config({ projectDir, assetPrimeEnabled: false, proxyPort: proxy.port }));
      startSession(up.listeners, 'served', projectDir);
      await untilCount(proxy.requests, (request) => request.path === '/proxy/status', 1);
      await new Promise((resolve) => { setTimeout(resolve, 100); });
      assert.deepEqual(served(), ['evolver --version']);
      assert.deepEqual(await primedBy(up.listeners, fakeAgent({ id: 'served-step', cwd: projectDir }).agent), []);
    } finally {
      proxy.close();
    }
  } finally {
    restoreHome();
    evolverOnPath('2.0.39');
  }
});

test('a search slower than the wait budget injects itself instead of holding the step', async () => {
  const projectDir = projectDirectory('evolver-slow-prime-');
  const server = createServer((request, response) => {
    request.on('data', () => {});
    request.on('end', () => {
      const body = request.url === '/asset/search'
        ? { results: [{ asset_type: 'Gene', asset_id: 'sha256:slow', has_strategy: true }] }
        : { assets: [{ asset_id: 'sha256:slow', strategy: ['Arrived late.', 'Then the next step.', 'Then the next step.', 'Then the next step.'] }] };
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
    const primed = await primedBy(listeners, agent);

    assert.deepEqual(primed, [], 'a step that waited for the slow search would carry its strategy');
    await untilInjected(injected, 1);
    assert.match(injected[0].content[0].text, /^1\. Arrived late\.$/m);
  } finally {
    process.env.HOME = home;
    server.close();
  }
});

test('a fetched asset renders as reusable prose, not the raw envelope', async () => {
  const { evolverTools } = await import('../src/tools.js');
  const envelope = {
    assets: [
      {
        type: 'Gene',
        asset_id: 'sha256:abc',
        summary: 'Fix the pool.',
        strategy: ['Step one.', 'Step two.', 'Then the next step.', 'Then the next step.'],
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

