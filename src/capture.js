// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { git, gitText } from './git.js';
import { detectSignalsInDiff } from './signals.js';
import { appendMemoryGraph, captureStatePath, resolveWorkspaceId } from './workspace.js';

const HUB_TIMEOUT_MS = 8000;

// The turn's own ending, not a keyword in the diff, is what says whether the
// work succeeded: a diff can contain the word `expect(` because a passing test
// was just written.
const TURN_OUTCOMES = {
  completed: { status: 'success', score: 0.8 },
  'max-tokens': { status: 'failed', score: 0.5 },
  aborted: { status: 'failed', score: 0.4 },
  blocked: { status: 'failed', score: 0.3 },
  error: { status: 'failed', score: 0.2 },
};

export function outcomeOfReason(reasonKind) {
  return TURN_OUTCOMES[reasonKind] ?? null;
}

// `git diff HEAD` is the working tree against the current commit — this turn's
// uncommitted result. `HEAD~1` would report the previous commit's content on a
// clean tree, crediting every turn with work it did not do. Before the first
// commit there is no HEAD to diff against, and neither `--cached` nor a plain
// `git diff` alone sees both halves of the work, so both are collected.
async function diffCommands(projectDir) {
  const hasHead = (await git(['rev-parse', '--verify', '--quiet', 'HEAD'], projectDir)).ok;
  return hasHead ? [['diff', 'HEAD']] : [['diff', '--cached'], ['diff']];
}

// Evolver's own workspace state is not the agent's work: `.evolver/workspace-id`
// appears the moment the first outcome is recorded, and counting it as a change
// would make every following turn look different again. It sits at the workspace
// root, which is not always the repository root.
const PLUGIN_STATE = /(^|\/)\.evolver\/|memory_graph\.jsonl$/;

// `git diff` never shows an untracked file's content, so its path alone cannot
// tell one revision of a new file from the next. Size and mtime can, without
// reading a file that may be large.
function untrackedMark(projectDir, relativePath) {
  try {
    const stat = fs.statSync(path.join(projectDir, relativePath));
    return `${relativePath}\0${stat.size}\0${stat.mtimeMs}`;
  } catch {
    return relativePath;
  }
}

export async function collectDiff(projectDir) {
  const insideTree = await git(['rev-parse', '--is-inside-work-tree'], projectDir);
  if (!insideTree.ok || insideTree.stdout.trim() !== 'true') {
      return { isRepo: false, statText: '', body: '', untracked: [], untrackedMarks: [] };
  }

  const commands = await diffCommands(projectDir);
  const [statTexts, bodies, untrackedText] = await Promise.all([
    Promise.all(commands.map((args) => gitText([...args, '--stat'], projectDir))),
    Promise.all(commands.map((args) => gitText([...args, '--no-color'], projectDir))),
    gitText(['ls-files', '--others', '--exclude-standard'], projectDir),
  ]);

  const untracked = untrackedText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !PLUGIN_STATE.test(line));

  return {
    isRepo: true,
    statText: statTexts.join('\n'),
    body: bodies.join('\n'),
    untracked,
    untrackedMarks: untracked.map((relativePath) => untrackedMark(projectDir, relativePath)),
  };
}

// A repository with no commit is summarized by two `--stat` runs, so every
// summary line counts, not just the first.
export function parseStat(statText) {
  const total = (pattern) => {
    let sum = 0;
    for (const found of statText.matchAll(pattern)) sum += parseInt(found[1], 10);
    return sum;
  };
  return {
    files: total(/(\d+)\s+files?\s+changed/g),
    insertions: total(/(\d+)\s+insertions?\(\+\)/g),
    deletions: total(/(\d+)\s+deletions?\(-\)/g),
  };
}

export function isEmpty(diff) {
  return diff.body.trim().length === 0 && diff.untracked.length === 0;
}

// A new file that git does not track yet is still this turn's work; `git diff`
// alone never shows it.
function untrackedNote(untracked) {
  if (untracked.length === 0) return '';
  const shown = untracked.slice(0, 5).join(', ');
  const rest = untracked.length > 5 ? `, +${untracked.length - 5} more` : '';
  return ` New untracked files: ${shown}${rest}.`;
}

