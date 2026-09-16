// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill';

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

const CANDIDATE = { ...SUMMARY, rank: BUNDLED_SKILL_RANK, locator: SKILL_BODY_URL };

export const evolverSkillProvider = {
  name: PROVIDER_NAME,
  list: async () => [CANDIDATE],
  async get() {
    const { body } = splitFrontmatter(await readFile(SKILL_BODY_URL, 'utf8'));
    return { ...SUMMARY, content: body };
  },
};
