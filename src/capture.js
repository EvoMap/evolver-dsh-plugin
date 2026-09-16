// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { git, gitText } from './git.js';
import { isLoopbackUrl } from './proxy.js';
import { detectSignalsInDiff } from './signals.js';
import { appendMemoryGraph, captureStatePath, resolveWorkspaceId } from './workspace.js';

const DEFAULT_HUB_TIMEOUT_MS = 8_000;
const DEFAULT_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_UNTRACKED_HASH_MAX_BYTES = 1024 * 1024;
const CAPTURE_LOCK_STALE_MS = 60_000;
const CAPTURE_LOCK_RETRY_MS = 25;
const CAPTURE_LOCK_RETRIES = 600;

const TURN_OUTCOMES = {
  completed: { status: 'success', score: 0.8 },
  'max-tokens': { status: 'failed', score: 0.5 },
  aborted: { status: 'failed', score: 0.4 },
  blocked: { status: 'failed', score: 0.3 },
  error: { status: 'failed', score: 0.2 },
};

const TURN_SIGNALS = {
  'max-tokens': 'max_tokens',
  aborted: 'turn_aborted',
  blocked: 'turn_blocked',
  error: 'log_error',
};

const PLUGIN_STATE = /(^|\/)\.evolver\/|memory_graph\.jsonl$/;

export function outcomeOfReason(reasonKind) {
  return TURN_OUTCOMES[reasonKind] ?? null;
}

async function diffCommands(projectDir, gitOptions) {
  const hasHead = (await git(['rev-parse', '--verify', '--quiet', 'HEAD'], projectDir, gitOptions)).ok;
  return hasHead ? [['diff', 'HEAD']] : [['diff', '--cached'], ['diff']];
}

function pathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function untrackedMark(projectDir, relativePath, maxBytes) {
  const root = path.resolve(projectDir);
  const absolute = path.resolve(root, relativePath);
  if (!pathInside(root, absolute)) return `${relativePath}\0outside`;

  let fileHandle;
  try {
    const initial = await fs.promises.lstat(absolute);
    if (initial.isSymbolicLink()) {
      return `${relativePath}\0symlink\0${await fs.promises.readlink(absolute)}`;
    }
    if (!initial.isFile()) return `${relativePath}\0other\0${initial.size}\0${initial.mtimeMs}`;

    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    fileHandle = await fs.promises.open(absolute, fs.constants.O_RDONLY | noFollow);
    const current = await fileHandle.stat();
    if (!current.isFile()) return `${relativePath}\0other\0${current.size}\0${current.mtimeMs}`;

    const sampleSize = Math.min(current.size, maxBytes);
    const firstSize = Math.ceil(sampleSize / 2);
    const lastSize = sampleSize - firstSize;
    const hash = crypto.createHash('sha256');
    if (firstSize > 0) {
      const first = Buffer.alloc(firstSize);
      const { bytesRead } = await fileHandle.read(first, 0, first.length, 0);
      hash.update(first.subarray(0, bytesRead));
    }
    if (lastSize > 0) {
      const last = Buffer.alloc(lastSize);
      const position = Math.max(0, current.size - lastSize);
      const { bytesRead } = await fileHandle.read(last, 0, last.length, position);
      hash.update(last.subarray(0, bytesRead));
    }
    return `${relativePath}\0file\0${current.size}\0${current.mtimeMs}\0${hash.digest('hex')}`;
  } catch {
    return `${relativePath}\0unreadable`;
  } finally {
    await fileHandle?.close().catch(() => {});
  }
}

export async function collectDiff(projectDir, options = {}) {
  const gitOptions = {
    signal: options.signal,
    timeoutMs: options.gitTimeoutMs,
    maxBuffer: options.gitMaxBufferBytes,
  };
  const insideTree = await git(['rev-parse', '--is-inside-work-tree'], projectDir, gitOptions);
  if (!insideTree.ok || insideTree.stdout.trim() !== 'true') {
    return { isRepo: false, statText: '', body: '', untracked: [], untrackedMarks: [] };
  }

  const commands = await diffCommands(projectDir, gitOptions);
  const [statTexts, bodies, untrackedText] = await Promise.all([
    Promise.all(commands.map((args) => gitText([...args, '--stat', '--'], projectDir, gitOptions))),
    Promise.all(commands.map((args) => gitText([...args, '--no-color', '--'], projectDir, gitOptions))),
    gitText(['ls-files', '--others', '--exclude-standard', '-z'], projectDir, gitOptions),
  ]);

  const untracked = untrackedText
    .split('\0')
    .filter((relativePath) => relativePath.length > 0 && !PLUGIN_STATE.test(relativePath));
  const maxBytes = options.untrackedHashMaxBytes ?? DEFAULT_UNTRACKED_HASH_MAX_BYTES;
  const untrackedMarks = [];
  for (const relativePath of untracked) {
    if (options.signal?.aborted) break;
    untrackedMarks.push(await untrackedMark(projectDir, relativePath, maxBytes));
  }

  return {
    isRepo: true,
    statText: statTexts.join('\n'),
    body: bodies.join('\n'),
    untracked,
    untrackedMarks,
  };
}

