// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import Schema from '@deepseek-ai/schemastery';

import { EDIT_TOOL_NAMES } from './edited-content.js';

const MAX_TIMER_MS = 2 ** 31 - 1;

export const Config = Schema.object({
  projectDir: Schema.string(),
  proxyPort: Schema.number().step(1).min(1).max(65_535),
  editToolNames: Schema.array(Schema.string()).default([...EDIT_TOOL_NAMES]),
  proxyTimeoutMs: Schema.number().step(1).min(1).max(MAX_TIMER_MS).default(8_000),
  assetPrimeEnabled: Schema.boolean().default(true),
  assetPrimeMinSimilarity: Schema.number().min(0).max(1).default(0.3),
  assetPrimeWaitMs: Schema.number().step(1).min(1).max(MAX_TIMER_MS).default(6_000),
  assetPrimeTimeoutMs: Schema.number().step(1).min(1).max(MAX_TIMER_MS).default(8_000),
  claimNudgeEnabled: Schema.boolean().default(false),
  claimNudgeTtlMs: Schema.number().step(1).min(1).max(MAX_TIMER_MS).default(12 * 60 * 60 * 1000),
});
