// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const TASK_MAX_CHARS = 6_000;
const QUERY_MAX_CHARS = 400;
// Room for a reasoning model to think before it answers with one short line.
const REWRITE_MAX_TOKENS = 2_000;
const REWRITE_TIMEOUT_MS = 12_000;

// The prompt the offline replay over the 499-task bank was measured with;
// rewording it invalidates that measurement.
const REWRITE_PROMPT = `Rewrite the task below into ONE search query for a library of reusable problem-solving playbooks.
Keep only what the task is about: the concrete problem, the domain, and the kind of data or system involved.
Drop role statements, file paths, tool or environment instructions, output-format and saving rules.
Write it in English, at most 200 characters. Answer with the query only.

## Task
{task}`;

async function answerOf(llm, options) {
  let text = '';
  for await (const chunk of llm.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text;
    if (chunk.type === 'finish' && chunk.reason?.failure) throw new Error(chunk.reason.failure.message);
  }
  return text;
}

// The session's own provider and model write the query, so recall needs no
// key, endpoint or model of its own and costs one short call on the route the
// person already chose.
export async function rewrittenQueryOf(llm, { provider, model }, task, signal) {
  const timeout = AbortSignal.timeout(REWRITE_TIMEOUT_MS);
  const prompt = REWRITE_PROMPT.replace('{task}', () => task.slice(0, TASK_MAX_CHARS));
  const answer = await answerOf(llm, {
    provider,
    model,
    messages: [createUserMessage({ content: [{ type: 'text', text: prompt }] })],
    maxTokens: REWRITE_MAX_TOKENS,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const query = answer.trim().replace(/^"+|"+$/g, '').trim();
  if (!query) throw new Error('rewrite came back empty');
  return query.slice(0, QUERY_MAX_CHARS);
}
