// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

const SEARCH_LIMIT = 3;
const MIN_PROMPT_CHARS = 8;
const PROMPT_MAX_CHARS = 400;
const SUMMARY_MAX_CHARS = 240;
const EMPTY_MATCHES = { ids: [], text: '' };

export function promptTextOf(messages) {
  const parts = [];
  for (const message of messages ?? []) {
    if (message?.source?.kind === 'plugin') continue;
    for (const block of message?.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) parts.push(block.text.trim());
    }
  }
  return parts.join('\n').trim().slice(0, PROMPT_MAX_CHARS);
}

function searchHits(data) {
  const found = [data?.assets, data?.results, data?.payload?.results].find(Array.isArray) ?? [];
  return found.filter((hit) => hit && typeof hit.asset_id === 'string' && hit.asset_id);
}

function hitLine(hit) {
  const label = `${hit.type ?? 'Asset'} ${hit.asset_id}`;
  const summary = typeof hit.summary === 'string' ? hit.summary.trim().slice(0, SUMMARY_MAX_CHARS) : '';
  return summary ? `- ${label} — ${summary}` : `- ${label}`;
}

// Priming sits on the critical path of every answer: an unreachable Proxy, a
// slow Hub, or a malformed body must cost the turn nothing but the deadline.
export async function hubMatches(proxyFetch, text, { signal, listedIds = new Set() } = {}) {
  if (text.length < MIN_PROMPT_CHARS) return EMPTY_MATCHES;

  let result;
  try {
    result = await proxyFetch('POST', '/asset/search', { text, limit: SEARCH_LIMIT }, signal);
  } catch {
    return EMPTY_MATCHES;
  }
  if (!result?.ok) return EMPTY_MATCHES;

  const hits = searchHits(result.data)
    .filter((hit) => !listedIds.has(hit.asset_id))
    .slice(0, SEARCH_LIMIT);
  if (hits.length === 0) return EMPTY_MATCHES;

  const source = result.data?.degraded === true
    ? 'local cache (the Hub was unavailable)'
    : 'EvoMap network';
  return {
    ids: hits.map((hit) => hit.asset_id),
    text: [
      hits.length === 1
        ? `[Evolution Memory] 1 reusable asset matches this task, from the ${source}:`
        : `[Evolution Memory] ${hits.length} reusable assets match this task, from the ${source}:`,
      ...hits.map(hitLine),
      '',
      'Fetch the ones worth reusing with evolver_fetch_asset, then report the verified outcome with evolver_asset_reuse_result.',
    ].join('\n'),
  };
}
