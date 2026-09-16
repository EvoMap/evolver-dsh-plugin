// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { createUserMessage } from '@deepseek-ai/dsh-llm';

import { splitFrontmatter } from './frontmatter.js';

const COMMANDS_DIR = fileURLToPath(new URL('../assets/commands/', import.meta.url));
const NAME_PREFIX = 'evolver-';

function loadCommandFiles() {
  return readdirSync(COMMANDS_DIR)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => {
      const { fields, body } = splitFrontmatter(readFileSync(join(COMMANDS_DIR, file), 'utf8'));
      return {
        name: `${NAME_PREFIX}${file.slice(0, -'.md'.length)}`,
        description: fields.description ?? `Evolver ${file.slice(0, -'.md'.length)}`,
        hint: fields['argument-hint'] ?? 'optional extra instructions',
        body,
      };
    });
}

function promptMessage(body, rawInput) {
  const text = rawInput.trim() ? `${body}\n\nUser input: ${rawInput.trim()}` : body;
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'evolver', form: 'instructions' },
  });
}

export function evolverCommands() {
  return loadCommandFiles().map(({ name, description, hint, body }) => ({
    name,
    description,
    input: { hint },
    handler: ({ agent, rawInput }) => {
      agent.followup(promptMessage(body, rawInput));
      return { kind: 'success', text: `Running /${name}.` };
    },
  }));
}
