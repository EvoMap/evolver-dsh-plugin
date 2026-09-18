// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';

import { createCaptureCoordinator } from './capture-coordinator.js';
import { outcomeOfReason } from './capture.js';
import { evolverCommands } from './commands.js';
import { Config } from './config.js';
import { EDIT_TOOL_NAMES, editedContent, editedPath } from './edited-content.js';
import { claimNoticeDue, pendingClaimUrl } from './onboarding.js';
import { hubMatches, promptTextOf } from './prime.js';
import { createProxyClient } from './proxy.js';
import { recallText } from './recall.js';
import { detectSignals } from './signals.js';
import { evolverSkillProvider } from './skill.js';
import { sessionKeyOf } from './session-key.js';
import { evolverTools } from './tools.js';
import { isGitWorkspace, resolveProjectDir, sessionDir } from './workspace.js';

export const name = 'evolver';
export { Config };
export const inject = ['tools'];

const NONGIT_NOTICE =
  '[Evolver] This folder is not a git repository, so evolution memory is inactive ' +
  '(outcomes are derived from git diffs). Run `git init` here, or open a git project, ' +
  'to enable recall and recording.';

function pluginMessage(text, formed) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'evolver', ...formed },
  });
}

function createSignalTracker() {
  const records = new Map();
  const recordFor = (agent) => {
    const key = sessionKeyOf(agent);
    if (!key) return null;
    let record = records.get(key);
    if (!record) {
      record = { signals: new Set(), notices: new Set() };
      records.set(key, record);
    }
    return { key, record };
  };

  return {
    add(agent, signals, noticeKey) {
      const owned = recordFor(agent);
      if (!owned) return true;
      for (const signal of signals) owned.record.signals.add(signal);
      if (owned.record.notices.has(noticeKey)) return false;
      owned.record.notices.add(noticeKey);
      return true;
    },
    take(session) {
      const key = sessionKeyOf(session);
      if (!key) return [];
      const record = records.get(key);
      records.delete(key);
      return record ? [...record.signals] : [];
    },
    clear(session) {
      const key = sessionKeyOf(session);
      if (key) records.delete(key);
    },
  };
}

function sessionMessages(agent, config, fallbackDir) {
  const dir = sessionDir(agent?.session?.header?.cwd, fallbackDir);
  const messages = [];

  if (!isGitWorkspace(dir)) {
    messages.push(pluginMessage(NONGIT_NOTICE, { form: 'notice', summary: 'Evolution memory is inactive outside git.' }));
  } else {
    const memory = recallText(dir, { maxResults: config.recallMaxResults, maxBytes: config.recallMaxBytes });
    if (memory) messages.push(pluginMessage(memory, { form: 'recall' }));
  }

  const claimUrl = config.claimNudgeEnabled ? pendingClaimUrl() : null;
  if (claimUrl && claimNoticeDue(claimUrl, config.claimNudgeTtlMs)) {
    const text =
      `[Evolver] Your local node is not connected to the EvoMap network yet. Open ${claimUrl} `
      + 'while signed in to evomap.ai. Local memory already works; claiming enables network reuse.';
    messages.push(pluginMessage(text, { form: 'notice', summary: 'Claim the local Evolver node.' }));
  }

  return messages;
}

// Reusable context must reach the model behind the prompt it was selected for:
// the task text is only known once a step claims it, and context that precedes
// the prompt reads as unrelated boilerplate. `agent/pre-step` is the first seam
// that carries both. Workspace memory is a session fact and seeds once; the Hub
// is re-queried per turn, because each prompt is a different task — bounded by
// the ids already listed, so a repeat search adds nothing the model has seen.
function primeSteps(ctx, fallbackDir, config, primeFetch) {
  const seeded = new WeakSet();
  const searchedTurn = new WeakMap();
  const listedIds = new WeakMap();

  const hubMessages = async (agent, turn, claimed, signal) => {
    if (config.assetPrimeEnabled === false || searchedTurn.get(agent) === turn) return [];
    searchedTurn.set(agent, turn);

    let listed = listedIds.get(agent);
    if (!listed) {
      listed = new Set();
      listedIds.set(agent, listed);
    }
    const { ids, text } = await hubMatches(primeFetch, promptTextOf(claimed), { signal, listedIds: listed });
    for (const id of ids) listed.add(id);
    return text ? [pluginMessage(text, { form: 'recall' })] : [];
  };

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    const { agent, signal, turn } = payload;
    if (decision.kind === 'reject' || signal?.aborted || decision.messages.length === 0) return decision;

    const messages = [];
    if (!seeded.has(agent)) {
      seeded.add(agent);
      messages.push(...sessionMessages(agent, config, fallbackDir));
    }
    messages.push(...await hubMessages(agent, turn, decision.messages, signal));

    if (messages.length === 0 || signal?.aborted) return decision;
    return { ...decision, messages: [...decision.messages, ...messages] };
  });
}

