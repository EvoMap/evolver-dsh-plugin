// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';

import { appliedVerdictOf } from './applied.js';
import { evolverCommands } from './commands.js';
import { Config } from './config.js';
import { createRecallLog, createReportLog, pluginDiagnostics } from './diagnostics.js';
import { EDIT_TOOL_NAMES } from './edited-content.js';
import { prepareEngine, setupNoticeText } from './engine-setup.js';
import { installedEvolverVersion } from './engine-version.js';
import { feedbackLabelOf } from './feedback-label.js';
import { forgetSession, rememberInjected, takeOrphanedUnreported, takeUnreported } from './injected-assets.js';
import { recordReuseLocally } from './local-ledger.js';
import { noticeDue, pendingClaimUrl } from './onboarding.js';
import { hubGene, promptTextOf } from './prime.js';
import { resolveProjectDir, sessionDir } from './project-dir.js';
import { createProxyClient } from './proxy.js';
import { createReportQueue } from './report-queue.js';
import { rememberForRetention, retentionReportsOf, takeDueRetentions } from './retention-pending.js';
import { correctionReportOf, immediateReportOf, reportedReuseOf } from './reuse.js';
import {
  candidateOf, claimLeftoverCandidates, closeCandidate, distillCandidate, dropCandidate, dueCandidates, modelOf,
  rememberCandidate, settleCandidate, skipReason,
} from './session-distill.js';
import { sessionKeyOf } from './session-key.js';
import { evolverSkillProvider } from './skill.js';
import { evolverTools } from './tools.js';
import { createTurnRecords, noteAnswer, noteFileBeforeEdit, noteToolResult } from './turn-record.js';
import { outcomeOfReason } from './turn-outcomes.js';

export const name = 'evolver';
export { Config };
export const inject = ['tools'];

