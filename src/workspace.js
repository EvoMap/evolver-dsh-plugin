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

function realPath(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
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

export function projectMemoryGraphPath(projectDir) {
  return path.join(projectDir, 'memory', 'evolution', 'memory_graph.jsonl');
}

function safeProjectMemoryGraph(projectDir) {
  if (!isDirectory(projectDir)) return null;
  try {
    const root = realPath(projectDir);
    const memoryDir = path.join(root, 'memory');
    const evolutionDir = path.join(memoryDir, 'evolution');
    const graphPath = path.join(evolutionDir, 'memory_graph.jsonl');
    const memoryStat = fs.lstatSync(memoryDir);
    const evolutionStat = fs.lstatSync(evolutionDir);
    const graphStat = fs.lstatSync(graphPath);
    if (memoryStat.isSymbolicLink() || !memoryStat.isDirectory()) return null;
    if (evolutionStat.isSymbolicLink() || !evolutionStat.isDirectory()) return null;
    if (graphStat.isSymbolicLink() || !graphStat.isFile()) return null;
    return isPathInside(root, fs.realpathSync(graphPath)) ? graphPath : null;
  } catch {
    return null;
  }
}

export function isProjectMemoryGraph(projectDir, graphPath) {
  const safe = safeProjectMemoryGraph(projectDir);
  return safe !== null && path.resolve(safe) === path.resolve(graphPath);
}

function userMemoryGraphPath() {
  return path.join(os.homedir(), '.evolver', 'memory', 'evolution', 'memory_graph.jsonl');
}

export function findMemoryGraph(projectDir) {
  const override = process.env.MEMORY_GRAPH_PATH;
  if (typeof override === 'string' && override.length > 0) return override;

  const projectPath = safeProjectMemoryGraph(projectDir);
  if (projectPath) return projectPath;

  const userPath = userMemoryGraphPath();
  try {
    fs.mkdirSync(path.dirname(userPath), { recursive: true, mode: 0o700 });
  } catch {
  }
  return userPath;
}

export function appendMemoryGraph(projectDir, entry) {
  const graphPath = findMemoryGraph(projectDir);
  let fd;
  try {
    try {
      const existing = fs.lstatSync(graphPath);
      if (existing.isSymbolicLink() || !existing.isFile()) return false;
    } catch (error) {
      if (error?.code !== 'ENOENT') return false;
    }
    fs.mkdirSync(path.dirname(graphPath), { recursive: true, mode: 0o700 });
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | noFollow;
    fd = fs.openSync(graphPath, flags, 0o600);
    if (!fs.fstatSync(fd).isFile()) return false;
    fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
  }
}

export function captureStatePath(projectDir) {
  const key = crypto.createHash('sha256').update(projectDir).digest('hex').slice(0, 16);
  return path.join(os.homedir(), '.evolver', 'state', `capture-${key}.json`);
}

function findRepoRoot(start) {
  let current = path.resolve(start);
  for (let depth = 0; depth < 256; depth += 1) {
    try {
      if (fs.existsSync(path.join(current, '.git'))) return current;
    } catch {
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
  }
  try {
    fs.mkdirSync(dotEvolverDir, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }

  const fresh = crypto.randomBytes(16).toString('hex');
  let fd;
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow;
    fd = fs.openSync(idFile, flags, 0o600);
    fs.writeSync(fd, fresh);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      const raced = readWorkspaceIdFile(dotEvolverDir, idFile);
      return raced.ok ? raced.id : null;
    }
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
  }

  try {
    fs.chmodSync(idFile, 0o600);
  } catch {
  }
  return fresh;
}

/**
 * Where a workspace's id lives now: beside the capture state, under the user's home,
 * keyed by the workspace root. The id is our bookkeeping, not the user's source — writing
 * it into their repository made every Evolver user carry an untracked `.evolver/` they
 * had to gitignore.
 */
export function workspaceIdPath(workspaceRoot) {
  const key = crypto.createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16);
  return path.join(os.homedir(), '.evolver', 'state', `workspace-${key}`);
}

export function resolveWorkspaceId(projectDir) {
  try {
    const fromEnv = process.env.EVOLVER_WORKSPACE_ID;
    if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;

    const workspaceRoot = computeWorkspaceRoot(projectDir);
    const homeFile = workspaceIdPath(workspaceRoot);
    const homeDir = path.dirname(homeFile);

    const stored = readWorkspaceIdFile(homeDir, homeFile);
    if (stored.ok) return stored.id;
    if (!stored.missing) return null;

    // An id minted by an earlier version still keys that workspace's memory rows. Adopt it
    // rather than minting a fresh one, or every existing user's recall silently goes empty.
    const legacyDir = path.join(workspaceRoot, '.evolver');
    const legacy = readWorkspaceIdFile(legacyDir, path.join(legacyDir, 'workspace-id'));
    if (legacy.ok) {
      adoptWorkspaceId(homeDir, homeFile, legacy.id);
      return legacy.id;
    }

    return createWorkspaceIdFile(homeDir, homeFile);
  } catch {
    return null;
  }
}

/** Copy a legacy id to its new home. Best effort: the legacy file still answers if this fails. */
function adoptWorkspaceId(homeDir, homeFile, id) {
  try {
    fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(homeFile, id, { mode: 0o600, flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}
