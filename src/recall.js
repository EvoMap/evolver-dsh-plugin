// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import fs from 'node:fs';

import {
  findMemoryGraph,
  isProjectMemoryGraph,
  resolveProjectDir,
  resolveWorkspaceId,
} from './workspace.js';

const DEFAULT_MAX_RESULTS = 3;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const MIN_SUCCESS_SCORE = 0.5;
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LINE_MAX = 200;

function timestampMs(entry) {
  return entry && typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
}

function isRelevant(entry, now) {
  const outcome = entry?.outcome;
  if (!outcome || !['success', 'failed'].includes(outcome.status)) return false;
  if (outcome.status === 'success' && (typeof outcome.score !== 'number' || outcome.score < MIN_SUCCESS_SCORE)) {
    return false;
  }
  const timestamp = timestampMs(entry);
  return !Number.isNaN(timestamp) && timestamp >= now - RECENT_WINDOW_MS && timestamp <= now;
}

export function filterRelevant(entries, now = Date.now(), maxResults = DEFAULT_MAX_RESULTS) {
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry) => isRelevant(entry, now)).slice(-maxResults);
}

export function belongsToWorkspace(entry, currentId, currentDir, { allowLegacy = true } = {}) {
  if (entry && typeof entry.workspace_id === 'string' && entry.workspace_id) {
    if (currentId === null || currentId === undefined) {
      if (typeof entry.cwd === 'string' && entry.cwd) {
        return currentDir ? entry.cwd === currentDir : false;
      }
      return false;
    }
    return entry.workspace_id === currentId;
  }
  if (entry && typeof entry.cwd === 'string' && entry.cwd) {
    return currentDir ? entry.cwd === currentDir : false;
  }
  return allowLegacy;
}

function readGraphTail(graphPath, maxBytes) {
  let descriptor;
  try {
    descriptor = fs.openSync(graphPath, 'r');
    const stat = fs.fstatSync(descriptor);
    const length = Math.min(stat.size, maxBytes);
    const offset = Math.max(0, stat.size - length);
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(descriptor, buffer, 0, length, offset);
    let content = buffer.subarray(0, bytesRead).toString('utf8');
    if (offset > 0) {
      const firstNewline = content.indexOf('\n');
      content = firstNewline >= 0 ? content.slice(firstNewline + 1) : '';
    }
    return content;
  } catch {
    return '';
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
      }
    }
  }
}

function gatherWorkspaceEntries(graphPath, currentId, currentDir, options = {}) {
  const {
    allowLegacy = true,
    maxResults = DEFAULT_MAX_RESULTS,
    maxBytes = DEFAULT_MAX_BYTES,
    now = Date.now(),
  } = options;
  const content = readGraphTail(graphPath, maxBytes);
  if (!content) return [];

  const lines = content.split('\n');
  const collected = [];
  for (let index = lines.length - 1; index >= 0 && collected.length < maxResults; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!belongsToWorkspace(entry, currentId, currentDir, { allowLegacy })) continue;
    if (isRelevant(entry, now)) collected.push(entry);
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

export function recallText(projectDir = resolveProjectDir(), options = {}) {
  try {
    const graphPath = findMemoryGraph(projectDir);
    const entries = gatherWorkspaceEntries(
      graphPath,
      resolveWorkspaceId(projectDir),
      projectDir,
      {
        allowLegacy: isProjectMemoryGraph(projectDir, graphPath),
        maxResults: options.maxResults ?? DEFAULT_MAX_RESULTS,
        maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
        now: options.now,
      },
    );
    return entries.length > 0 ? formatSummary(entries) : '';
  } catch {
    return '';
  }
}
