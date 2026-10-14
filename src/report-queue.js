// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { withQueued } from './report-outbox.js';
import { deliverPending } from './reuse.js';
import { readState, statePath, writeState } from './state-file.js';

const outboxPath = () => statePath('reports-outbox.json');

function attemptedEntries(before, after) {
  return Object.fromEntries(Object.entries(after).filter(([key, entry]) => before[key] !== entry));
}

// Another dsh process may queue reports while this one is delivering, so the
// attempts are merged into the file as it stands afterwards, not over the
// snapshot that was delivered.
export function createReportQueue(ledgers, clock = () => Date.now()) {
  let work = Promise.resolve();
  return function deliver(queued = []) {
    work = work.catch(() => {}).then(async () => {
      const now = clock();
      const outbox = withQueued(readState(outboxPath(), {}), queued, now);
      writeState(outboxPath(), outbox);
      const delivered = await deliverPending(ledgers, outbox, now);
      writeState(outboxPath(), { ...withQueued(readState(outboxPath(), {}), [], now), ...attemptedEntries(outbox, delivered) });
    });
    return work;
  };
}
