// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { commitPreparedCapture, prepareCapture } from './capture.js';
import { sessionKeyOf } from './session-key.js';

export function createCaptureCoordinator({
  prepare = prepareCapture,
  commit = commitPreparedCapture,
} = {}) {
  const pending = new Map();

  const schedule = (options) => {
    const key = sessionKeyOf(options.sessionId, options.projectDir);
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
    await pending.get(sessionKeyOf(sessionId, projectDir));
  };

  const flushAll = async () => {
    await Promise.all([...pending.values()]);
  };

  return { schedule, flush, flushAll };
}
