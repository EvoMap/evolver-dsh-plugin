import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { splitFrontmatter } from '../src/frontmatter.js';

import { evolverSkillProvider } from '../src/skill.js';

test('skill loading observes caller cancellation', async () => {
  await assert.rejects(
    () => evolverSkillProvider.get({}, { signal: AbortSignal.abort(new Error('cancelled')) }),
    /cancelled|aborted/i,
  );
});

test('the catalog summary is the description SKILL.md declares, and names no tool', async () => {
  const markdown = readFileSync(new URL('../assets/skills/capability-evolver/SKILL.md', import.meta.url), 'utf8');
  const [summary] = await evolverSkillProvider.list();
  assert.equal(summary.description, splitFrontmatter(markdown).fields.description);
  assert.doesNotMatch(markdown, /evolver_[a-z_]+/);
});
