// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENTRY_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

// The Hub aggregates reuse per asset id and counts every report it receives:
// `summarizeReuseOutcomes` keys on assetId alone and increments, with no
// de-duplication anywhere upstream. Exactly-once is therefore this file's job,
// and the asset id is the only key that means anything — a task id is neither
// an aggregation key nor one of the audit anchors (assetId + cycleId).
function storePath(sessionKey) {
  const key = crypto.createHash('sha256').update(String(sessionKey)).digest('hex').slice(0, 16);
  return path.join(os.homedir(), '.evolver', 'state', `injected-${key}.json`);
}

function readStore(sessionKey) {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(sessionKey), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(sessionKey, store) {
  const target = storePath(sessionKey);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(store), { mode: 0o600, flag: 'wx' });
    try {
      fs.renameSync(temporary, target);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      fs.rmSync(target, { force: true });
      fs.renameSync(temporary, target);
    }
  } catch {
  }
}

function pruned(store, now) {
  const kept = {};
  for (const [assetId, entry] of Object.entries(store)) {
    const at = Number(entry?.injectedAt);
    if (Number.isFinite(at) && now - at <= ENTRY_PRUNE_MS) kept[assetId] = entry;
  }
  return kept;
}

function mutate(sessionKey, change, now = Date.now()) {
  if (!sessionKey) return;
  const store = pruned(readStore(sessionKey), now);
  if (change(store) === false) return;
  writeStore(sessionKey, store);
}

// An injected id is written before the turn it belongs to can end, so a report
// survives the process dying between the two — and a lookup that lands late
// records itself the same way, from whatever step it arrived in.
export function rememberInjected(sessionKey, assetId, turn, now = Date.now()) {
  mutate(sessionKey, (store) => {
    if (store[assetId]) return false;
    store[assetId] = { turn, injectedAt: now };
  }, now);
}

export function unreportedAssets(sessionKey) {
  return Object.entries(readStore(sessionKey))
    .filter(([, entry]) => !entry?.outcome)
    .map(([assetId, entry]) => ({ assetId, turn: Number(entry?.turn) }));
}

// A correction can only revise a verdict this plugin actually sent, and only
// once: the Hub counts each report, so a second correction would be a second
// negative for one reuse.
export function correctableAssets(sessionKey) {
  return Object.entries(readStore(sessionKey))
    .filter(([, entry]) => entry?.outcome === 'success' && !entry?.corrected)
    .map(([assetId, entry]) => ({ assetId, turn: Number(entry?.turn) }));
}

export function markReported(sessionKey, assetId, outcome, now = Date.now()) {
  mutate(sessionKey, (store) => {
    const entry = store[assetId] ?? { turn: 0, injectedAt: now };
    if (entry.outcome) return false;
    store[assetId] = { ...entry, outcome, reportedAt: now };
  }, now);
}

export function markCorrected(sessionKey, assetId, now = Date.now()) {
  mutate(sessionKey, (store) => {
    const entry = store[assetId];
    if (!entry || entry.corrected) return false;
    store[assetId] = { ...entry, corrected: true, correctedAt: now };
  }, now);
}

export function forgetSession(sessionKey) {
  if (!sessionKey) return;
  try {
    fs.rmSync(storePath(sessionKey), { force: true });
  } catch {
  }
}
