// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';

import { appliedVerdictOf } from './applied.js';
import { evolverCommands } from './commands.js';
import { Config } from './config.js';
import { createRecallLog, createReportLog, pluginDiagnostics } from './diagnostics.js';
import { EDIT_TOOL_NAMES, editedContent, editedPath } from './edited-content.js';
import { prepareEngine, setupNoticeText } from './engine-setup.js';
import { installedEvolverVersion } from './engine-version.js';
import { feedbackLabelOf } from './feedback-label.js';
import { forgetSession, rememberInjected, takeUnreported } from './injected-assets.js';
import { recordReuseLocally } from './local-ledger.js';
import { noticeDue, pendingClaimUrl } from './onboarding.js';
import { hubGene, promptTextOf } from './prime.js';
import { resolveProjectDir, sessionDir } from './project-dir.js';
import { createProxyClient } from './proxy.js';
import { createReportQueue } from './report-queue.js';
import { rememberForRetention, retentionReportsOf, takeDueRetentions } from './retention-pending.js';
import { correctionReportOf, immediateReportOf, reportedReuseOf } from './reuse.js';
import { sessionKeyOf } from './session-key.js';
import { detectSignals } from './signals.js';
import { evolverSkillProvider } from './skill.js';
import { evolverTools } from './tools.js';
import { createTurnRecords, noteAnswer, noteFileBeforeEdit, noteToolResult } from './turn-record.js';
import { outcomeOfReason } from './turn-outcomes.js';

export const name = 'evolver';
export { Config };
export const inject = ['tools'];

const DEFAULT_PRIME_WAIT_MS = 6_000;

function pluginMessage(text, formed) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin:evolver', ...formed },
  });
}

function isSubagent(session) {
  return session?.header?.origin === 'subagent';
}

function sessionMessages(config) {
  const claimUrl = config.claimNudgeEnabled ? pendingClaimUrl() : null;
  if (!claimUrl || !noticeDue(claimUrl, config.claimNudgeTtlMs)) return [];
  const text =
    `[Evolver] Your local node is not connected to the EvoMap network yet. Open ${claimUrl} `
    + 'while signed in to evomap.ai. Local memory already works; claiming enables network reuse.';
  return [pluginMessage(text, { form: 'notice', summary: 'Claim the local Evolver node.' })];
}

// Installing or upgrading Evolver takes up to minutes, so it runs once per dsh
// process in the background and its outcome rides the first step after it.
function createEngineSetup(prepare) {
  let started = null;
  let notice = null;
  return {
    start() {
      started ??= prepare()
        .then((outcome) => { notice = setupNoticeText(outcome); })
        .catch(() => {});
    },
    takeNotice() {
      const text = notice;
      notice = null;
      return text ? [pluginMessage(text, { form: 'notice', summary: boundContextSummary(text) })] : [];
    },
  };
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
function primeSteps(ctx, config, primeFetch, engineSetup, recallLog, onPrompt, projectDirOf) {
  const seeded = new WeakSet();
  const searchedTurn = new WeakMap();
  const listedAssets = new WeakMap();

  // Kept per project: a Gene already injected for one project is worth injecting again in another, which brings
  // its own notes with it.
  const listedFor = (agent, projectDir) => {
    let byProject = listedAssets.get(agent);
    if (!byProject) {
      byProject = new Map();
      listedAssets.set(agent, byProject);
    }
    let listed = byProject.get(projectDir);
    if (!listed) {
      listed = new Set();
      byProject.set(projectDir, listed);
    }
    return listed;
  };

  const strategyMessage = (agent, turn, listed, { ids, text }) => {
    for (const id of ids) rememberInjected(sessionKeyOf(agent), id, { turn, strategyText: text });
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

    const projectDir = projectDirOf(agent.session);
    const listed = listedFor(agent, projectDir);
    const startedAt = Date.now();
    const search = hubGene(primeFetch, promptTextOf(claimed), {
      signal,
      projectDir,
      listedIds: listed,
      minSimilarity: config.assetPrimeMinSimilarity,
      onOutcome: (outcome) => recallLog.record(outcome, startedAt),
    });
    // A recall carries notes chosen for the project the request named; the session may no longer be there.
    const messageFor = (recalled) => {
      if (projectDirOf(agent.session) === projectDir) return strategyMessage(agent, turn, listed, recalled);
      if (recalled.ids.length > 0) recallLog.record({ status: 'discarded', reason: 'project_changed', asset_id: recalled.ids[0] }, startedAt);
      return null;
    };
    const inline = await Promise.race([search, afterWait(config.assetPrimeWaitMs ?? DEFAULT_PRIME_WAIT_MS)]);
    if (inline) {
      const message = messageFor(inline);
      return message ? [message] : [];
    }

    search
      .then((late) => {
        const message = messageFor(late);
        if (message && !signal?.aborted) agent.inject(message);
      })
      .catch(() => {});
    return [];
  };

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    const { agent, signal, turn } = payload;
    if (decision.kind === 'reject' || signal?.aborted || decision.messages.length === 0) return decision;

    onPrompt(agent, promptTextOf(decision.messages));

    const messages = engineSetup.takeNotice();
    if (!seeded.has(agent)) {
      seeded.add(agent);
      messages.push(...sessionMessages(config));
    }
    messages.push(...await hubMessages(agent, turn, decision.messages, signal));

    if (messages.length === 0 || signal?.aborted) return decision;
    return { ...decision, messages: [...decision.messages, ...messages] };
  });
}

