// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { detectSignals } from './signals.js';

const VERIFICATION_COMMANDS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|type-check|check)\b/,
  /\bnode\s+--test\b/,
  /\b(?:jest|vitest|mocha|pytest|rspec|phpunit|tsc|eslint|ruff|mypy)\b/,
  /\bgo\s+(?:test|build|vet)\b/,
  /\bcargo\s+(?:test|build|check|clippy)\b/,
  /\bdotnet\s+(?:test|build)\b/,
  /\b(?:mvn|gradle|gradlew)\b/,
  /\bmake\b/,
];

const FAILURE_SIGNALS = new Set(['test_failure', 'log_error']);

// Summaries of a passing run still name failures by count ("0 failed",
// "failures: 0"); only those counts are dropped, so "1 failed, 0 errors"
// still reads as a failure.
const ZERO_COUNT = /\b0\s+(?:failed|failures?|errors?)\b|\b(?:failed|failures?|errors?)\s*[:=]\s*0\b/gi;

const SHELL_TOOL_NAMES = ['bash'];

export function isVerificationCommand(command) {
  return typeof command === 'string' && VERIFICATION_COMMANDS.some((pattern) => pattern.test(command));
}

function textOf(result) {
  return (result?.content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

// dsh's bash reports a failing command piped through `tail` as a success, so
// the output is read too, not only `isError`.
export function verificationFailed(result) {
  if (result?.isError) return true;
  const evidence = textOf(result).replace(ZERO_COUNT, '');
  return detectSignals(evidence).some((signal) => FAILURE_SIGNALS.has(signal));
}

export function checkCommandOf(exec) {
  if (!SHELL_TOOL_NAMES.includes(exec?.name)) return null;
  const command = exec.arguments?.command;
  return isVerificationCommand(command) ? command : null;
}
