// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { commitPreparedCapture, prepareCapture } from './capture.js';

function sessionKey(sessionId, projectDir) {
  return sessionId ? String(sessionId) : `workspace:${projectDir}`;
}

export function createCaptureCoordinator({
  prepare = prepareCapture,
  commit = commitPreparedCapture,
} = {}) {
  const pending = new Map();

  const schedule = (options) => {
    const key = sessionKey(options.sessionId, options.projectDir);
    const snapshot = Promise.resolve().then(() => prepare(options));
    const previous = pending.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => null)
      .then(async () => commit(await snapshot))
      .catch(() => null);
    pending.set(key, current);
    current.finally(() => {
      if (pending.get(key) === current) pending.delete(key);
    });
    return current;
  };

  const flush = async (sessionId, projectDir) => {
    await pending.get(sessionKey(sessionId, projectDir));
  };

  const flushAll = async () => {
    await Promise.all([...pending.values()]);
  };

  return { schedule, flush, flushAll };
}
