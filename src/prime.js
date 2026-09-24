// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// One round trip, not two: since evolver 2.0.39 `/asset/fetch` recalls by text
// when it is given no ids, so selecting a candidate and materialising it are the
// same call. The pair it replaces had to buy its second hop out of the wait
// budget, and that budget only ever afforded two candidates; a recall returns
// whole assets, so this limit is about how many the Hub should rank, not about
// what the step can afford to wait for.
const RECALL_LIMIT = 5;
const MIN_PROMPT_CHARS = 8;
const PROMPT_MAX_CHARS = 400;
const STEP_MAX_CHARS = 400;
const TITLE_MAX_CHARS = 80;
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

function recalledAssets(data) {
  const found = [data?.assets, data?.results, data?.payload?.results].find(Array.isArray) ?? [];
  return found.filter((asset) => asset && typeof asset.asset_id === 'string' && asset.asset_id);
}

const CJK_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const MIN_CJK_TITLE_CHARS = 5;

function trimmedText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

// A Hub short_title is sometimes a truncated fragment: `Object`, `自动化小`.
// Character count cannot separate those from a good title, because `智能缓存优化`
// says as much in six characters as a Latin title says in forty.
function looksLikeAName(text) {
  if (!text) return false;
  if (CJK_SCRIPT.test(text)) return [...text].length >= MIN_CJK_TITLE_CHARS;
  return /\s/.test(text);
}

function readableNameOf(asset) {
  const title = trimmedText(asset?.short_title);
  if (looksLikeAName(title)) return title.slice(0, TITLE_MAX_CHARS);
  const described = trimmedText(asset?.nl_summary) || trimmedText(asset?.summary);
  if (described) return described.slice(0, TITLE_MAX_CHARS);
  return title || asset?.asset_type || asset?.type || 'Gene';
}

function similarityOf(asset) {
  return typeof asset.similarity === 'number' ? asset.similarity : UNSCORED;
}

// Recall hands back whole assets, so having a strategy is read off the asset
// itself rather than trusted from a search flag. What is left to judge is the
// score, and it is only advisory: it swings with phrasing — the same React
// question scored 0.88 asked one way and 0.40 asked another, while boilerplate
// and off-topic hits sit at 0.19–0.22 — and a Proxy that reports none at all
// must not be filtered down to nothing. They rank by score rather than by the
// order the Hub listed them in, since that order weighs more than this prompt.
function rankedCandidates(assets, listedIds, minSimilarity) {
  return assets
    .filter((asset) => !listedIds.has(asset.asset_id))
    .filter((asset) => typeof asset.similarity !== 'number' || asset.similarity >= minSimilarity)
    .sort((left, right) => similarityOf(right) - similarityOf(left));
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

  const recalled = await proxyJson(proxyFetch, '/asset/fetch', { text, limit: RECALL_LIMIT }, signal);
  if (!recalled) return EMPTY_MATCH;

  for (const candidate of rankedCandidates(recalledAssets(recalled), listedIds, minSimilarity)) {
    const steps = strategySteps(candidate);
    if (steps.length === 0) continue;

    return {
      ids: [candidate.asset_id],
      text: [
        `[Evolution Memory] ${readableNameOf(candidate)} (EvoMap network):`,
        ...steps.map((step, index) => `${index + 1}. ${step}`),
        '',
        `Apply it where it fits, then report the outcome with evolver_asset_reuse_result for ${candidate.asset_id}.`,
      ].join('\n'),
    };
  }
  return EMPTY_MATCH;
}
