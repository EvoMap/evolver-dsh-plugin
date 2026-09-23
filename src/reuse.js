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

function correctionReason(turn) {
  return `Revising the automatic verdict for dsh turn ${turn}: the next prompt `
    + 'in the same session read as a correction, so the earlier reuse did not hold.';
}

// The asset id is the whole address. `summarizeReuseOutcomes` aggregates on it
// alone, and `deriveReuseEntries` anchors an accountable entry on assetId plus
// the cycle id the Proxy mints — a task id is neither, so sending one only
// decorates a report that is already keyed correctly.
async function postOutcome(proxyFetch, { assetId, outcome, reason, signal }) {
  try {
    const result = await proxyFetch('POST', '/asset/reuse-result', { asset_id: assetId, outcome, reason }, signal);
    return result?.ok === true;
  } catch {
    return false;
  }
}

export async function reportInjectedReuse(proxyFetch, options) {
  const { assetIds, outcome, turn, reasonKind, signal, onReported } = options;
  if (!outcome || assetIds.length === 0) return [];

  const reported = [];
  for (const assetId of assetIds) {
    if (!await postOutcome(proxyFetch, { assetId, outcome: outcome.status, reason: automaticReason(turn, reasonKind), signal })) continue;
    reported.push(assetId);
    onReported?.(assetId, outcome.status);
  }
  return reported;
}

export async function reportReuseCorrection(proxyFetch, options) {
  const { assets, signal, onCorrected } = options;
  const corrected = [];
  for (const { assetId, turn } of assets) {
    if (!await postOutcome(proxyFetch, { assetId, outcome: 'failed', reason: correctionReason(turn), signal })) continue;
    corrected.push(assetId);
    onCorrected?.(assetId);
  }
  return corrected;
}
