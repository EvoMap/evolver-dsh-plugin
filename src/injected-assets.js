// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import fs from 'node:fs';
import path from 'node:path';

import { ownerIsGone } from './process-owner.js';
import { hashedName, readState, removeState, statePath, writeState } from './state-file.js';

const ENTRY_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

function pruned(ledger, now) {
  return Object.fromEntries(Object.entries(ledger ?? {}).filter(([, entry]) => {
    const at = Number(entry?.injectedAt);
    return Number.isFinite(at) && now - at <= ENTRY_PRUNE_MS;
  }));
}

export function withInjected(ledger, assetId, { turn, strategyText, sessionId, pid }, now) {
  const kept = pruned(ledger, now);
  if (kept[assetId]) return kept;
  return { ...kept, [assetId]: { turn, injectedAt: now, strategyText, sessionId, pid } };
}

export function unreportedOf(ledger, turn) {
  return Object.entries(ledger ?? {})
    .filter(([, entry]) => !entry?.reportedAt && Number(entry?.turn) <= turn)
    .map(([assetId, entry]) => ({ assetId, strategyText: entry.strategyText ?? '', turn: entry.turn, sessionId: entry.sessionId }));
}

export function withReported(ledger, assetIds, now) {
  const kept = pruned(ledger, now);
  for (const assetId of assetIds) if (kept[assetId]) kept[assetId] = { ...kept[assetId], reportedAt: now };
  return kept;
}

const LEDGER_PREFIX = 'injected';
const ledgerPath = (sessionKey) => statePath(hashedName(LEDGER_PREFIX, sessionKey));

export function rememberInjected(sessionKey, assetId, injection, now = Date.now()) {
  if (!sessionKey) return;
  writeState(ledgerPath(sessionKey), withInjected(readState(ledgerPath(sessionKey), {}), assetId, { ...injection, sessionId: sessionKey, pid: process.pid }, now));
}

export function takeUnreported(sessionKey, turn, now = Date.now()) {
  if (!sessionKey) return [];
  const ledger = readState(ledgerPath(sessionKey), {});
  const due = unreportedOf(ledger, turn);
  if (due.length > 0) writeState(ledgerPath(sessionKey), withReported(ledger, due.map((asset) => asset.assetId), now));
  return due;
}

/**
 * Injections no turn end ever reported, from sessions whose dsh process is gone: a process killed mid-turn (a
 * harness timeout, a closed terminal) leaves them behind. They are taken, marked reported and returned for an
 * aborted report. A session that is merely idle keeps its open injections.
 */
export function takeOrphanedUnreported({ isGone = ownerIsGone, now = Date.now() } = {}) {
  const dir = path.dirname(statePath('x'));
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((file) => file.startsWith(`${LEDGER_PREFIX}-`) && file.endsWith('.json'));
  } catch {
    return [];
  }
  const orphaned = [];
  for (const file of files) {
    const target = path.join(dir, file);
    const ledger = readState(target, {});
    const due = Object.entries(ledger)
      .filter(([, entry]) => !entry?.reportedAt && entry?.sessionId && isGone(entry.pid))
      .map(([assetId, entry]) => ({ assetId, strategyText: entry.strategyText ?? '', turn: entry.turn, sessionId: entry.sessionId }));
    if (due.length === 0) continue;
    writeState(target, withReported(ledger, due.map((asset) => asset.assetId), now));
    orphaned.push(...due);
  }
  return orphaned;
}

export function forgetSession(sessionKey) {
  if (sessionKey) removeState(ledgerPath(sessionKey));
}
