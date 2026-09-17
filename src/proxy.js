// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_PORT = '19820';

function isLoopbackHost(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '[::1]' || value === '::1' || value.endsWith('.localhost');
}

export function normalizeLoopbackUrl(value) {
  try {
    const parsed = new URL(String(value));
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (!isLoopbackHost(parsed.hostname) || parsed.username || parsed.password) return null;
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function isLoopbackUrl(value) {
  return normalizeLoopbackUrl(value) !== null;
}

function readProxySettings(port) {
  let url = null;
  let token = null;
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), '.evolver', 'settings.json'), 'utf8'));
    if (settings?.proxy?.url) url = normalizeLoopbackUrl(settings.proxy.url);
    if (settings?.proxy?.token) token = String(settings.proxy.token);
  } catch {
  }
  return { url: url ?? `http://127.0.0.1:${port}`, token };
}

const START_HINT =
  'Start it by running `evolver` once inside a git repo (the CLI launches the Proxy). ' +
  'Set EVOMAP_PROXY_PORT if you use a non-default port.';

function httpErrorHint(status, base, token) {
  if (status === 401 || status === 403) {
    return token
      ? ' The Proxy token in ~/.evolver/settings.json was rejected; restart Evolver so it writes fresh settings.'
      : ` No Proxy token was found and the request was rejected — another process may be using ${base}. ${START_HINT}`;
  }
  if (status === 404) return ` Endpoint not found at ${base} — upgrade or verify the Evolver Proxy.`;
  return '';
}

export function createProxyClient({
  port = process.env.EVOMAP_PROXY_PORT || DEFAULT_PORT,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  return async function proxyFetch(method, requestPath, body, callerSignal) {
    const { url: base, token } = readProxySettings(port);
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;

    let response;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
      response = await fetch(base + requestPath, {
        method,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (callerSignal?.aborted) return { ok: false, error: 'Proxy request cancelled.' };
      const what = error?.name === 'TimeoutError' ? 'Proxy request timed out' : `Proxy connection failed: ${error?.message}`;
      return { ok: false, error: `${what}. Evolver Proxy not reachable at ${base}. ${START_HINT}` };
    }

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      return {
        ok: false,
        error:
          `Proxy at ${base} returned HTTP ${response.status}: ${JSON.stringify(data)}.` +
          httpErrorHint(response.status, base, token),
      };
    }
    return { ok: true, data };
  };
}
