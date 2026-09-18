// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import Schema from '@deepseek-ai/schemastery';

import { EDIT_TOOL_NAMES } from './edited-content.js';

const MAX_TIMER_MS = 2 ** 31 - 1;

export const Config = Schema.object({
  projectDir: Schema.string(),
  proxyPort: Schema.number().step(1).min(1).max(65_535),
  editToolNames: Schema.array(Schema.string()).default([...EDIT_TOOL_NAMES]),
  gitTimeoutMs: Schema.number().step(1).min(1).max(MAX_TIMER_MS).default(5_000),
  gitMaxBufferBytes: Schema.number().step(1).min(1).max(128 * 1024 * 1024).default(10 * 1024 * 1024),
  proxyTimeoutMs: Schema.number().step(1).min(1).max(MAX_TIMER_MS).default(8_000),
  hubTimeoutMs: Schema.number().step(1).min(1).max(MAX_TIMER_MS).default(8_000),
  recallMaxResults: Schema.number().step(1).min(1).max(20).default(3),
  recallMaxBytes: Schema.number().step(1).min(1024).max(64 * 1024 * 1024).default(1024 * 1024),
  assetPrimeEnabled: Schema.boolean().default(true),
  assetPrimeTimeoutMs: Schema.number().step(1).min(1).max(MAX_TIMER_MS).default(3_000),
  claimNudgeEnabled: Schema.boolean().default(false),
  claimNudgeTtlMs: Schema.number().step(1).min(1).max(MAX_TIMER_MS).default(12 * 60 * 60 * 1000),
  captureDedupeTtlMs: Schema.number().step(1).min(1).max(MAX_TIMER_MS).default(24 * 60 * 60 * 1000),
  captureLockStaleMs: Schema.number().step(1).min(1).max(MAX_TIMER_MS).default(60_000),
  captureLockWaitMs: Schema.number().step(1).min(1).max(MAX_TIMER_MS).default(65_000),
  untrackedHashMaxBytes: Schema.number().step(1).min(1).max(64 * 1024 * 1024).default(1024 * 1024),
});
