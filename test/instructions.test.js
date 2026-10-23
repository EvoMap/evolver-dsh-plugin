import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the one bundled instruction names no tool the agent no longer has', () => {
  const files = readdirSync(join(root, 'assets', 'commands'));
  assert.deepEqual(files, ['evolve.md']);
  const evolve = readFileSync(join(root, 'assets', 'commands', 'evolve.md'), 'utf8');
  assert.doesNotMatch(evolve, /evolver_[a-z_]+|\$ARGUMENTS|\/evolver:/);
  assert.match(evolve, /\/evolver-distill/);
});