function signalNotice(record, args) {
  const signals = detectSignals(editedContent(args));
  if (signals.length === 0) return null;
  const where = editedPath(args) || 'edited file';
  const noticeKey = `${where}\0${signals.join(',')}`;
  if (record.notices.has(noticeKey)) return null;
  record.notices.add(noticeKey);
  return pluginMessage(
    `[Evolution Signal] Detected: [${signals.join(', ')}] in ${where}.`,
    { form: 'notice', summary: boundContextSummary(`Evolution signal: ${signals.join(', ')}`) },
  );
}

function observeResult(record, exec, result, isEdit) {
  try {
    noteToolResult(record, exec, result, { isEdit });
    const notice = isEdit && !result?.isError ? signalNotice(record, exec.arguments) : null;
    if (notice) exec.agent.inject(notice);
  } catch {
  }
}

// `tools/execute` wraps only calls that were allowed to run, so a check the
// person denied is not taken for a failed one.
function observeTools(ctx, editToolNames, records, projectDirOf) {
  ctx.on('tools/execute', async (exec, next) => {
    const sessionKey = sessionKeyOf(exec.agent);
    const isEdit = editToolNames.includes(exec.name);
    if (sessionKey && isEdit) noteFileBeforeEdit(records.of(sessionKey), projectDirOf(exec.agent.session), exec.arguments);
    const result = await next();
    if (sessionKey) observeResult(records.of(sessionKey), exec, result, isEdit);
    return result;
  });
}

function reportTurns(ctx, records, deliver, labelable, projectDirOf) {
  const closeTurn = (session, { turn, reason }) => {
    const sessionId = sessionKeyOf(session);
    const finished = records.take(sessionId);
    const reasonKind = reason?.kind;
    if (!outcomeOfReason(reasonKind)) return;
    const reports = takeUnreported(sessionId, turn).map((asset) => immediateReportOf({
      asset,
      sessionId,
      turn,
      reasonKind,
      checks: finished.checks,
      applied: appliedVerdictOf({ strategyText: asset.strategyText, ...finished }).verdict,
    }));
    const reuses = reports.map(reportedReuseOf);
    labelable.set(sessionId, reuses);
    deliver(reports.map((report) => ({ report, sessionId }))).catch(() => {});
    rememberForRetention({ sessionId, projectDir: projectDirOf(session), reuses, editedBefore: finished.editedBefore });
  };

  ctx.on('session/event', (session, event) => {
    if (isSubagent(session)) return;
    if (event.type === 'assistant/message') noteAnswer(records.of(sessionKeyOf(session)), event.data.message);
    if (event.type === 'turn/end') closeTurn(session, event.data);
  });
}

function onSessionStart(ctx, engineSetup, deliver, projectDirOf) {
  ctx.on('agent/session-start', ({ agent }) => {
    engineSetup.start();
    if (isSubagent(agent.session)) return;
    const due = takeDueRetentions({ sessionId: sessionKeyOf(agent), projectDir: projectDirOf(agent.session) });
    deliver(due.flatMap(retentionReportsOf)).catch(() => {});
  });
}

function followUpReporter(deliver, labelable) {
  return (agent, prompt) => {
    const sessionId = sessionKeyOf(agent);
    if (!prompt || !labelable.has(sessionId)) return;
    const reuses = labelable.get(sessionId);
    labelable.delete(sessionId);
    const label = feedbackLabelOf(prompt);
    const reports = reuses.map((reuse) => correctionReportOf(reuse, label)).filter((report) => report !== null);
    deliver(reports.map((report) => ({ report, sessionId }))).catch(() => {});
  };
}

export function apply(ctx, config = {}) {
  const explicitDir = config.projectDir ? sessionDir(config.projectDir, null) : null;
  if (config.projectDir && !explicitDir) throw new Error(`Evolver projectDir is not a directory: ${config.projectDir}`);
  const fallbackDir = explicitDir ?? resolveProjectDir();
  const projectDirOf = (session) => sessionDir(session?.header?.cwd, fallbackDir);
  const proxyFetch = createProxyClient({ port: config.proxyPort, timeoutMs: config.proxyTimeoutMs });
  const primeFetch = createProxyClient({ port: config.proxyPort, timeoutMs: config.assetPrimeTimeoutMs ?? 8_000 });

  const engineSetup = createEngineSetup(() => prepareEngine({
    probeVersion: installedEvolverVersion,
    isProxyReachable: async () => !(await proxyFetch('GET', '/proxy/status')).unreachable,
  }));
  const recallLog = createRecallLog();
  const reportLog = createReportLog();
  const diagnostics = () => pluginDiagnostics({ config, engineVersion: installedEvolverVersion, recallLog, reportLog, port: config.proxyPort });
  for (const tool of evolverTools(proxyFetch, { diagnostics, projectDirOf })) ctx.tools.register(tool);

  ctx.inject(['skills'], (scoped) => {
    scoped.skills.registerProvider(() => evolverSkillProvider);
  });

  ctx.inject(['commands'], (scoped) => {
    for (const command of evolverCommands()) scoped.commands.register(command);
  });

  const deliver = createReportQueue({ proxyFetch, recordLocally: recordReuseLocally, onSettled: reportLog.record });
  const records = createTurnRecords();
  const labelable = new Map();

  primeSteps(ctx, config, primeFetch, engineSetup, recallLog, followUpReporter(deliver, labelable), projectDirOf);
  observeTools(ctx, config.editToolNames ?? EDIT_TOOL_NAMES, records, projectDirOf);
  reportTurns(ctx, records, deliver, labelable, projectDirOf);
  onSessionStart(ctx, engineSetup, deliver, projectDirOf);

  ctx.on('session/disposed', (session) => {
    const sessionKey = sessionKeyOf(session);
    records.forget(sessionKey);
    labelable.delete(sessionKey);
    forgetSession(sessionKey);
  });
}
