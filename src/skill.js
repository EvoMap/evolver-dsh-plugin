// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { splitFrontmatter } from './frontmatter.js';

const PROVIDER_NAME = 'evolver';
const SKILL_DIR = new URL('../assets/skills/capability-evolver/', import.meta.url);
const SKILL_BODY_URL = new URL('SKILL.md', SKILL_DIR);

const SUMMARY = {
  name: 'capability-evolver',
  description:
    'Self-evolution workflow for the agent. Before a substantive task, recall what worked on similar past tasks from evolution memory; after it, record the outcome so future sessions learn from it. Use when the user starts non-trivial work (a feature, a fix, a refactor) or asks the agent to "evolve", "learn from this", or "remember how this went".',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: PROVIDER_NAME,
  source: 'custom',
  resourceBase: { kind: 'directory', path: fileURLToPath(SKILL_DIR) },
};

export const evolverSkillProvider = {
  name: PROVIDER_NAME,
  // `@deepseek-ai/dsh-skill` is an optional peer: a profile without the skills
  // service never installs it. Reading the rank here rather than at module
  // scope keeps the whole plugin loadable when the package is absent — a
  // top-level import would fail the import of index.js itself.
  async list(options = {}) {
    if (options.signal?.aborted) throw options.signal.reason;
    const { BUNDLED_SKILL_RANK } = await import('@deepseek-ai/dsh-skill');
    if (options.signal?.aborted) throw options.signal.reason;
    return [{ ...SUMMARY, rank: BUNDLED_SKILL_RANK, locator: SKILL_BODY_URL }];
  },
  async get(_candidate, options = {}) {
    const { body } = splitFrontmatter(
      await readFile(SKILL_BODY_URL, { encoding: 'utf8', signal: options.signal }),
    );
    return { ...SUMMARY, content: body };
  },
};
