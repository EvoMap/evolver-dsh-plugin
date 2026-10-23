// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { createUserMessage } from '@deepseek-ai/dsh-llm';

import { ownerIsGone } from './process-owner.js';
import { withoutSecrets } from './redact.js';
import { readState, statePath, writeState } from './state-file.js';

// Distillation runs once a session, at its end, and outside the agent's conversation: each turn that
// finished verified only leaves a candidate on disk, the latest one wins, and the session end (or, after a
// session that was killed, the next session start) turns it into a Gene with one model call over a digest of
// the turn — never the whole history, which cost ten times as much for fewer usable Genes in the benchmark.
// A candidate leaves the disk only once distilled or given up after MAX_ATTEMPTS failed tries.

const PROMPT_MAX_CHARS = 6_000;
const ANSWER_MAX_CHARS = 3_000;
const COMMAND_MAX_CHARS = 300;
const MAX_COMMANDS = 40;
const LIST_FIELDS = ['strategy', 'validation', 'signals', 'preconditions'];
const ARGUMENT_FIELDS = ['title', 'summary', ...LIST_FIELDS];
const ITEM_NUMBER = /^\s*(?:\d+[.)]|[-*•])\s+/;
const MAX_ATTEMPTS = 3;

const pendingPath = () => statePath('distill-pending.json');

/**
 * Why a finished turn leaves no candidate, or null when it does. A turn that reused an injected strategy
 * adds evidence to that asset through its reuse report rather than a near-copy of it; a chat reply without a
 * single command has no method to keep.
 */
export function skipReason(reasonKind, record, { reusedAsset = false } = {}) {
  if (reasonKind !== 'completed') return 'not_completed';
  if (!record.answer) return 'no_answer';
  if (record.checks.at(-1)?.failed) return 'failed_check';
  if (record.commands.length === 0 && record.edits.length === 0) return 'no_tool_use';
  if (reusedAsset) return 'asset_reused';
  return null;
}

/** The provider and model behind the session's latest assistant message: the distillation runs on it. */
export function modelOf(history) {
  const source = history.findLast((message) => message.role === 'assistant')?.source;
  return source?.provider && source?.model ? { provider: source.provider, model: source.model } : null;
}

// Keys and tokens are stripped before anything is written to disk or sent to a model or the Proxy.
export function candidateOf({ prompt, record, model, turn, pid = process.pid, now = Date.now() }) {
  return {
    prompt: withoutSecrets(String(prompt ?? '')).slice(0, PROMPT_MAX_CHARS),
    commands: record.commands.slice(-MAX_COMMANDS).map((command) => withoutSecrets(command).slice(0, COMMAND_MAX_CHARS)),
    paths: [...new Set(record.paths)],
    checks: record.checks.map(({ command, failed }) => ({ command: withoutSecrets(command), failed })),
    answer: withoutSecrets(record.answer).slice(0, ANSWER_MAX_CHARS),
    model,
    turn,
    pid,
    attempts: 0,
    at: now,
  };
}

export function rememberCandidate(sessionId, candidate) {
  if (!sessionId) return;
  writeState(pendingPath(), { ...readState(pendingPath(), {}), [sessionId]: candidate });
}

export function dropCandidate(sessionId) {
  const pending = readState(pendingPath(), {});
  if (!sessionId || !(sessionId in pending)) return;
  delete pending[sessionId];
  writeState(pendingPath(), pending);
}

/**
 * The candidates due now, left on disk until settled: this session's own, or (sessionId null) those whose
 * owning process is gone — a session killed before its end never distilled them. An idle session whose
 * process still runs keeps its candidate however long it waits.
 */
export function dueCandidates({ sessionId, isGone = ownerIsGone }) {
  return Object.entries(readState(pendingPath(), {}))
    .filter(([id, candidate]) => (sessionId ? id === sessionId : isGone(candidate?.pid)))
    .map(([id, candidate]) => ({ sessionId: id, candidate }));
}

/**
 * Removes a candidate once it was distilled, or counts a failed try and gives up after MAX_ATTEMPTS. A
 * newer candidate the session wrote meanwhile is left alone.
 */
