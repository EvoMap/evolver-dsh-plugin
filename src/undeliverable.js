// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// An asset the Hub lists but will not deliver is stable, not flaky: across a
// day, sixteen ids that came back under `missing` stayed missing on every
// retry, and twenty-four that resolved kept resolving. Nothing in the search
// row predicts which is which — `payload_ready` is false on both — so the only
// way to stop paying a fetch slot for them is to remember.
//
// The cause is not established. `fetchAssetById` collapses "the Hub does not
// have this" and "the client refused the delivery" into the same null, so a
// refusal that some future release fixes would look identical from here. The
// window is therefore a reprieve, not a ban: an id is retried once a day.
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

function storePath() {
  return path.join(os.homedir(), '.evolver', 'state', 'undeliverable.json');
}

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function undeliverableIds(now = Date.now()) {
  const fresh = new Set();
  for (const [assetId, at] of Object.entries(readStore())) {
    if (Number.isFinite(Number(at)) && now - Number(at) < RETRY_AFTER_MS) fresh.add(assetId);
  }
  return fresh;
}

export function markUndeliverable(assetIds, now = Date.now()) {
  if (!Array.isArray(assetIds) || assetIds.length === 0) return;
  const store = {};
  for (const [assetId, at] of Object.entries(readStore())) {
    if (Number.isFinite(Number(at)) && now - Number(at) < RETRY_AFTER_MS) store[assetId] = Number(at);
  }
  for (const assetId of assetIds) if (typeof assetId === 'string' && assetId) store[assetId] = now;

  const target = storePath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(store), { mode: 0o600, flag: 'wx' });
    try {
      fs.renameSync(temporary, target);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      fs.rmSync(target, { force: true });
      fs.renameSync(temporary, target);
    }
  } catch {
  }
}
