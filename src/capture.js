// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { detectSignals } from './signals.js';
import { findMemoryGraph, resolveWorkspaceId } from './workspace.js';

const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;
const HUB_TIMEOUT_MS = 8000;
const FAILURE_SIGNALS = ['log_error', 'test_failure'];
const SUCCESS_SCORE = 0.8;
const FAILURE_SCORE = 0.3;

function git(args, cwd) {
  try {
    const result = spawnSync('git', args, {
      cwd,
      shell: false,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      status: typeof result.status === 'number' ? result.status : 1,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
    };
  } catch {
    return { status: 1, stdout: '' };
  }
}

function gitDiff(args, projectDir) {
  const againstPrevious = git([...args, 'HEAD~1'], projectDir);
  return againstPrevious.status === 0 ? againstPrevious : git(args, projectDir);
}

export function collectDiff(projectDir) {
  const insideTree = git(['rev-parse', '--is-inside-work-tree'], projectDir);
  return {
    isRepo: insideTree.status === 0 && insideTree.stdout.trim() === 'true',
    statText: gitDiff(['diff', '--stat'], projectDir).stdout,
    body: gitDiff(['diff', '--no-color'], projectDir).stdout,
  };
}

export function parseStat(statText) {
  const match = (pattern) => {
    const found = statText.match(pattern);
    return found ? parseInt(found[1], 10) : 0;
  };
  return {
    files: match(/(\d+)\s+files?\s+changed/),
    insertions: match(/(\d+)\s+insertions?\(\+\)/),
    deletions: match(/(\d+)\s+deletions?\(-\)/),
  };
}

export function summarize(diff) {
  const stats = parseStat(diff.statText);
  const detected = detectSignals(diff.body);
  const signals = detected.length > 0 ? detected : ['stable_success_plateau'];
  const failed = signals.some((signal) => FAILURE_SIGNALS.includes(signal));

  return {
    signals,
    status: failed ? 'failed' : 'success',
    score: failed ? FAILURE_SCORE : SUCCESS_SCORE,
    note:
      `Turn end: ${stats.files} files changed, +${stats.insertions}/-${stats.deletions}. ` +
      `Signals: [${signals.join(', ')}]`,
  };
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

function recordToLocal(entry, projectDir) {
  try {
    const graphPath = findMemoryGraph(projectDir);
    fs.mkdirSync(path.dirname(graphPath), { recursive: true });
    fs.appendFileSync(graphPath, `${JSON.stringify(entry)}\n`);
    return true;
  } catch {
    return false;
  }
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

export async function captureOutcome(projectDir) {
  const diff = collectDiff(projectDir);
  if (diff.statText.trim().length === 0) {
    const reason = diff.isRepo ? 'no changes detected this turn' : 'not a git workspace';
    appendEvolutionLog(`[Evolution] Turn end: nothing recorded (${reason}).`);
    return null;
  }

  const outcome = summarize(diff);
  const hubOk = await recordToHub(outcome);
  const localOk = recordToLocal(buildEntry(outcome, projectDir), projectDir);

  const destination = hubOk ? 'Hub' : localOk ? 'local memory' : 'nowhere (no Hub or local path)';
  const receipt = `[Evolution] Turn outcome recorded to ${destination}: ${outcome.note}`;
  appendEvolutionLog(receipt);
  return receipt;
}
