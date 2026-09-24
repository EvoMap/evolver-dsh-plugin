#!/usr/bin/env node
// Measures what priming actually costs and delivers against a live Proxy.
// The pass/fail question it answers is not "is the gene good" -- that needs the
// reuse verdicts -- but "does a strategy land behind the prompt, and what does
// carrying it cost", which is what the wait budget and the context bill turn on.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { hubGene } from '../src/prime.js';

const PROMPTS = [
  '帮我写一篇小红书的种草笔记',
  'add a retry with backoff to the uploader',
  '优化这个服务的缓存命中率',
  '写个脚本批量重命名文件',
  '这个 SQL 查询太慢了帮我优化',
  'the CI job times out on the coverage shard, find out why',
  '把这个 React 组件的重渲染次数降下来',
  'design a rate limiter for a public HTTP API',
  '这段 Python 有内存泄漏，帮我定位',
  'migrate this Express service to Fastify',
  '给这个仓库加一个 GitHub Actions 的 lint 工作流',
  'explain why this goroutine deadlocks',
];

const WAIT_BUDGET_MS = Number(process.env.EVOLVER_BENCH_WAIT_MS ?? 6_000);

function proxySettings() {
  const path = join(homedir(), '.evolver', 'settings.json');
  const { proxy } = JSON.parse(readFileSync(path, 'utf8'));
  if (!proxy?.url || !proxy?.token) throw new Error(`no proxy in ${path}; start one with \`evolver proxy\``);
  return proxy;
}

function proxyFetchVia({ url, token }) {
  return async (method, path, body, signal) => {
    const response = await fetch(url + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    return { ok: response.ok, data: await response.json() };
  };
}

function quantile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function report(runs) {
  const hits = runs.filter((run) => run.injected);
  const latencies = runs.map((run) => run.ms).sort((left, right) => left - right);
  const sizes = hits.map((run) => run.chars).sort((left, right) => left - right);
  const inline = runs.filter((run) => run.ms <= WAIT_BUDGET_MS);

  console.log(`prompts            ${runs.length}`);
  console.log(`injected           ${hits.length}/${runs.length}`);
  console.log(`inline (<=${WAIT_BUDGET_MS}ms)  ${inline.length}/${runs.length}  — past the budget the strategy lands a step late`);
  console.log(`latency ms         p50 ${quantile(latencies, 0.5)}  p90 ${quantile(latencies, 0.9)}  max ${latencies.at(-1)}`);
  console.log(`injected chars     p50 ${quantile(sizes, 0.5)}  p90 ${quantile(sizes, 0.9)}  max ${sizes.at(-1) ?? 0}`);
  console.log(`total chars        ${sizes.reduce((sum, n) => sum + n, 0)}`);
  console.log('');
  for (const run of runs) {
    const late = run.ms > WAIT_BUDGET_MS ? ' LATE' : '';
    const what = run.injected ? `${String(run.chars).padStart(5)}ch ${String(run.steps).padStart(2)}步 ${run.header}` : '    — 无注入';
    console.log(`${String(run.ms).padStart(5)}ms${late.padEnd(5)} ${what}`);
  }
}

const proxyFetch = proxyFetchVia(proxySettings());
const runs = [];
for (const prompt of PROMPTS) {
  const started = Date.now();
  const { ids, text } = await hubGene(proxyFetch, prompt).catch(() => ({ ids: [], text: '' }));
  const lines = text ? text.split('\n') : [];
  runs.push({
    prompt,
    ms: Date.now() - started,
    injected: ids.length > 0,
    chars: text.length,
    steps: lines.filter((line) => /^\d+\. /.test(line)).length,
    header: (lines[0] ?? '').replace('[Evolution Memory] ', '').slice(0, 56),
  });
}
report(runs);
