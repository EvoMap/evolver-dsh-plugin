// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createUserMessage } from '@deepseek-ai/dsh-llm';

import { splitFrontmatter } from './frontmatter.js';

// Commands are how a person reaches Evolver, so nothing about them sits in the model's context: each one
// runs in the plugin and answers in the UI. Only /evolver-evolve hands the agent a one-off instruction,
// because reflecting on the current work is the agent's job.

const NAME_PREFIX = 'evolver-';
const OUTPUT_MAX_CHARS = 4_000;
const CLI_TIMEOUT_MS = 10 * 60 * 1000;
const EVOLVE_PATH = fileURLToPath(new URL('../assets/commands/evolve.md', import.meta.url));

const success = (text) => ({ kind: 'success', text });
const failure = (text) => ({ kind: 'error', text });

function shown(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > OUTPUT_MAX_CHARS ? `${text.slice(0, OUTPUT_MAX_CHARS)}\n…` : text;
}

export function runEvolverCli(args, { signal } = {}) {
  return new Promise((resolve) => {
    execFile('evolver', args, { timeout: CLI_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, signal }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr ? `\n${stderr}` : ''}`.trim();
      resolve(error ? failure(shown(output || String(error.message))) : success(shown(output || 'done')));
    });
  });
}

function cliCommand(subcommand, description, hint, runCli) {
  return {
    name: `${NAME_PREFIX}${subcommand}`,
    description,
    input: { hint },
    handler: ({ rawInput, signal }) => runCli([subcommand, ...rawInput.trim().split(/\s+/).filter(Boolean)], { signal }),
  };
}

function evolveCommand() {
  const { fields, body } = splitFrontmatter(readFileSync(EVOLVE_PATH, 'utf8'));
  return {
    name: `${NAME_PREFIX}evolve`,
    description: fields.description,
    input: { hint: 'optional focus' },
    handler: ({ agent, rawInput }) => {
      const focus = rawInput.trim();
      const text = focus ? `${body}\n\nFocus: ${focus}` : body;
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin:evolver', form: 'instructions' } }));
      return success(`Running /${NAME_PREFIX}evolve.`);
    },
  };
}

/**
 * `status` and `search` answer from the Proxy, `distill` distills the session's latest verified turn now,
 * and the engine commands run the `evolver` executable.
 */
export function evolverCommands({ status, search, distillNow, runCli = runEvolverCli }) {
  return [
    {
      name: `${NAME_PREFIX}status`,
      description: 'Show Evolver health: the Proxy, Hub auth, recent recalls and reuse reports.',
      input: { hint: '' },
      handler: async ({ signal }) => success(shown(await status(signal))),
    },
    {
      name: `${NAME_PREFIX}search`,
      description: 'Search the EvoMap network for reusable assets.',
      input: { hint: '<task description or error text>' },
      handler: async ({ rawInput, signal }) => {
        const text = rawInput.trim();
        if (!text) return failure(`Usage: /${NAME_PREFIX}search <task description or error text>`);
        const result = await search(text, signal);
        return result.ok ? success(shown(result.data)) : failure(String(result.error));
      },
    },
    {
      name: `${NAME_PREFIX}distill`,
      description: "Distill this session's latest verified turn into a reusable Gene now, instead of at session end.",
      input: { hint: 'optional focus' },
      handler: async ({ agent, rawInput }) => {
        const outcome = await distillNow(agent, rawInput.trim());
        if (outcome.status === 'nothing') return failure('Nothing to distill yet: no turn of this session finished verified.');
        return outcome.status === 'sent' ? success(shown(outcome.data ?? 'distilled')) : failure(`Distillation ${outcome.status}: ${outcome.error ?? ''}`.trim());
      },
    },
    evolveCommand(),
    cliCommand('sync', 'Sync assets between the local store and the EvoMap Hub (evolver sync).', '[--scope=…] [--type=…] [--dry-run]', runCli),
    cliCommand('review', "Review Evolver's pending evolved changes, then approve or reject them (evolver review).", '[--approve | --reject]', runCli),
    cliCommand('run', 'Run one Evolver self-evolution cycle on this repository (evolver run).', '[--loop] [--dry-run] [--strategy=…]', runCli),
    cliCommand('solidify', 'Solidify the working changes into a durable Gene or Capsule (evolver solidify).', '[--dry-run] [--intent=…] [--summary=…]', runCli),
  ];
}
