// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';

import { createCaptureCoordinator } from './capture-coordinator.js';
import { outcomeOfReason } from './capture.js';
import { evolverCommands } from './commands.js';
import { Config } from './config.js';
import { EDIT_TOOL_NAMES, editedContent, editedPath } from './edited-content.js';
import { noticeDue, pendingClaimUrl } from './onboarding.js';
import { hubGene, promptTextOf } from './prime.js';
import { createProxyClient } from './proxy.js';
import { reportInjectedReuse } from './reuse.js';
import { detectSignals } from './signals.js';
import { evolverSkillProvider } from './skill.js';
import { sessionKeyOf } from './session-key.js';
import { evolverTools } from './tools.js';
import { isGitWorkspace, resolveProjectDir, sessionDir } from './workspace.js';

export const name = 'evolver';
export { Config };
export const inject = ['tools'];

const DEFAULT_NONGIT_NOTICE_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_PRIME_WAIT_MS = 4_000;

const NONGIT_NOTICE =
  '[Evolver] This folder is not a git repository, so turn outcomes are not recorded '
  + '(they are derived from git diffs). Run `git init` here, or open a git project, to record them. '
  + 'Reusable strategies from the EvoMap network are injected either way.';

function pluginMessage(text, formed) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'evolver', ...formed },
  });
}

function createTurnTracker() {
  const records = new Map();
  const recordFor = (agent) => {
    const key = sessionKeyOf(agent);
    if (!key) return null;
    let record = records.get(key);
    if (!record) {
      record = { signals: new Set(), notices: new Set(), assets: new Map(), reported: new Set() };
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
    rememberAsset(agent, turn, assetId) {
      const owned = recordFor(agent);
      if (!owned) return;
      const forTurn = owned.record.assets.get(turn) ?? new Set();
      forTurn.add(assetId);
      owned.record.assets.set(turn, forTurn);
    },
    markReported(agent, assetId) {
      const owned = recordFor(agent);
      if (owned) owned.record.reported.add(assetId);
    },
    take(session, turn) {
      const key = sessionKeyOf(session);
      if (!key) return { signals: [], assets: [] };
      const record = records.get(key);
      records.delete(key);
      if (!record) return { signals: [], assets: [] };
      const injected = [...(record.assets.get(turn) ?? [])].filter((id) => !record.reported.has(id));
      return { signals: [...record.signals], assets: injected };
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

  if (!isGitWorkspace(dir) && noticeDue(`nongit:${dir}`, config.nongitNoticeTtlMs ?? DEFAULT_NONGIT_NOTICE_TTL_MS)) {
    messages.push(pluginMessage(NONGIT_NOTICE, { form: 'notice', summary: 'Evolution memory is inactive outside git.' }));
  }

  const claimUrl = config.claimNudgeEnabled ? pendingClaimUrl() : null;
  if (claimUrl && noticeDue(claimUrl, config.claimNudgeTtlMs)) {
    const text =
      `[Evolver] Your local node is not connected to the EvoMap network yet. Open ${claimUrl} `
      + 'while signed in to evomap.ai. Local memory already works; claiming enables network reuse.';
    messages.push(pluginMessage(text, { form: 'notice', summary: 'Claim the local Evolver node.' }));
  }

  return messages;
}

function afterWait(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
}

// Reusable context must reach the model behind the prompt it was selected for:
// the task text is only known once a step claims it, and context that precedes
// the prompt reads as unrelated boilerplate. `agent/pre-step` is the first seam
// that carries both. Workspace memory is a session fact and seeds once; the Hub
// is re-queried per turn, because each prompt is a different task — bounded by
// the ids already listed, so a repeat search adds nothing the model has seen.
function primeSteps(ctx, fallbackDir, config, primeFetch, tracker) {
  const seeded = new WeakSet();
  const searchedTurn = new WeakMap();
  const listedAssets = new WeakMap();

  const listedFor = (agent) => {
    let listed = listedAssets.get(agent);
    if (!listed) {
      listed = new Set();
      listedAssets.set(agent, listed);
    }
    return listed;
  };

  const strategyMessage = (agent, turn, listed, { ids, text }) => {
    for (const id of ids) tracker.rememberAsset(agent, turn, id);
    for (const id of ids) listed.add(id);
    return text ? pluginMessage(text, { form: 'recall' }) : null;
  };

  // Search plus fetch against a cold Hub runs into seconds, which is too long
  // to hold the first token for. The step waits only briefly; a lookup that
  // misses that budget keeps running and injects itself into the next step
  // instead of being thrown away.
  const hubMessages = async (agent, turn, claimed, signal) => {
    if (config.assetPrimeEnabled === false || searchedTurn.get(agent) === turn) return [];
    searchedTurn.set(agent, turn);

    const listed = listedFor(agent);
    const search = hubGene(primeFetch, promptTextOf(claimed), {
      signal,
      listedIds: listed,
      minSimilarity: config.assetPrimeMinSimilarity,
    });
    const inline = await Promise.race([search, afterWait(config.assetPrimeWaitMs ?? DEFAULT_PRIME_WAIT_MS)]);
    if (inline) {
      const message = strategyMessage(agent, turn, listed, inline);
      return message ? [message] : [];
    }

    search
      .then((late) => {
        const message = strategyMessage(agent, turn, listed, late);
        if (message && !signal?.aborted) agent.inject(message);
      })
      .catch(() => {});
    return [];
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

const REUSE_RESULT_TOOL = 'evolver_asset_reuse_result';

function nudgeOnSignals(ctx, editToolNames, tracker) {
  ctx.on('tools/result', (exec, result) => {
    if (!exec.agent || result?.isError) return;
    if (exec.name === REUSE_RESULT_TOOL) {
      const assetId = exec.arguments?.asset_id;
      if (typeof assetId === 'string' && assetId) tracker.markReported(exec.agent, assetId);
      return;
    }
    if (!editToolNames.includes(exec.name)) return;

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

function captureOnTurnEnd(ctx, fallbackDir, config, tracker, coordinator, primeFetch) {
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return;
    const reasonKind = event.data.reason?.kind;
    const outcome = outcomeOfReason(reasonKind);
    if (!outcome) return;
    const projectDir = sessionDir(session?.header?.cwd, fallbackDir);
    const sessionId = sessionKeyOf(session);
    const { signals, assets } = tracker.take(session, event.data.turn);

    reportInjectedReuse(primeFetch, {
      assetIds: assets,
      outcome,
      turn: event.data.turn,
      reasonKind,
      sessionId,
    }).catch(() => {});

    coordinator.schedule({
      projectDir,
      reasonKind,
      sessionId,
      turn: event.data.turn,
      observedSignals: signals,
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
  const primeFetch = createProxyClient({ port: config.proxyPort, timeoutMs: config.assetPrimeTimeoutMs ?? 8_000 });
  const tracker = createTurnTracker();
  const coordinator = createCaptureCoordinator();

  for (const tool of evolverTools(proxyFetch)) ctx.tools.register(tool);

  ctx.inject(['skills'], (scoped) => {
    scoped.skills.registerProvider(() => evolverSkillProvider);
  });

  ctx.inject(['commands'], (scoped) => {
    for (const command of evolverCommands()) scoped.commands.register(command);
  });

  primeSteps(ctx, fallbackDir, config, primeFetch, tracker);
  nudgeOnSignals(ctx, config.editToolNames ?? EDIT_TOOL_NAMES, tracker);
  captureOnTurnEnd(ctx, fallbackDir, config, tracker, coordinator, primeFetch);
}