export function settleCandidate(sessionId, candidate, { sent }) {
  const pending = readState(pendingPath(), {});
  const current = pending[sessionId];
  if (!current || current.at !== candidate.at) return;
  const attempts = (current.attempts ?? 0) + 1;
  if (sent || attempts >= MAX_ATTEMPTS) delete pending[sessionId];
  else pending[sessionId] = { ...current, attempts };
  writeState(pendingPath(), pending);
}

export function distillPrompt(candidate, focus = '') {
  const lines = (items, render) => items.map(render).join('\n') || '(none)';
  return [
    'Below is the record of a task an agent has just finished and verified. Turn it into one reusable Gene:',
    'a method another agent could follow on a similar task, written for the kind of data or system involved,',
    'not for these files, names or values. Do not include the answer itself.',
    ...(focus ? [`Focus on: ${focus}`] : []),
    'Answer with a JSON object only, with these fields:',
    '  title: short capability name',
    '  summary: what was solved and under which conditions',
    '  strategy: ordered, reproducible steps',
    '  validation: checks that proved the result',
    '  signals: keywords of the problem this generalizes to',
    '  preconditions: when the method applies',
    '',
    '## Task',
    candidate.prompt,
    '',
    '## Commands run',
    lines(candidate.commands, (command) => `- ${command}`),
    '',
    '## Files read or written',
    lines(candidate.paths, (path) => `- ${path}`),
    '',
    '## Checks',
    lines(candidate.checks, (check) => `- ${check.failed ? 'FAILED' : 'passed'}: ${check.command}`),
    '',
    '## Final answer',
    candidate.answer,
  ].join('\n');
}

// Models sometimes write a list field as one numbered paragraph ("1. … 2. …"), which the core reads as one step.
function listOf(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;
  return value.split(/\n+|(?<=\.)\s+(?=\d+[.)]\s)/).map((item) => item.replace(ITEM_NUMBER, '').trim()).filter(Boolean);
}

export function argumentsOf(text) {
  const match = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed?.summary !== 'string' || !parsed.summary.trim()) return null;
    for (const field of LIST_FIELDS) if (field in parsed) parsed[field] = listOf(parsed[field]);
    return Object.fromEntries(ARGUMENT_FIELDS.filter((field) => parsed[field] !== undefined).map((field) => [field, parsed[field]]));
  } catch {
    return null;
  }
}

export function distillBody(candidate, args, usage) {
  return {
    platform: 'dsh',
    trigger: 'session_end',
    user_prompt: candidate.prompt,
    // The core rejects a Gene that repeats this answer's values (answer_leak).
    final_answer: candidate.answer,
    ...args,
    execution: { trace: candidate.checks.map((check) => ({ command: check.command, exit: check.failed ? 1 : 0 })) },
    persist: true,
    publish: false,
    // What this distillation itself cost, kept apart from the agent's own tokens.
    ...(usage ? { distill_usage: usage } : {}),
  };
}

async function answerOf(llm, model, text, signal) {
  let answer = '';
  let usage = null;
  const messages = [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin:evolver', form: 'instructions' } })];
  for await (const chunk of llm.stream({ ...model, messages, signal })) {
    if (chunk.type === 'text-delta') answer += chunk.text;
    if (chunk.type === 'usage') usage = chunk.usage;
  }
  return { answer, usage };
}

/** Distill one candidate through the host's model service. Resolves to what happened; never throws. */
export async function distillCandidate({ proxyFetch, llm, candidate, focus, timeoutMs }) {
  if (!llm || !candidate?.model) return { status: 'no_model' };
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const { answer, usage } = await answerOf(llm, candidate.model, distillPrompt(candidate, focus), signal);
    const args = argumentsOf(answer);
    if (!args) return { status: 'unparsed', usage };
    const result = await proxyFetch('POST', '/conversation/distill', distillBody(candidate, args, usage), signal);
    return result?.ok ? { status: 'sent', usage, data: result.data } : { status: 'failed', error: String(result?.error) };
  } catch (error) {
    return { status: 'failed', error: String(error?.message ?? error) };
  }
}
