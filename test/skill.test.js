import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evolverSkillProvider } from '../src/skill.js';

test('skill loading observes caller cancellation', async () => {
  await assert.rejects(
    () => evolverSkillProvider.get({}, { signal: AbortSignal.abort(new Error('cancelled')) }),
    /cancelled|aborted/i,
  );
});