export function parseStat(statText) {
  const sum = (pattern) => {
    let total = 0;
    for (const match of statText.matchAll(pattern)) total += Number.parseInt(match[1], 10);
    return total;
  };
  return {
    files: sum(/(\d+)\s+files?\s+changed/g),
    insertions: sum(/(\d+)\s+insertions?\(\+\)/g),
    deletions: sum(/(\d+)\s+deletions?\(-\)/g),
  };
}

export function isEmpty(diff) {
  return diff.body.trim().length === 0 && diff.untracked.length === 0;
}

function untrackedNote(untracked) {
  if (untracked.length === 0) return '';
  const shown = untracked.slice(0, 5).join(', ');
  const rest = untracked.length > 5 ? `, +${untracked.length - 5} more` : '';
  return ` New untracked files: ${shown}${rest}.`;
}

export function summarize(diff, reasonKind, observedSignals = []) {
  const stats = parseStat(diff.statText);
  const detected = [...observedSignals, ...detectSignalsInDiff(diff.body)];
  const reasonSignal = TURN_SIGNALS[reasonKind];
  if (reasonSignal) detected.push(reasonSignal);
  const signals = [...new Set(detected)].sort();
  if (signals.length === 0) signals.push('stable_success_plateau');
  const { status, score } = outcomeOfReason(reasonKind) ?? TURN_OUTCOMES.completed;

  return {
    signals,
    status,
    score,
    note:
      `Turn ${reasonKind}: ${stats.files + diff.untracked.length} files changed, ` +
      `+${stats.insertions}/-${stats.deletions}. Signals: [${signals.join(', ')}]` +
      `.${untrackedNote(diff.untracked)}`,
  };
}

export function fingerprint(diff, reasonKind) {
  return crypto
    .createHash('sha256')
    .update(reasonKind)
    .update('\0')
    .update(diff.statText)
    .update('\0')
    .update(diff.body)
    .update('\0')
    .update((diff.untrackedMarks ?? diff.untracked).join('\n'))
    .digest('hex');
}

export function appendEvolutionLog(line) {
  try {
    const dir = process.env.EVOLVER_HOOK_LOG_DIR || path.join(os.homedir(), '.evolver', 'logs');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, 'evolution.log'), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {
  }
}

function buildEntry(outcome, context) {
  return {
    timestamp: new Date().toISOString(),
    gene_id: 'ad_hoc',
    signals: outcome.signals,
    outcome: { status: outcome.status, score: outcome.score, note: outcome.note },
    cwd: context.projectDir,
    workspace_id: context.workspaceId,
    session_id: context.sessionId,
    turn: context.turn,
    turn_reason: context.reasonKind,
    diff_hash: context.diffHash,
    diff_scope: 'working_tree',
    source: 'dsh:turn-end',
  };
}

export function normalizeHubUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    if (url.protocol === 'https:') return url;
    if (url.protocol === 'http:' && isLoopbackUrl(url.toString())) return url;
    return null;
  } catch {
    return null;
  }
}

async function recordToHub(payload, options = {}) {
  const rawUrl = process.env.EVOMAP_HUB_URL || process.env.A2A_HUB_URL;
  const apiKey = process.env.EVOMAP_API_KEY || process.env.A2A_NODE_SECRET;
  if (!rawUrl || !apiKey) return false;
  const hubUrl = normalizeHubUrl(rawUrl);
  if (!hubUrl) return false;

  try {
    const endpoint = new URL('/a2a/evolution/record', hubUrl);
    const timeout = AbortSignal.timeout(options.hubTimeoutMs ?? DEFAULT_HUB_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal,
    });
    return response.ok;
  } catch {
    return false;
  }
}

function readCaptureState(statePath) {
  try {
    const stat = fs.lstatSync(statePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return { records: {} };
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) return { records: {} };
    return { records: state.records && typeof state.records === 'object' ? state.records : {} };
  } catch {
    return { records: {} };
  }
}

