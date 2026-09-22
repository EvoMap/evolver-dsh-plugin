// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// An automatic report is weaker evidence than one the model made after
// validating its own work: the strategy was put in front of the model, but
// nothing proves it was followed. The reason says so, so the Hub can weigh it
// against a reported reuse rather than mistaking it for one.
function automaticReason(turn, reasonKind) {
  return `Injected by Evolver into dsh turn ${turn}; not confirmed as applied. `
    + `Outcome derived from how the turn ended (${reasonKind}).`;
}

export async function reportInjectedReuse(proxyFetch, options) {
  const { assetIds, outcome, turn, reasonKind, sessionId, signal } = options;
  if (!outcome || assetIds.length === 0) return [];

  const reported = [];
  for (const assetId of assetIds) {
    try {
      const result = await proxyFetch('POST', '/asset/reuse-result', {
        asset_id: assetId,
        outcome: outcome.status,
        reason: automaticReason(turn, reasonKind),
        task_id: sessionId ? `${sessionId}:${turn}` : undefined,
      }, signal);
      if (result?.ok) reported.push(assetId);
    } catch {
    }
  }
  return reported;
}
