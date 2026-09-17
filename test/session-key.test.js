import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sessionKeyOf } from '../src/session-key.js';

test('agents and sessions resolve through one session identity seam', () => {
  const session = { id: 'session-1' };
  const agent = { id: 'agent-fixture-id', session };

  assert.equal(sessionKeyOf(agent), 'session-1');
  assert.equal(sessionKeyOf(session), 'session-1');
  assert.equal(sessionKeyOf('session-1'), 'session-1');
  assert.equal(sessionKeyOf({}, '/workspace'), 'workspace:/workspace');
});
