// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

const GATEWAY_URL = 'https://api.evomap.ai/v1';
// Not the agent's own model: in the benchmark that is deepseek-flash, which
// also grades the injected assets, so the judge here must be a different one.
const MODEL = 'gemini-3.5-flash';
export const API_KEY_ENV = 'EVOMAP_API_KEY';
export const TASK_MAX_CHARS = 6_000;
const VERIFY_TASK_MAX_CHARS = 4_000;
const QUERY_MAX_CHARS = 400;
const SUMMARY_MAX_CHARS = 600;
const TRIGGERS_MAX_CHARS = 400;
const MAX_TOKENS = 2_000;
const CALL_TIMEOUT_MS = 12_000;
// The gateway caps concurrent requests per key (429 concurrency_limit), and a
// review sends ten at once beside the agent's own calls on the same key.
const RETRY_DELAYS_MS = [1_000, 3_000];
const RETRY_AFTER_MAX_MS = 5_000;

// Both prompts are the ones the offline replay over the 499-task bank was
// measured with; rewording them invalidates that measurement.
const REWRITE_PROMPT = `Rewrite the task below into ONE search query for a library of reusable problem-solving playbooks.
Keep only what the task is about: the concrete problem, the domain, and the kind of data or system involved.
Drop role statements, file paths, tool or environment instructions, output-format and saving rules.
Write it in English, at most 200 characters. Answer with the query only.

## Task
{task}`;

const VERIFY_PROMPT = `An AI agent is about to work on the task below. A memory library offers it one stored playbook.
Decide whether the agent should read this playbook before starting.

Say yes only if the playbook addresses the same kind of problem with the same kind of data, system or deliverable,
so its steps would shorten the work. Say no if it is about a different tool, platform, environment or deliverable,
if it would push the agent toward extra steps the task does not need, or if it is generic advice.

## Task
{task}

## Playbook
Title: {title}
Summary: {summary}
Category: {category}
Triggers: {triggers}

Answer with JSON only: {"use": true|false}`;

function filled(template, values) {
  return template.replace(/\{(task|title|summary|category|triggers)\}/g, (_, key) => values[key]);
}

// A recalled asset is the GEP body itself, without the Hub's short_title: its
// local id stands in for the title, and a Capsule's trigger for the signals a
// Gene carries.
function playbookCardOf(asset) {
  const payload = asset?.payload && typeof asset.payload === 'object' ? asset.payload : asset;
  const signals = payload?.signals_match ?? asset?.signals_match ?? payload?.trigger ?? asset?.trigger;
  return {
    title: asset?.short_title || asset?.local_id || asset?.id || '',
    summary: String(payload?.summary || asset?.nl_summary || asset?.summary || '').slice(0, SUMMARY_MAX_CHARS),
    category: payload?.category || asset?.category || '',
    triggers: (Array.isArray(signals) ? signals.join('; ') : '').slice(0, TRIGGERS_MAX_CHARS),
  };
}

function useVerdictOf(answer) {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`verdict is not JSON: ${answer.slice(0, 120)}`);
  const use = JSON.parse(answer.slice(start, end + 1))?.use;
  if (typeof use !== 'boolean') throw new Error(`verdict has no boolean "use": ${answer.slice(0, 120)}`);
  return use;
}

// Returns null without a gateway key, so the caller keeps today's recall
// exactly: the prompt prefix as the query and no verdicts.
function isRetryable(status) {
  return status === 429 || status >= 500;
}

function retryDelayMs(response, attempt) {
  const seconds = Number(response.headers?.get?.('retry-after'));
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1_000, RETRY_AFTER_MAX_MS);
  return RETRY_DELAYS_MS[attempt];
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

export function createRecallJudge({
  apiKey = process.env[API_KEY_ENV], fetchImpl = fetch, timeoutMs = CALL_TIMEOUT_MS, sleep = pause,
} = {}) {
  if (!apiKey) return null;

  const request = (content, signal, extra) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return fetchImpl(`${GATEWAY_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content }], max_tokens: MAX_TOKENS, ...extra }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  };

  const completion = async (content, signal, extra = {}) => {
    for (let attempt = 0; ; attempt++) {
      const response = await request(content, signal, extra);
      if (response.ok) {
        const data = await response.json();
        return String(data?.choices?.[0]?.message?.content ?? '');
      }
      if (!isRetryable(response.status) || attempt >= RETRY_DELAYS_MS.length) {
        throw new Error(`gateway returned HTTP ${response.status}`);
      }
      await sleep(retryDelayMs(response, attempt), signal);
    }
  };

  const verdictOf = async (task, asset, signal) => {
    const prompt = filled(VERIFY_PROMPT, { task: task.slice(0, VERIFY_TASK_MAX_CHARS), ...playbookCardOf(asset) });
    return useVerdictOf(await completion(prompt, signal, { response_format: { type: 'json_object' } }));
  };

  return {
    async searchQueryOf(task, signal) {
      const answer = await completion(filled(REWRITE_PROMPT, { task: task.slice(0, TASK_MAX_CHARS) }), signal);
      const query = answer.trim().replace(/^"+|"+$/g, '').trim();
      if (!query) throw new Error('rewrite came back empty');
      return query.slice(0, QUERY_MAX_CHARS);
    },

    // One request per candidate, sent together: as fast as one batched call,
    // and each verdict sees the same single-playbook prompt as offline. A
    // candidate whose verdict failed is not used; only when every verdict
    // failed is the review itself treated as failed.
    async usableOf(task, assets, signal) {
      const settled = await Promise.allSettled(assets.map((asset) => verdictOf(task, asset, signal)));
      const failures = settled.filter((result) => result.status === 'rejected');
      if (assets.length > 0 && failures.length === assets.length) throw failures[0].reason;
      return {
        usable: assets.filter((_, index) => settled[index].status === 'fulfilled' && settled[index].value === true),
        failed: failures.length,
      };
    },
  };
}