function writeCaptureState(statePath, state) {
  let temporary;
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    temporary = `${statePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    try {
      fs.renameSync(temporary, statePath);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      fs.rmSync(statePath, { force: true });
      fs.renameSync(temporary, statePath);
    }
    return true;
  } catch {
    if (temporary) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
      }
    }
    return false;
  }
}

function captureKeys(context) {
  const scope = context.sessionId || context.workspaceId || context.projectDir;
  const keys = [];
  if (context.sessionId && Number.isSafeInteger(context.turn)) {
    keys.push(`turn:${context.sessionId}:${context.turn}`);
  }
  if (context.reasonKind === 'completed') keys.push(`diff:${scope}:${context.diffHash}`);
  if (keys.length === 0) keys.push(`diff:${scope}:${context.reasonKind}:${context.diffHash}`);
  return keys;
}

function pruneCaptureState(state, now, ttlMs) {
  for (const [key, timestamp] of Object.entries(state.records)) {
    if (typeof timestamp !== 'number' || now - timestamp > ttlMs) delete state.records[key];
  }
}

function wait(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function withCaptureLock(projectDir, signal, callback) {
  const statePath = captureStatePath(projectDir);
  const lockPath = `${statePath}.lock`;
  let lock;
  for (let attempt = 0; attempt < CAPTURE_LOCK_RETRIES; attempt += 1) {
    if (signal?.aborted) return null;
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
      lock = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') return callback({ statePath, state: readCaptureState(statePath), locked: false });
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > CAPTURE_LOCK_STALE_MS) fs.rmSync(lockPath, { force: true });
      } catch {
      }
      await wait(CAPTURE_LOCK_RETRY_MS, signal).catch(() => {});
    }
  }
  if (lock === undefined) return null;

  try {
    return await callback({ statePath, state: readCaptureState(statePath), locked: true });
  } finally {
    try {
      fs.closeSync(lock);
    } catch {
    }
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
    }
  }
}

function normalizeCaptureOptions(projectDirOrOptions, reasonKind) {
  if (typeof projectDirOrOptions === 'string') {
    return { projectDir: projectDirOrOptions, reasonKind };
  }
  return { ...projectDirOrOptions };
}

export function forgetCaptures(projectDir) {
  for (const suffix of ['', '.lock']) {
    try {
      fs.rmSync(`${captureStatePath(projectDir)}${suffix}`, { force: true });
    } catch {
    }
  }
}

export async function prepareCapture(projectDirOrOptions, legacyReasonKind = 'completed') {
  const options = normalizeCaptureOptions(projectDirOrOptions, legacyReasonKind);
  const {
    projectDir,
    reasonKind = 'completed',
    sessionId = null,
    turn = null,
    observedSignals = [],
    signal,
  } = options;
  if (!outcomeOfReason(reasonKind) || signal?.aborted) return null;

  const diff = await collectDiff(projectDir, options);
  if (!diff.isRepo) {
    appendEvolutionLog('[Evolution] Turn end: nothing recorded (not a git workspace).');
    return null;
  }
  if (isEmpty(diff) && reasonKind === 'completed') {
    appendEvolutionLog('[Evolution] Turn end: nothing recorded (no changes detected this turn).');
    return null;
  }

  const workspaceId = resolveWorkspaceId(projectDir);
  const diffHash = fingerprint(diff, reasonKind);
  const context = { projectDir, workspaceId, sessionId, turn, reasonKind, diffHash };
  return {
    options,
    context,
    keys: captureKeys(context),
    outcome: summarize(diff, reasonKind, observedSignals),
  };
}

export async function commitPreparedCapture(prepared) {
  if (!prepared) return null;
  const { options, context, keys, outcome } = prepared;
  const {
    projectDir,
    workspaceId,
    sessionId,
    turn,
    reasonKind,
    diffHash,
  } = context;
  const {
    signal,
    captureDedupeTtlMs = DEFAULT_DEDUPE_TTL_MS,
  } = options;

  const hubPayload = {
    gene_id: 'ad_hoc',
    signals: outcome.signals,
    status: outcome.status,
    score: outcome.score,
    summary: outcome.note,
    sender_id: process.env.EVOMAP_NODE_ID || process.env.A2A_NODE_ID,
    workspace_id: workspaceId,
    session_id: sessionId,
    turn,
    turn_reason: reasonKind,
    diff_hash: diffHash,
    diff_scope: 'working_tree',
  };

  const recorded = await withCaptureLock(projectDir, signal, async ({ statePath, state }) => {
    const now = Date.now();
    pruneCaptureState(state, now, captureDedupeTtlMs);
    if (keys.some((key) => typeof state.records[key] === 'number')) {
      appendEvolutionLog('[Evolution] Turn end: nothing recorded (duplicate turn or unchanged result).');
      return { duplicate: true, localOk: false, hubOk: false, hubAttempted: false };
    }

    const localOk = appendMemoryGraph(projectDir, buildEntry(outcome, context));
    const hubOk = localOk ? false : await recordToHub(hubPayload, options);
    if (localOk || hubOk) {
      for (const key of keys) state.records[key] = now;
      writeCaptureState(statePath, state);
    }
    return { duplicate: false, localOk, hubOk, hubAttempted: !localOk };
  });
  if (!recorded || recorded.duplicate) return null;

  const hubOk = recorded.hubAttempted ? recorded.hubOk : await recordToHub(hubPayload, options);
  const { localOk } = recorded;
  const destination = hubOk && localOk ? 'Hub and local memory' : hubOk ? 'Hub' : localOk ? 'local memory' : 'nowhere';
  const receipt = `[Evolution] Turn outcome recorded to ${destination}: ${outcome.note}`;
  appendEvolutionLog(receipt);
  return receipt;
}

export async function captureOutcome(projectDirOrOptions, legacyReasonKind = 'completed') {
  return commitPreparedCapture(await prepareCapture(projectDirOrOptions, legacyReasonKind));
}