const DEFAULT_PRIME_WAIT_MS = 6_000;
const DISTILL_TIMEOUT_MS = 120_000;

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
function primeSteps(ctx, config, primeFetch, engineSetup, recallLog, onPrompt) {
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

    const listed = listedFor(agent);
    const startedAt = Date.now();
    const search = hubGene(primeFetch, promptTextOf(claimed), {
      signal,
      listedIds: listed,
      minSimilarity: config.assetPrimeMinSimilarity,
      onOutcome: (outcome) => recallLog.record(outcome, startedAt),
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

function observeResult(record, exec, result, isEdit) {
  try {
    noteToolResult(record, exec, result, { isEdit });
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

function reportsOf(assets, { sessionId, turn, reasonKind, record }) {
  return assets.map((asset) => immediateReportOf({
    asset,
    sessionId,
    turn: turn ?? asset.turn,
    reasonKind,
    checks: record.checks,
    applied: appliedVerdictOf({ strategyText: asset.strategyText, ...record }).verdict,
  }));
}

// Every injected strategy is reported when its turn ends, with the turn's own evidence; the turn itself
// becomes this session's distillation candidate when it finished verified without reusing one.
function reportTurns(ctx, records, deliver, labelable, projectDirOf, prompts) {
  const closeTurn = (session, { turn, reason }) => {
    const sessionId = sessionKeyOf(session);
    const finished = records.take(sessionId);
    const reasonKind = reason?.kind;
    if (!outcomeOfReason(reasonKind)) return;
    const reports = reportsOf(takeUnreported(sessionId, turn), { sessionId, turn, reasonKind, record: finished });
    const reuses = reports.map(reportedReuseOf);
    labelable.set(sessionId, reuses);
    deliver(reports.map((report) => ({ report, sessionId }))).catch(() => {});
    rememberForRetention({ sessionId, projectDir: projectDirOf(session), reuses, editedBefore: finished.editedBefore });
    const reusedAsset = reuses.some((reuse) => reuse.applied === 'used');
    if (skipReason(reasonKind, finished, { reusedAsset })) return;
    const model = modelOf(session?.deriveMessages?.() ?? []);
    rememberCandidate(sessionId, candidateOf({ prompt: prompts.get(sessionId), record: finished, model, turn }));
  };

  ctx.on('session/event', (session, event) => {
    if (isSubagent(session)) return;
    if (event.type === 'assistant/message') noteAnswer(records.of(sessionKeyOf(session)), event.data.message);
    if (event.type === 'turn/end') closeTurn(session, event.data);
  });
}

function abortedReports(assets) {
  return assets.map((asset) => ({
    report: reportsOf([asset], { sessionId: asset.sessionId, reasonKind: 'aborted', record: { checks: [], commands: [], paths: [], edits: [], answer: '' } })[0],
    sessionId: asset.sessionId,
  }));
}

function onSessionStart(ctx, engineSetup, deliver, projectDirOf, distiller) {
  ctx.on('agent/session-start', ({ agent }) => {
    engineSetup.start();
    if (isSubagent(agent.session)) return;
    const due = takeDueRetentions({ sessionId: sessionKeyOf(agent), projectDir: projectDirOf(agent.session) });
    deliver([...due.flatMap(retentionReportsOf), ...abortedReports(takeOrphanedUnreported())]).catch(() => {});
    distiller.distillLeftovers();
  });
}

// The host's model service runs the session-end distillation; a candidate stays on disk until distilled (or
// given up), and one whose session is over — ended with a failed try, or killed with its process — is
// claimed and retried by the next session that starts.
function createDistiller(ctx, proxyFetch) {
  let llm = null;
  ctx.inject(['llm'], (scoped) => {
    llm = scoped.llm;
  });
  const run = async ({ sessionId, candidate }, focus) => {
    const outcome = await distillCandidate({ proxyFetch, llm, candidate, focus, timeoutMs: DISTILL_TIMEOUT_MS });
    settleCandidate(sessionId, candidate, { sent: outcome.status === 'sent' });
    return outcome;
  };
  // One distillation per session at a time: a second flush while the first runs shares its outcome.
  const inFlight = new Map();
  const once = (due, focus) => {
    if (!inFlight.has(due.sessionId)) {
      inFlight.set(due.sessionId, run(due, focus).finally(() => inFlight.delete(due.sessionId)));
    }
    return inFlight.get(due.sessionId);
  };
  return {
    async distillSession(sessionId, focus = '') {
      const [own] = dueCandidates({ sessionId });
      return own ? once(own, focus) : { status: 'nothing' };
    },
    distillLeftovers() {
      for (const due of claimLeftoverCandidates()) once(due).catch(() => {});
    },
  };
}

// The next prompt is the only verdict on a turn available without asking anyone: when it reads as a
// correction, the reuse reports are revised and the turn is no longer worth distilling.
function followUpReporter(deliver, labelable, prompts) {
  return (agent, prompt) => {
    const sessionId = sessionKeyOf(agent);
    if (!prompt) return;
    const label = feedbackLabelOf(prompt);
    if (label === 'correction') dropCandidate(sessionId);
    prompts.set(sessionId, prompt);
    if (!labelable.has(sessionId)) return;
    const reuses = labelable.get(sessionId);
    labelable.delete(sessionId);
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
  const proxyOperations = Object.fromEntries(evolverTools(proxyFetch, { diagnostics }).map((tool) => [tool.name, tool]));

  const deliver = createReportQueue({ proxyFetch, recordLocally: recordReuseLocally, onSettled: reportLog.record });
  const records = createTurnRecords();
  const labelable = new Map();
  const prompts = new Map();
  const distiller = createDistiller(ctx, proxyFetch);

  // Nothing of Evolver but the recalled steps enters the model's context: no tools, and the skill only when
  // configured. People reach it through commands that run here; reports and distillation run on session events.
  if (config.skillEnabled) {
    ctx.inject(['skills'], (scoped) => {
      scoped.skills.registerProvider(() => evolverSkillProvider);
    });
  }
  ctx.inject(['commands'], (scoped) => {
    const commands = evolverCommands({
      status: (signal) => proxyOperations.evolver_status.execute({}, { signal }),
      search: async (text, signal) => {
        try {
          return { ok: true, data: await proxyOperations.evolver_search_assets.execute({ text, limit: 5 }, { signal }) };
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error) };
        }
      },
      distillNow: (agent, focus) => distiller.distillSession(sessionKeyOf(agent), focus),
    });
    for (const command of commands) scoped.commands.register(command);
  });

  primeSteps(ctx, config, primeFetch, engineSetup, recallLog, followUpReporter(deliver, labelable, prompts));
  observeTools(ctx, config.editToolNames ?? EDIT_TOOL_NAMES, records, projectDirOf);
  reportTurns(ctx, records, deliver, labelable, projectDirOf, prompts);
  onSessionStart(ctx, engineSetup, deliver, projectDirOf, distiller);

  ctx.on('session/flush', (session) => (isSubagent(session) ? undefined : distiller.distillSession(sessionKeyOf(session))));
  ctx.on('session/disposed', (session) => {
    const sessionKey = sessionKeyOf(session);
    deliver(abortedReports(takeUnreported(sessionKey, Infinity))).catch(() => {});
    closeCandidate(sessionKey);
    records.forget(sessionKey);
    labelable.delete(sessionKey);
    prompts.delete(sessionKey);
    forgetSession(sessionKey);
  });
}
