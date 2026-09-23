// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { recordReuseLocally } from './local-ledger.js';

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
// `ok` only says the Proxy answered. The Proxy forwards to the Hub and reports
// the real fate in the body, and today that body reads `{recorded:false,
// reason:"hub 404"}` because no reuse-result route exists on the Hub. Treating
// the transport as the outcome would mark an asset reported that no ledger ever
// saw, and the on-disk record would make that mistake permanent.
async function postToHub(proxyFetch, { assetId, outcome, reason, signal }) {
  try {
    const result = await proxyFetch('POST', '/asset/reuse-result', { asset_id: assetId, outcome, reason }, signal);
    return result?.ok === true && result.data?.recorded !== false;
  } catch {
    return false;
  }
}

// The local root_event is the half that pays off today. The actuator that
// re-orders candidates reads root_events, not the Hub, and the Hub has no
// reuse-result route to read from anyway. A verdict counts as delivered when
// either ledger took it, so one of them being down does not keep the asset
// pending forever.
async function postOutcome(proxyFetch, { assetId, outcome, reason, sessionId, signal }) {
  const hub = await postToHub(proxyFetch, { assetId, outcome, reason, signal });
  const local = await recordReuseLocally({ assetId, outcome, sessionId });
  return hub || local;
}

export async function reportInjectedReuse(proxyFetch, options) {
  const { assetIds, outcome, turn, reasonKind, sessionId, signal, onReported } = options;
  if (!outcome || assetIds.length === 0) return [];

  const reported = [];
  for (const assetId of assetIds) {
    if (!await postOutcome(proxyFetch, { assetId, outcome: outcome.status, reason: automaticReason(turn, reasonKind), sessionId, signal })) continue;
    reported.push(assetId);
    onReported?.(assetId, outcome.status);
  }
  return reported;
}

export async function reportReuseCorrection(proxyFetch, options) {
  const { assets, sessionId, signal, onCorrected } = options;
  const corrected = [];
  for (const { assetId, turn } of assets) {
    if (!await postOutcome(proxyFetch, { assetId, outcome: 'failed', reason: correctionReason(turn), sessionId, signal })) continue;
    corrected.push(assetId);
    onCorrected?.(assetId);
  }
  return corrected;
}
