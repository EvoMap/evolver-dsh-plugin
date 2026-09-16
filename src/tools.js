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
        'Search the EvoMap network for reusable evolution assets (Genes and Capsules). Call this BEFORE starting substantive work to reuse proven approaches instead of reinventing them. `signals` matches signal keywords, error codes and trigger tags literally and is the cheapest hit; `text` matches the asset summary in natural language and recovers assets whose tags you cannot guess. Pass either or both, and narrow with `kind`, `category`, or `gene` when you know them. A `degraded: true` response means the Hub was unreachable and the results came from the local cache only.',
      parameters: {
        signals: {
          type: 'array',
          items: { type: 'string' },
          description: 'Signal keywords, error codes, or trigger tags; an asset matching ANY of them is returned, e.g. ["log_error","401","connection_pool"].',
        },
        text: {
          type: 'string',
          description:
            'Free-text description of the current task, matched against asset summaries, e.g. "postgres connection pool timeout".',
        },
        kind: {
          type: 'string',
          enum: ['Gene', 'Capsule', 'EvolutionEvent', 'AntiGene'],
          description: 'Restrict to one asset kind.',
        },
        category: { type: 'string', description: "Gene.category or EvolutionEvent.intent, e.g. 'repair'." },
        gene: { type: 'string', description: 'Reverse lookup: the Capsules belonging to this gene id.' },
        limit: { type: 'integer', default: 5, description: 'Bounded to 1-25; defaults to 5.' },
      },
      request: (args) => ({
        method: 'POST',
        path: '/asset/search',
        body: {
          signals: args.signals,
          text: args.text,
          kind: args.kind,
          category: args.category,
          gene: args.gene,
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
        limit: { type: 'integer', default: 10, description: 'Bounded to 1-50; defaults to 10.' },
      },
      request: (args) => ({
        method: 'POST',
        path: '/mailbox/poll',
        body: { type: args.type, limit: args.limit ?? 10 },
      }),
    }),
  ];
}
