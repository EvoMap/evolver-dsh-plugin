// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const WORKSPACE_ID_PATTERN = /^[a-f0-9]{32,}$/i;
const GIT_TIMEOUT_MS = 5000;

function isDirectory(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

// Entries are matched by `cwd` when no workspace id is known, so the same
// directory reached through a symlink (/tmp vs /private/tmp on macOS) must
// resolve to one spelling or recall silently misses its own workspace.
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

// Each dsh session carries its own validated cwd; a plugin loaded once must not
// pin every session in the process to the directory the runtime started in.
export function sessionDir(candidate, fallback) {
  return isDirectory(candidate) ? realPath(candidate) : fallback;
}

export function isGitWorkspace(dir) {
  try {
    const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: isDirectory(dir) ? dir : undefined,
      shell: false,
      timeout: GIT_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return result.status === 0 && String(result.stdout).trim() === 'true';
  } catch {
    return false;
  }
}

export function findMemoryGraph(projectDir) {
  const override = process.env.MEMORY_GRAPH_PATH;
  if (typeof override === 'string' && override.length > 0) return override;

  if (isDirectory(projectDir)) {
    const projectPath = path.join(projectDir, 'memory', 'evolution', 'memory_graph.jsonl');
    try {
      // lstat, not stat: a symlink planted in a checked-out repo would otherwise
      // make this plugin append every outcome to a file outside the workspace.
      if (fs.lstatSync(projectPath).isFile()) return projectPath;
    } catch {
      // fall through to the user-level graph
    }
  }

  const userPath = path.join(os.homedir(), '.evolver', 'memory', 'evolution', 'memory_graph.jsonl');
  try {
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
  } catch {
    // callers tolerate a missing directory
  }
  return userPath;
}

// O_NOFOLLOW: refuse to append through a symlink even if one appears between
// the lookup above and this open.
export function appendMemoryGraph(projectDir, entry) {
  const graphPath = findMemoryGraph(projectDir);
  let fd;
  try {
    fs.mkdirSync(path.dirname(graphPath), { recursive: true });
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW;
    fd = fs.openSync(graphPath, flags, 0o600);
    fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function findRepoRoot(start) {
  let current = path.resolve(start);
  for (let depth = 0; depth < 256; depth += 1) {
    try {
      if (fs.existsSync(path.join(current, '.git'))) return current;
    } catch {
      // keep climbing
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function computeWorkspaceRoot(projectDir) {
  const explicit = process.env.OPENCLAW_WORKSPACE;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;

  const repoRoot = findRepoRoot(projectDir);
  if (!repoRoot) return projectDir;

  const nested = path.join(repoRoot, 'workspace');
  return isDirectory(nested) ? nested : repoRoot;
}

function readWorkspaceIdFile(dotEvolverDir, idFile) {
  let dirStat;
  try {
    dirStat = fs.lstatSync(dotEvolverDir);
  } catch {
    return { ok: false, missing: true };
  }
  if (dirStat.isSymbolicLink()) return { ok: false, missing: false };

  let fileStat;
  try {
    fileStat = fs.lstatSync(idFile);
  } catch {
    return { ok: false, missing: true };
  }
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) return { ok: false, missing: false };

  let raw;
  try {
    raw = fs.readFileSync(idFile, 'utf8');
  } catch {
    return { ok: false, missing: false };
  }
  const value = raw.trim();
  return WORKSPACE_ID_PATTERN.test(value) ? { ok: true, id: value } : { ok: false, missing: false };
}

function createWorkspaceIdFile(dotEvolverDir, idFile) {
  try {
    if (fs.lstatSync(dotEvolverDir).isSymbolicLink()) return null;
  } catch {
    // does not exist yet
  }
  try {
    fs.mkdirSync(dotEvolverDir, { recursive: true });
  } catch {
    return null;
  }

  const fresh = crypto.randomBytes(16).toString('hex');
  let fd;
  try {
    // O_EXCL + O_NOFOLLOW: never follow a symlink or clobber a racing writer.
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
    fd = fs.openSync(idFile, flags, 0o600);
    fs.writeSync(fd, fresh);
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      const raced = readWorkspaceIdFile(dotEvolverDir, idFile);
      return raced.ok ? raced.id : null;
    }
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }

  try {
    fs.chmodSync(idFile, 0o600);
  } catch {
    // best effort against a wide umask
  }
  return fresh;
}

export function resolveWorkspaceId(projectDir) {
  try {
    const fromEnv = process.env.EVOLVER_WORKSPACE_ID;
    if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;

    const dotEvolverDir = path.join(computeWorkspaceRoot(projectDir), '.evolver');
    const idFile = path.join(dotEvolverDir, 'workspace-id');

    const existing = readWorkspaceIdFile(dotEvolverDir, idFile);
    if (existing.ok) return existing.id;
    if (!existing.missing) return null;

    return createWorkspaceIdFile(dotEvolverDir, idFile);
  } catch {
    return null;
  }
}
