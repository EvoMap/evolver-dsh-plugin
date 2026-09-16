// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { defineTool } from '@deepseek-ai/dsh-tools';

const jsonOutput = {
  schema: { type: 'json', description: 'The Evolver Proxy response body.' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
};

// An asset carries publisher-side retrieval metadata that costs more than the
// strategy it wraps — signals_match alone outweighs it — and is worthless to an
// agent about to apply the gene. Project only what reuse needs, as prose: the
// tool-result pruner cuts anything past 8192 chars from the middle, which is
// exactly where strategy sits in the raw envelope.
function renderAsset(asset) {
  const lines = [`## ${asset.type ?? 'Asset'} ${asset.asset_id ?? ''}`.trim()];
  if (asset.summary) lines.push('', asset.summary);

  const steps = Array.isArray(asset.strategy) ? asset.strategy : [];
  if (steps.length > 0) {
    lines.push('', 'Strategy:');
    steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  }

  const checks = Array.isArray(asset.validation) ? asset.validation : [];
  if (checks.length > 0) {
    lines.push('', 'Validation — run these to confirm the change worked:');
    for (const check of checks) lines.push(`- ${check}`);
  }
  return lines.join('\n');
}

const assetOutput = {
  schema: { type: 'json', description: 'The fetched assets.' },
  render: (_args, value) => {
    const assets = Array.isArray(value?.assets) ? value.assets : [];
    const missing = Array.isArray(value?.missing) ? value.missing : [];

    const parts = assets.map(renderAsset);
    if (missing.length > 0) {
      parts.push(`Not retrievable: ${missing.join(', ')}. They may be unpublished or not visible to this node.`);
    }
    if (parts.length === 0) parts.push('No assets returned.');
    return [{ type: 'text', text: parts.join('\n\n') }];
  },
};

function proxyTool(proxyFetch, { name, description, parameters, request, output = jsonOutput }) {
  return defineTool({
    name,
    description,
    parameters,
    output,
    async execute(args, exec) {
      const { method, path, body } = request(args);
      // The caller's signal rides along: a cancelled turn must not leave a
      // publish or a distillation still in flight.
      const result = await proxyFetch(method, path, body, exec?.signal);
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
      output: assetOutput,
      description:
        'Fetch the reusable content of one or more evolution assets by their IDs (e.g. "sha256:abc..."), as returned by evolver_search_assets. Returns each asset\'s summary, its numbered strategy steps, and the validation commands that confirm the change worked — apply the strategy, then run the validation, then report what happened with evolver_asset_reuse_result.',
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
      name: 'evolver_asset_reuse_result',
      description:
        'Report what actually happened after reusing an asset fetched with evolver_fetch_asset. Call this once the reused strategy has been applied and checked — it is how the network learns which assets are worth keeping and how their authors are credited. Reporting nothing leaves the reuse loop open.',
      parameters: {
        asset_id: { type: 'string', required: true, description: 'The reused asset id, e.g. "sha256:abc...".' },
        outcome: {
          type: 'string',
          required: true,
          enum: ['success', 'failed', 'mismatched', 'stale', 'unsafe'],
          description:
            "'success' it solved the task; 'failed' it applied but did not work; 'mismatched' it did not fit the task; 'stale' it described an older version of the tool or API; 'unsafe' applying it would have caused harm.",
        },
        reason: { type: 'string', description: 'One line on why, especially for anything other than success.' },
        time_saved_seconds: { type: 'number', description: 'Rough wall-clock time the reuse saved, when you can estimate it.' },
        task_id: { type: 'string', description: 'Caller-side task identity, when one exists.' },
      },
      request: (args) => ({
        method: 'POST',
        path: '/asset/reuse-result',
        body: {
          asset_id: args.asset_id,
          outcome: args.outcome,
          reason: args.reason,
          time_saved_seconds: args.time_saved_seconds,
          task_id: args.task_id,
        },
      }),
    }),

    proxyTool(proxyFetch, {
      name: 'evolver_distill_conversation',
      description:
        'Distill the capability proven in this conversation into a reusable asset. Call it after solving something non-trivial and VERIFYING it. The Hub quality gate rejects weak input: `summary` must say what was solved concretely, `strategy` must be the reproducible steps, and `validation` must be the commands that proved it. Set publish=true to submit it to the Hub for review.',
      parameters: {
        summary: {
          type: 'string',
          required: true,
          description: 'What was solved and under which conditions, concretely — not "fixed a bug".',
        },
        title: { type: 'string', description: 'Short name for the capability.' },
        strategy: {
          type: 'array',
          items: { type: 'string' },
          description: 'The reproducible steps another agent would follow.',
        },
        validation: {
          type: 'array',
          items: { type: 'string' },
          description: 'Commands that prove the change worked, e.g. ["npm test"].',
        },
        artifacts: { type: 'array', items: { type: 'string' }, description: 'Files or paths the work produced.' },
        signals: { type: 'array', items: { type: 'string' }, description: 'Signal keywords this generalizes.' },
        persist: { type: 'boolean', description: 'Keep the distilled asset in the local store.' },
        publish: { type: 'boolean', description: 'Submit it to the Hub for review.' },
      },
      request: (args) => ({
        method: 'POST',
        path: '/conversation/distill',
        body: {
          platform: 'dsh',
          title: args.title,
          summary: args.summary,
          strategy: args.strategy,
          validation: args.validation,
          artifacts: args.artifacts,
          signals: args.signals,
          persist: args.persist === true,
          publish: args.publish === true,
        },
      }),
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
