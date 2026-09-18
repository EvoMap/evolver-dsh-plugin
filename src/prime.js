// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

const SEARCH_LIMIT = 5;
const MIN_PROMPT_CHARS = 8;
const PROMPT_MAX_CHARS = 400;
const STEP_MAX_CHARS = 400;
const EMPTY_MATCH = { ids: [], text: '' };

function strategySteps(asset) {
  const steps = asset?.strategy ?? asset?.payload?.strategy ?? asset?.gene?.strategy;
  const list = Array.isArray(steps) ? steps : [steps];
  return list
    .filter((step) => typeof step === 'string' && step.trim())
    .map((step) => step.trim().slice(0, STEP_MAX_CHARS));
}

// A step's batch also carries dsh's own injections — the runtime-context
// snapshot and the skill catalog — and searching with those drowns the task in
// boilerplate, so only what the person typed is matched against.
export function promptTextOf(messages) {
  const parts = [];
  for (const message of messages ?? []) {
    if (message?.source?.kind !== 'user') continue;
    for (const block of message?.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) parts.push(block.text.trim());
    }
  }
  return parts.join('\n').trim().slice(0, PROMPT_MAX_CHARS);
}

function searchHits(data) {
  const found = [data?.results, data?.assets, data?.payload?.results].find(Array.isArray) ?? [];
  return found.filter((hit) => hit && typeof hit.asset_id === 'string' && hit.asset_id);
}

function fetchedAsset(data, assetId) {
  const found = [data?.assets, data?.results, data?.payload?.results].find(Array.isArray) ?? [];
  return found.find((asset) => asset?.asset_id === assetId) ?? found[0] ?? null;
}

// A hit without a strategy carries nothing the model can act on, and the search
// result says so before the fetch costs a round trip.
function bestCandidate(hits, listedIds) {
  const fresh = hits.filter((hit) => !listedIds.has(hit.asset_id));
  return fresh.find((hit) => hit.has_strategy === true) ?? fresh.find((hit) => hit.has_strategy === undefined) ?? null;
}

async function proxyJson(proxyFetch, path, body, signal) {
  try {
    const result = await proxyFetch('POST', path, body, signal);
    return result?.ok ? result.data : null;
  } catch {
    return null;
  }
}

// Priming sits on the critical path of every answer: an unreachable Proxy, a
// slow Hub, or a malformed body must cost the turn nothing but the deadline.
// One asset's strategy is injected and nothing else — a summary only tells the
// model that something exists, while the steps are what it can actually reuse.
export async function hubGene(proxyFetch, text, { signal, listedIds = new Set() } = {}) {
  if (text.length < MIN_PROMPT_CHARS) return EMPTY_MATCH;

  const found = await proxyJson(proxyFetch, '/asset/search', { text, limit: SEARCH_LIMIT }, signal);
  if (!found) return EMPTY_MATCH;

  const candidate = bestCandidate(searchHits(found), listedIds);
  if (!candidate) return EMPTY_MATCH;

  const fetched = await proxyJson(proxyFetch, '/asset/fetch', { asset_ids: [candidate.asset_id] }, signal);
  const steps = strategySteps(fetched && fetchedAsset(fetched, candidate.asset_id));
  if (steps.length === 0) return EMPTY_MATCH;

  const source = found.degraded === true ? 'local cache, the Hub was unavailable' : 'EvoMap network';
  return {
    ids: [candidate.asset_id],
    text: [
      `[Evolution Memory] Strategy reused from ${candidate.asset_type ?? 'Gene'} ${candidate.asset_id} (${source}):`,
      ...steps.map((step, index) => `${index + 1}. ${step}`),
      '',
      'Apply it where it fits, then report the outcome with evolver_asset_reuse_result.',
    ].join('\n'),
  };
}
