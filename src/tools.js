// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { defineTool } from '@deepseek-ai/dsh-tools';

const jsonOutput = {
  schema: { type: 'json', description: 'The Evolver Proxy response body.' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
};

function proxyTool(proxyFetch, { name, description, parameters, request }) {
  return defineTool({
    name,
    description,
    parameters,
    output: jsonOutput,
    async execute(args) {
      const { method, path, body } = request(args);
      const result = await proxyFetch(method, path, body);
      if (!result.ok) throw new Error(result.error);
      return result.data;
    },
  });
}

export function evolverTools(proxyFetch) {
  return [
    proxyTool(proxyFetch, {
      name: 'evolver_status',
      description:
        'Get the EvoMap Proxy status: running state, node_id, pending inbound/outbound message counts, and last Hub sync time. Use this first to confirm the Proxy is up.',
      parameters: {},
      request: () => ({ method: 'GET', path: '/proxy/status' }),
    }),

    proxyTool(proxyFetch, {
      name: 'evolver_search_assets',
      description:
        'Search the EvoMap network for reusable evolution assets (Genes and Capsules). Pass `query` to describe your current task in natural language (semantic search — recommended when you are unsure which signal keywords apply) and/or `signals` to match known signal keywords; provide at least one. Call this BEFORE starting substantive work to reuse proven approaches instead of reinventing them.',
      parameters: {
        query: {
          type: 'string',
          description:
            'Free-text description of the current task, e.g. "restore quoted reply text in a feishu bot". Runs semantic search over the network.',
        },
        signals: {
          type: 'array',
          items: { type: 'string' },
          description: 'Signal keywords, e.g. ["log_error","perf_bottleneck","test_failure"].',
        },
        mode: { type: 'string', enum: ['semantic', 'exact'], default: 'semantic' },
        limit: { type: 'integer', default: 5 },
      },
      request: (args) => ({
        method: 'POST',
        path: '/asset/search',
        body: {
          query: args.query,
          signals: args.signals,
          mode: args.mode ?? 'semantic',
          limit: args.limit ?? 5,
        },
      }),
    }),

    proxyTool(proxyFetch, {
      name: 'evolver_fetch_asset',
      description:
        'Fetch the full content of one or more evolution assets by their IDs (e.g. "sha256:abc..."), as returned by evolver_search_assets.',
      parameters: {
        asset_ids: { type: 'array', items: { type: 'string' }, required: true },
      },
      request: (args) => ({ method: 'POST', path: '/asset/fetch', body: { asset_ids: args.asset_ids } }),
    }),

    proxyTool(proxyFetch, {
      name: 'evolver_publish_asset',
      description:
        'Publish one or more evolution assets (Genes/Capsules) to the EvoMap Hub for review. Queued locally and synced by the Proxy in the background; poll asset_submit_result with evolver_poll to see the Hub decision.',
      parameters: {
        assets: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: ['Gene', 'Capsule'], required: true },
              content: { type: 'string', required: true },
              summary: { type: 'string' },
              signals: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      request: (args) => ({ method: 'POST', path: '/asset/submit', body: { assets: args.assets } }),
    }),

    proxyTool(proxyFetch, {
      name: 'evolver_poll',
      description:
        'Poll the local mailbox for inbound messages by type, e.g. "asset_submit_result" (Hub review decisions), "hub_event", or "task_available". Returns without acknowledging.',
      parameters: {
        type: { type: 'string', description: 'Message type filter, e.g. "asset_submit_result".' },
        limit: { type: 'integer', default: 10 },
      },
      request: (args) => ({
        method: 'POST',
        path: '/mailbox/poll',
        body: { type: args.type, limit: args.limit ?? 10 },
      }),
    }),
  ];
}
