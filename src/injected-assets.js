// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { hashedName, readState, removeState, statePath, writeState } from './state-file.js';

const ENTRY_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

function pruned(ledger, now) {
  return Object.fromEntries(Object.entries(ledger ?? {}).filter(([, entry]) => {
    const at = Number(entry?.injectedAt);
    return Number.isFinite(at) && now - at <= ENTRY_PRUNE_MS;
  }));
}

export function withInjected(ledger, assetId, { turn, strategyText }, now) {
  const kept = pruned(ledger, now);
  if (kept[assetId]) return kept;
  return { ...kept, [assetId]: { turn, injectedAt: now, strategyText } };
}

export function unreportedOf(ledger, turn) {
  return Object.entries(ledger ?? {})
    .filter(([, entry]) => !entry?.reportedAt && Number(entry?.turn) <= turn)
    .map(([assetId, entry]) => ({ assetId, strategyText: entry.strategyText ?? '' }));
}

export function withReported(ledger, assetIds, now) {
  const kept = pruned(ledger, now);
  for (const assetId of assetIds) if (kept[assetId]) kept[assetId] = { ...kept[assetId], reportedAt: now };
  return kept;
}

const ledgerPath = (sessionKey) => statePath(hashedName('injected', sessionKey));

export function rememberInjected(sessionKey, assetId, injection, now = Date.now()) {
  if (!sessionKey) return;
  writeState(ledgerPath(sessionKey), withInjected(readState(ledgerPath(sessionKey), {}), assetId, injection, now));
}

export function takeUnreported(sessionKey, turn, now = Date.now()) {
  if (!sessionKey) return [];
  const ledger = readState(ledgerPath(sessionKey), {});
  const due = unreportedOf(ledger, turn);
  if (due.length > 0) writeState(ledgerPath(sessionKey), withReported(ledger, due.map((asset) => asset.assetId), now));
  return due;
}

export function forgetSession(sessionKey) {
  if (sessionKey) removeState(ledgerPath(sessionKey));
}
