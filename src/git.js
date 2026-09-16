// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { execFile } from 'node:child_process';

const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

// Asynchronous on purpose: capture runs on the turn boundary, and a synchronous
// git call there blocks the agent's event loop for as long as git takes.
export function git(args, cwd) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, shell: false, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' },
      (error, stdout) => resolve({ ok: !error, stdout: typeof stdout === 'string' ? stdout : '' }),
    );
  });
}

export async function gitText(args, cwd) {
  return (await git(args, cwd)).stdout;
}
