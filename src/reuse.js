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

// The asset id is what the report is about — `summarizeReuseOutcomes`
// aggregates on it alone. The task id is something else: the Hub hashes it with
// the asset and the reporting node into the event id that makes a retry
// idempotent, and its schema requires one, so a report without it is rejected
// with 400 and reaches no Hub ledger at all. One id per turn per session means
// re-sending the same verdict is recognised, while a later correction carries
// its own and is not mistaken for that retry.
// `ok` only says the Proxy answered. The Proxy forwards to the Hub and reports
// the real fate in the body. Treating the transport as the outcome would mark
// an asset reported that no ledger ever saw, and the on-disk record would make
// that mistake permanent.
async function postToHub(proxyFetch, { assetId, outcome, reason, taskId, signal }) {
  try {
    const result = await proxyFetch('POST', '/asset/reuse-result', { asset_id: assetId, outcome, reason, task_id: taskId }, signal);
    return result?.ok === true && result.data?.recorded !== false;
  } catch {
    return false;
  }
}

function reportId(sessionId, turn) {
  return `dsh:${sessionId || 'unknown'}:${turn ?? 'unknown'}`;
}

// The local root_event is the half that pays off today: the actuator that
// re-orders candidates reads root_events, not the Hub. A verdict counts as
// delivered when either ledger took it, so one of them being down does not
// keep the asset pending forever.
async function postOutcome(proxyFetch, { assetId, outcome, reason, taskId, sessionId, signal }) {
  const hub = await postToHub(proxyFetch, { assetId, outcome, reason, taskId, signal });
  const local = await recordReuseLocally({ assetId, outcome, sessionId });
  return hub || local;
}

export async function reportInjectedReuse(proxyFetch, options) {
  const { assetIds, outcome, turn, reasonKind, sessionId, signal, onReported } = options;
  if (!outcome || assetIds.length === 0) return [];

  const reported = [];
  for (const assetId of assetIds) {
    if (!await postOutcome(proxyFetch, { assetId, outcome: outcome.status, reason: automaticReason(turn, reasonKind), taskId: reportId(sessionId, turn), sessionId, signal })) continue;
    reported.push(assetId);
    onReported?.(assetId, outcome.status);
  }
  return reported;
}

export async function reportReuseCorrection(proxyFetch, options) {
  const { assets, sessionId, signal, onCorrected } = options;
  const corrected = [];
  for (const { assetId, turn } of assets) {
    if (!await postOutcome(proxyFetch, { assetId, outcome: 'failed', reason: correctionReason(turn), taskId: `${reportId(sessionId, turn)}:correction`, sessionId, signal })) continue;
    corrected.push(assetId);
    onCorrected?.(assetId);
  }
  return corrected;
}
