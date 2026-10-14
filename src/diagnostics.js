// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { readFileSync } from 'node:fs';
import os from 'node:os';

import { MIN_EVOLVER_VERSION, isOlderThan } from './engine-version.js';
import { STRATEGY_MAX_CHARS } from './prime.js';
import { describeProxyEndpoint } from './proxy.js';
import { REJECTED } from './report-outbox.js';

const PLUGIN_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export function createRecallLog(now = () => Date.now()) {
  const counts = {};
  let last = null;
  return {
    record(outcome, startedAt) {
      counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
      last = { ...outcome, at: new Date(now()).toISOString(), duration_ms: now() - startedAt };
    },
    snapshot() {
      return { last, counts: { ...counts } };
    },
  };
}

const MAX_LOGGED_REPORTS = 10;

function keepLast(list, entry) {
  list.push(entry);
  if (list.length > MAX_LOGGED_REPORTS) list.shift();
}

export function createReportLog(now = () => Date.now()) {
  const delivered = [];
  const rejected = [];
  return {
    record({ verdict, taskId, assetId, receipt, reason, status }) {
      const entry = { at: new Date(now()).toISOString(), task_id: taskId, asset_id: assetId };
      if (verdict === REJECTED) keepLast(rejected, { ...entry, reason, status });
      else keepLast(delivered, { ...entry, ...receipt });
    },
    snapshot() {
      return { delivered: [...delivered], rejected: [...rejected] };
    },
  };
}

function engineReport(pathVersion, runningVersion) {
  const effective = runningVersion ?? pathVersion;
  return {
    path_version: pathVersion,
    running_version: runningVersion,
    minimum_version: MIN_EVOLVER_VERSION,
    meets_minimum: effective ? !isOlderThan(effective, MIN_EVOLVER_VERSION) : null,
    path_differs_from_running: Boolean(pathVersion && runningVersion && pathVersion !== runningVersion),
  };
}

export async function pluginDiagnostics({ config, engineVersion, recallLog, reportLog, port }) {
  const endpoint = describeProxyEndpoint(port);
  const runningVersion = typeof endpoint.running_version === 'string' ? endpoint.running_version : null;
  return {
    plugin: { name: '@evomap/dsh-evolver', version: PLUGIN_VERSION },
    runtime: { platform: process.platform, arch: process.arch, node: process.version, os_release: os.release() },
    proxy_endpoint: endpoint,
    engine: engineReport(await engineVersion, runningVersion),
    recall: {
      enabled: config.assetPrimeEnabled !== false,
      wait_ms: config.assetPrimeWaitMs ?? 6_000,
      timeout_ms: config.assetPrimeTimeoutMs ?? 8_000,
      min_similarity: config.assetPrimeMinSimilarity ?? 0.3,
      max_strategy_chars: STRATEGY_MAX_CHARS,
      ...recallLog.snapshot(),
    },
    reuse_reports: reportLog.snapshot(),
  };
}
