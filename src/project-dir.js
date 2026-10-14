// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import fs from 'node:fs';

function isDirectory(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function realPath(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

export function resolveProjectDir() {
  for (const fromEnv of [process.env.DSH_PROJECT_DIR, process.env.CLAUDE_PROJECT_DIR]) {
    if (isDirectory(fromEnv)) return realPath(fromEnv);
  }
  return realPath(process.cwd());
}

export function sessionDir(candidate, fallback = resolveProjectDir()) {
  return isDirectory(candidate) ? realPath(candidate) : fallback;
}
