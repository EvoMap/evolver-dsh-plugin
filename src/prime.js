// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

const SEARCH_LIMIT = 5;
const FETCH_LIMIT = 3;
const MIN_PROMPT_CHARS = 8;
const PROMPT_MAX_CHARS = 400;
const STEP_MAX_CHARS = 400;
const DEFAULT_MIN_SIMILARITY = 0.3;
const UNSCORED = -1;
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

function fetchedById(data) {
  const found = [data?.assets, data?.results, data?.payload?.results].find(Array.isArray) ?? [];
  return new Map(found.filter((asset) => asset?.asset_id).map((asset) => [asset.asset_id, asset]));
}

function similarityOf(hit) {
  return typeof hit.similarity === 'number' ? hit.similarity : UNSCORED;
}

// Two things disqualify a hit before it costs a fetch, and the search result
// reports both: no strategy to reuse, and a similarity that says the Hub
// matched a topic rather than this task. The floor is low because the score
// swings with phrasing — the same React question scored 0.88 asked one way and
// 0.40 asked another, while boilerplate and off-topic hits sit at 0.19–0.22.
// They rank by score rather than by the order the Hub listed them in, since
// that order is the Hub's own ranking and weighs more than this prompt.
function rankedCandidates(hits, listedIds, minSimilarity) {
  return hits
    .filter((hit) => !listedIds.has(hit.asset_id))
    .filter((hit) => hit.has_strategy !== false)
    .filter((hit) => typeof hit.similarity !== 'number' || hit.similarity >= minSimilarity)
    .sort((left, right) => similarityOf(right) - similarityOf(left))
    .slice(0, FETCH_LIMIT);
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
export async function hubGene(proxyFetch, text, { signal, listedIds = new Set(), minSimilarity = DEFAULT_MIN_SIMILARITY } = {}) {
  if (text.length < MIN_PROMPT_CHARS) return EMPTY_MATCH;

  const found = await proxyJson(proxyFetch, '/asset/search', { text, limit: SEARCH_LIMIT }, signal);
  if (!found) return EMPTY_MATCH;

  const candidates = rankedCandidates(searchHits(found), listedIds, minSimilarity);
  if (candidates.length === 0) return EMPTY_MATCH;

  // The closest hit is often one this node cannot materialise — the Hub returns
  // it under `missing` — so the leading candidates are fetched together in the
  // one round trip the endpoint already allows, and the best one that actually
  // came back is used. The Hub resolves them one by one, so the list is short.
  const fetched = await proxyJson(
    proxyFetch,
    '/asset/fetch',
    { asset_ids: candidates.map((hit) => hit.asset_id) },
    signal,
  );
  if (!fetched) return EMPTY_MATCH;

  const byId = fetchedById(fetched);
  for (const candidate of candidates) {
    const steps = strategySteps(byId.get(candidate.asset_id));
    if (steps.length === 0) continue;

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
  return EMPTY_MATCH;
}
