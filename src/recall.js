// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import fs from 'node:fs';

import { findMemoryGraph, resolveProjectDir, resolveWorkspaceId } from './workspace.js';

const MAX_SCAN_ENTRIES = 5;
const MAX_RESULTS = 3;
const MIN_SCORE = 0.5;
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LINE_MAX = 200;

function timestampMs(entry) {
  return entry && typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
}

export function filterRelevant(entries, now = Date.now()) {
  if (!Array.isArray(entries)) return [];

  const cutoff = now - RECENT_WINDOW_MS;
  const relevant = entries.filter((entry) => {
    const outcome = entry?.outcome;
    if (!outcome || outcome.status !== 'success') return false;
    if (typeof outcome.score !== 'number' || outcome.score < MIN_SCORE) return false;
    const ts = timestampMs(entry);
    return !Number.isNaN(ts) && ts >= cutoff && ts <= now;
  });

  return relevant.slice(-MAX_RESULTS);
}

export function belongsToWorkspace(entry, currentId, currentDir) {
  if (entry && typeof entry.workspace_id === 'string' && entry.workspace_id) {
    // Our own id is unresolvable: fall back to cwd rather than leaking a shared
    // graph's foreign workspaces into this session.
    if (currentId === null || currentId === undefined) {
      if (typeof entry.cwd === 'string' && entry.cwd) {
        return currentDir ? entry.cwd === currentDir : false;
      }
      return !currentDir;
    }
    return entry.workspace_id === currentId;
  }
  if (entry && typeof entry.cwd === 'string' && entry.cwd) {
    return currentDir ? entry.cwd === currentDir : true;
  }
  return true;
}

function gatherWorkspaceEntries(graphPath, currentId, currentDir) {
  let content;
  try {
    content = fs.readFileSync(graphPath, 'utf8');
  } catch {
    return [];
  }

  const lines = content.split('\n');
  const collected = [];
  for (let i = lines.length - 1; i >= 0 && collected.length < MAX_SCAN_ENTRIES; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (belongsToWorkspace(entry, currentId, currentDir)) collected.push(entry);
  }

  return collected.reverse();
}

export function formatSummary(outcomes) {
  const successes = outcomes.filter((entry) => entry.outcome?.status === 'success').length;
  const failures = outcomes.filter((entry) => entry.outcome?.status === 'failed').length;
  const header = `[Evolution Memory] Recent ${outcomes.length} outcomes (${successes} success, ${failures} failed):`;

  const rows = outcomes.map((entry) => {
    const outcome = entry.outcome || {};
    const icon = outcome.status === 'success' ? '+' : outcome.status === 'failed' ? '-' : '?';
    const date = typeof entry.timestamp === 'string' ? entry.timestamp.slice(0, 10) : '??????????';
    const score = typeof outcome.score === 'number' ? outcome.score : '?';
    const signals = Array.isArray(entry.signals) ? entry.signals.slice(0, 3).join(', ') : '';
    const note = typeof outcome.note === 'string' ? outcome.note : '';
    return `[${icon}] ${date} score=${score} signals=[${signals}] ${note}`.slice(0, LINE_MAX);
  });

  return `${[header, ...rows].join('\n')}\n\nUse successful approaches. Avoid repeating failed patterns.`;
}

export function recallText(projectDir = resolveProjectDir()) {
  try {
    const entries = gatherWorkspaceEntries(
      findMemoryGraph(projectDir),
      resolveWorkspaceId(projectDir),
      projectDir,
    );
    const relevant = filterRelevant(entries);
    return relevant.length > 0 ? formatSummary(relevant) : '';
  } catch {
    return '';
  }
}
