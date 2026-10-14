import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after } from 'node:test';

export const missingClaimFile = join(mkdtempSync(join(tmpdir(), 'evolver-claim-')), 'missing');
process.env.EVOLVER_CLAIM_URL_PATH = missingClaimFile;
export const sharedStateDir = mkdtempSync(join(tmpdir(), 'evolver-notice-state-'));
process.env.EVOLVER_SESSION_STATE_DIR = sharedStateDir;
const originalPath = process.env.PATH;

export function evolverOnPath(version, { npmInstalls } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-bin-'));
  const log = join(dir, 'calls.log');
  const versionFile = join(dir, 'version');
  writeFileSync(log, '');
  writeFileSync(versionFile, version ?? '');
  writeFileSync(join(dir, 'evolver'), [
    '#!/bin/sh',
    `echo "evolver $*" >> "${log}"`,
    `v=$(cat "${versionFile}")`,
    '[ -n "$v" ] || exit 127',
    '[ "$1" = "--version" ] && echo "$v"',
    'exit 0',
  ].join('\n'));
  writeFileSync(join(dir, 'npm'), [
    '#!/bin/sh',
    `echo "npm $*" >> "${log}"`,
    npmInstalls ? `echo ${npmInstalls} > "${versionFile}"` : 'echo "EACCES: permission denied" >&2; exit 1',
  ].join('\n'));
  chmodSync(join(dir, 'evolver'), 0o755);
  chmodSync(join(dir, 'npm'), 0o755);
  process.env.PATH = `${dir}${delimiter}${originalPath}`;
  return () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
}

evolverOnPath('2.0.39');
after(() => {
  delete process.env.EVOLVER_CLAIM_URL_PATH;
  delete process.env.EVOLVER_SESSION_STATE_DIR;
  process.env.PATH = originalPath;
});

export function fakeContext() {
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

export function fakeAgent({ id = 'agent-test', sessionId = id, cwd } = {}) {
  const injected = [];
  const session = { id: sessionId, header: cwd ? { cwd } : {} };
  return {
    agent: { id, session, inject: (message) => injected.push(message), followup: () => {} },
    injected,
  };
}

export function userMessage(text) {
  return { content: [{ type: 'text', text }], source: { kind: 'user' } };
}

export async function primedBy(listeners, agent, prompt = 'add a retry to the uploader', turn = 1, step = 1) {
  const claimed = [userMessage(prompt)];
  const decision = await listeners.get('agent/pre-step')(
    { agent, messages: claimed, turn, step, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: claimed }),
  );
  assert.equal(decision.messages[0], claimed[0]);
  return decision.messages.slice(1);
}

// A watchdog against a hang, not an assertion: each of these returns the moment
// its condition holds, so the budget only has to outlast the slowest runner. Two
// seconds did not -- the correction case takes ~2.0s on an idle laptop, and the
// dsh 0.1.5-rc.3 matrix leg failed on it while every other leg passed.
export async function untilCount(items, predicate, count, deadlineMs = 15_000) {
  const start = Date.now();
  while (items.filter(predicate).length < count) {
    if (Date.now() - start > deadlineMs) throw new Error(`only ${items.filter(predicate).length} of ${count} expected entries arrived`);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  return items.filter(predicate);
}

export async function untilRequest(requests, path, deadlineMs = 15_000) {
  const start = Date.now();
  while (!requests.some((request) => request.path === path)) {
    if (Date.now() - start > deadlineMs) throw new Error(`no ${path} request arrived`);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  return requests;
}

export async function untilInjected(injected, count, deadlineMs = 15_000) {
  const start = Date.now();
  while (injected.length < count) {
    if (Date.now() - start > deadlineMs) throw new Error(`only ${injected.length} of ${count} messages were injected`);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  return injected;
}

export function projectDirectory(prefix = 'evolver-') {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}


export async function startProxy(answer, { delayMs = () => 0 } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = body ? JSON.parse(body) : undefined;
      requests.push({ path: request.url, body: parsed });
      setTimeout(() => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(answer(request.url, parsed, requests)));
      }, delayMs(request.url));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { requests, port: server.address().port, close: () => server.close() };
}

export function freshHome(prefix) {
  const home = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), prefix));
  return () => { process.env.HOME = home; };
}
