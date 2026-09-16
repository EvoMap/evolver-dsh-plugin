// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';

import { createCaptureCoordinator } from './capture-coordinator.js';
import { outcomeOfReason } from './capture.js';
import { evolverCommands } from './commands.js';
import { Config } from './config.js';
import { EDIT_TOOL_NAMES, editedContent, editedPath } from './edited-content.js';
import { claimNoticeDue, pendingClaimUrl } from './onboarding.js';
import { createProxyClient } from './proxy.js';
import { recallText } from './recall.js';
import { detectSignals } from './signals.js';
import { evolverSkillProvider } from './skill.js';
import { evolverTools } from './tools.js';
import { isGitWorkspace, resolveProjectDir, sessionDir } from './workspace.js';

export const name = 'evolver';
export { Config };
export const inject = ['tools'];

const NONGIT_NOTICE =
  '[Evolver] This folder is not a git repository, so evolution memory is inactive ' +
  '(outcomes are derived from git diffs). Run `git init` here, or open a git project, ' +
  'to enable recall and recording.';

const STARTUP_EVENTS = ['agent/created', 'agent/session-start'];

function pluginMessage(text, formed) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'evolver', ...formed },
  });
}

function identityOf(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}

function createSignalTracker() {
  const records = new Map();
  const recordFor = (agent) => {
    const key = identityOf(agent?.id ?? agent?.session?.id);
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
      const key = identityOf(session?.id);
      if (!key) return [];
      const record = records.get(key);
      records.delete(key);
      return record ? [...record.signals] : [];
    },
    clear(session) {
      const key = identityOf(session?.id);
      if (key) records.delete(key);
    },
  };
}

function seedRecall(ctx, fallbackDir, config) {
  const seeded = new WeakSet();

  const seed = ({ agent }) => {
    if (seeded.has(agent)) return;
    seeded.add(agent);

    const dir = sessionDir(agent?.session?.header?.cwd, fallbackDir);
    const gitWorkspace = isGitWorkspace(dir);
    if (!gitWorkspace) {
      agent.inject(pluginMessage(NONGIT_NOTICE, { form: 'notice', summary: 'Evolution memory is inactive outside git.' }));
    } else {
      const memory = recallText(dir, {
        maxResults: config.recallMaxResults,
        maxBytes: config.recallMaxBytes,
      });
      if (memory) agent.inject(pluginMessage(memory, { form: 'recall' }));
    }

    const claimUrl = pendingClaimUrl();
    if (claimUrl && claimNoticeDue(claimUrl, config.claimNudgeTtlMs)) {
      const text =
        `[Evolver] Your local node is not connected to the EvoMap network yet. Open ${claimUrl} ` +
        'while signed in to evomap.ai. Local memory already works; claiming enables network reuse.';
      agent.inject(pluginMessage(text, { form: 'notice', summary: 'Claim the local Evolver node.' }));
    }
  };

  for (const event of STARTUP_EVENTS) ctx.on(event, seed);
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
      sessionId: identityOf(session?.id),
      turn: event.data.turn,
      observedSignals: tracker.take(session),
      gitTimeoutMs: config.gitTimeoutMs,
      gitMaxBufferBytes: config.gitMaxBufferBytes,
      hubTimeoutMs: config.hubTimeoutMs,
      captureDedupeTtlMs: config.captureDedupeTtlMs,
      untrackedHashMaxBytes: config.untrackedHashMaxBytes,
    });
  });

  ctx.on('session/flush', (session) => coordinator.flush(identityOf(session?.id), sessionDir(session?.header?.cwd, fallbackDir)));
  ctx.on('session/disposed', (session) => tracker.clear(session));
}

export function apply(ctx, config = {}) {
  const explicitDir = config.projectDir ? sessionDir(config.projectDir, null) : null;
  if (config.projectDir && !explicitDir) throw new Error(`Evolver projectDir is not a directory: ${config.projectDir}`);
  const fallbackDir = explicitDir ?? resolveProjectDir();
  const proxyFetch = createProxyClient({ port: config.proxyPort, timeoutMs: config.proxyTimeoutMs });
  const tracker = createSignalTracker();
  const coordinator = createCaptureCoordinator();

  for (const tool of evolverTools(proxyFetch)) ctx.tools.register(tool);

  ctx.inject(['skills'], (scoped) => {
    scoped.skills.registerProvider(() => evolverSkillProvider);
  });

  ctx.inject(['commands'], (scoped) => {
    for (const command of evolverCommands()) scoped.commands.register(command);
  });

  seedRecall(ctx, fallbackDir, config);
  nudgeOnSignals(ctx, config.editToolNames ?? EDIT_TOOL_NAMES, tracker);
  captureOnTurnEnd(ctx, fallbackDir, config, tracker, coordinator);
}