export function summarize(diff, reasonKind) {
  const stats = parseStat(diff.statText);
  const detected = detectSignalsInDiff(diff.body);
  const signals = detected.length > 0 ? detected : ['stable_success_plateau'];
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
    .update(diff.body)
    .update('\0')
    .update((diff.untrackedMarks ?? diff.untracked).join('\n'))
    .digest('hex');
}

export function appendEvolutionLog(line) {
  try {
    const dir = process.env.EVOLVER_HOOK_LOG_DIR || path.join(os.homedir(), '.evolver', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'evolution.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // best effort
  }
}

// Field shape is a hard contract shared with the @evomap/evolver engine and the
// sibling Claude Code plugin — keep it exact.
function buildEntry(outcome, projectDir) {
  return {
    timestamp: new Date().toISOString(),
    gene_id: 'ad_hoc',
    signals: outcome.signals,
    outcome: { status: outcome.status, score: outcome.score, note: outcome.note },
    cwd: projectDir,
    workspace_id: resolveWorkspaceId(projectDir),
    source: 'dsh:turn-end',
  };
}

async function recordToHub(outcome) {
  const hubUrl = process.env.EVOMAP_HUB_URL || process.env.A2A_HUB_URL;
  const apiKey = process.env.EVOMAP_API_KEY || process.env.A2A_NODE_SECRET;
  if (!hubUrl || !apiKey) return false;

  try {
    const response = await fetch(`${hubUrl.replace(/\/+$/, '')}/a2a/evolution/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        gene_id: 'ad_hoc',
        signals: outcome.signals,
        status: outcome.status,
        score: outcome.score,
        summary: outcome.note,
        sender_id: process.env.EVOMAP_NODE_ID || process.env.A2A_NODE_ID,
      }),
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// One turn's work is one outcome. Without this, a workspace whose tree stays
// dirty records the same diff to the graph and to the Hub again on every turn
// end — and on disk, not just in memory, because a one-shot run is a whole
// process per turn.
function readLastFingerprint(projectDir) {
  try {
    return JSON.parse(fs.readFileSync(captureStatePath(projectDir), 'utf8')).fingerprint ?? null;
  } catch {
    return null;
  }
}

function writeLastFingerprint(projectDir, mark) {
  const statePath = captureStatePath(projectDir);
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ fingerprint: mark }), { mode: 0o600 });
  } catch {
    // an unwritable state file costs a duplicate, not a crash
  }
}

export function forgetCaptures(projectDir) {
  try {
    fs.rmSync(captureStatePath(projectDir), { force: true });
  } catch {
    // best effort
  }
}

// Turn-end capture is fire-and-forget, so two turns can overlap. Both would
// read the same fingerprint while the first is still awaiting the Hub, and both
// would record. One workspace captures one at a time.
const inFlight = new Map();

export function captureOutcome(projectDir, reasonKind = 'completed') {
  const queued = (inFlight.get(projectDir) ?? Promise.resolve())
    .catch(() => {})
    .then(() => captureNow(projectDir, reasonKind));

  const settled = queued.catch(() => {}).finally(() => {
    if (inFlight.get(projectDir) === settled) inFlight.delete(projectDir);
  });
  inFlight.set(projectDir, settled);
  return queued;
}

async function captureNow(projectDir, reasonKind) {
  const diff = await collectDiff(projectDir);
  if (isEmpty(diff)) {
    const reason = diff.isRepo ? 'no changes detected this turn' : 'not a git workspace';
    appendEvolutionLog(`[Evolution] Turn end: nothing recorded (${reason}).`);
    return null;
  }

  const mark = fingerprint(diff, reasonKind);
  if (readLastFingerprint(projectDir) === mark) {
    appendEvolutionLog('[Evolution] Turn end: nothing recorded (unchanged since the last capture).');
    return null;
  }

  const outcome = summarize(diff, reasonKind);
  const hubOk = await recordToHub(outcome);
  const localOk = appendMemoryGraph(projectDir, buildEntry(outcome, projectDir));
  // Only a recorded outcome closes this diff: marking it first would let a
  // failed write turn one lost outcome into a permanently skipped tree.
  if (hubOk || localOk) writeLastFingerprint(projectDir, mark);

  const destination = hubOk ? 'Hub' : localOk ? 'local memory' : 'nowhere (no Hub or local path)';
  const receipt = `[Evolution] Turn outcome recorded to ${destination}: ${outcome.note}`;
  appendEvolutionLog(receipt);
  return receipt;
}
