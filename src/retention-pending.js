// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import crypto from 'node:crypto';
import fs from 'node:fs';

import { OUTBOX_TTL_MS } from './report-outbox.js';
import { ABSENT, retentionOf } from './retention.js';
import { retentionReportOf } from './reuse.js';
import { readState, statePath, writeState } from './state-file.js';

const pendingPath = () => statePath('retention-pending.json');

export function contentHashOf(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return ABSENT;
  }
}

export function rememberForRetention({ sessionId, projectDir, reuses, editedBefore, now = Date.now() }) {
  if (reuses.length === 0 || editedBefore.size === 0) return;
  const files = [...editedBefore].map(([file, before]) => ({ path: file, before, after: contentHashOf(file) }));
  writeState(pendingPath(), [...readState(pendingPath(), []), { sessionId, projectDir, reuses, files, atMs: now }]);
}

export function takeDueRetentions({ sessionId, projectDir, now = Date.now() }) {
  const pending = readState(pendingPath(), []);
  if (pending.length === 0) return [];
  const isDue = (entry) => entry.projectDir === projectDir && entry.sessionId !== sessionId;
  writeState(pendingPath(), pending.filter((entry) => !isDue(entry) && now - entry.atMs <= OUTBOX_TTL_MS));
  return pending.filter((entry) => isDue(entry) && now - entry.atMs <= OUTBOX_TTL_MS);
}

export function retentionReportsOf(entry) {
  const verdict = retentionOf(entry.files.map((file) => ({ ...file, now: contentHashOf(file.path) }))).class;
  return entry.reuses
    .map((reuse) => retentionReportOf(reuse, verdict))
    .filter((report) => report !== null)
    .map((report) => ({ report, sessionId: entry.sessionId }));
}