function nudgeOnSignals(ctx, editToolNames, tracker) {
  ctx.on('tools/result', (exec, result) => {
    if (!exec.agent || !editToolNames.includes(exec.name) || result?.isError) return;

    const signals = detectSignals(editedContent(exec.arguments));
    if (signals.length === 0) return;

    const where = editedPath(exec.arguments) || 'edited file';
    const noticeKey = `${where}\0${signals.join(',')}`;
    if (!tracker.add(exec.agent, signals, noticeKey)) return;
    exec.agent.inject(
      pluginMessage(
        `[Evolution Signal] Detected: [${signals.join(', ')}] in ${where}. This will be attached to the turn outcome.`,
        { form: 'notice', summary: boundContextSummary(`Evolution signal: ${signals.join(', ')}`) },
      ),
    );
  });
}

function captureOnTurnEnd(ctx, fallbackDir, config, tracker, coordinator) {
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return;
    const reasonKind = event.data.reason?.kind;
    if (!outcomeOfReason(reasonKind)) return;
    const projectDir = sessionDir(session?.header?.cwd, fallbackDir);
    coordinator.schedule({
      projectDir,
      reasonKind,
      sessionId: sessionKeyOf(session),
      turn: event.data.turn,
      observedSignals: tracker.take(session),
      gitTimeoutMs: config.gitTimeoutMs,
      gitMaxBufferBytes: config.gitMaxBufferBytes,
      hubTimeoutMs: config.hubTimeoutMs,
      captureDedupeTtlMs: config.captureDedupeTtlMs,
      captureLockStaleMs: config.captureLockStaleMs,
      captureLockWaitMs: config.captureLockWaitMs,
      untrackedHashMaxBytes: config.untrackedHashMaxBytes,
    });
  });

  ctx.on('session/flush', (session) => coordinator.flush(sessionKeyOf(session), sessionDir(session?.header?.cwd, fallbackDir)));
  ctx.on('session/disposed', (session) => tracker.clear(session));
}

export function apply(ctx, config = {}) {
  const explicitDir = config.projectDir ? sessionDir(config.projectDir, null) : null;
  if (config.projectDir && !explicitDir) throw new Error(`Evolver projectDir is not a directory: ${config.projectDir}`);
  if (
    Number.isFinite(config.captureLockWaitMs)
    && Number.isFinite(config.captureLockStaleMs)
    && config.captureLockWaitMs <= config.captureLockStaleMs
  ) {
    throw new Error('Evolver captureLockWaitMs must be greater than captureLockStaleMs.');
  }
  const fallbackDir = explicitDir ?? resolveProjectDir();
  const proxyFetch = createProxyClient({ port: config.proxyPort, timeoutMs: config.proxyTimeoutMs });
  const primeFetch = createProxyClient({ port: config.proxyPort, timeoutMs: config.assetPrimeTimeoutMs ?? 3_000 });
  const tracker = createSignalTracker();
  const coordinator = createCaptureCoordinator();

  for (const tool of evolverTools(proxyFetch)) ctx.tools.register(tool);

  ctx.inject(['skills'], (scoped) => {
    scoped.skills.registerProvider(() => evolverSkillProvider);
  });

  ctx.inject(['commands'], (scoped) => {
    for (const command of evolverCommands()) scoped.commands.register(command);
  });

  primeSteps(ctx, fallbackDir, config, primeFetch);
  nudgeOnSignals(ctx, config.editToolNames ?? EDIT_TOOL_NAMES, tracker);
  captureOnTurnEnd(ctx, fallbackDir, config, tracker, coordinator);
}
