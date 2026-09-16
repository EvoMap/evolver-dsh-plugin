import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const commandsDir = join(root, 'assets', 'commands');

function commandBodies() {
  return readdirSync(commandsDir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => readFileSync(join(commandsDir, file), 'utf8'))
    .join('\n');
}

test('bundled instructions use DSH command and invocation semantics', () => {
  const commands = commandBodies();
  const skill = readFileSync(join(root, 'assets', 'skills', 'capability-evolver', 'SKILL.md'), 'utf8');

  assert.doesNotMatch(commands, /\$ARGUMENTS|\/evolver:|User input:/);
  assert.match(commands, /Invocation arguments \(verbatim JSON string\)/);
  assert.doesNotMatch(skill, /`SessionStart`|`PostToolUse`|`Stop`|bundles a lightweight MCP bridge/);
  assert.match(skill, /agent\/created/);
  assert.match(skill, /evolver_asset_reuse_result/);
});
