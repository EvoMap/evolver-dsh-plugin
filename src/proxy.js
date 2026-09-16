// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_PORT = '19820';

// ~/.evolver/settings.json is authoritative: the running Proxy writes both its
// url and a per-instance auth token there, and the token rotates on every Proxy
// restart — so re-read it per call and never log or echo it.
function readProxySettings(port) {
  let url = null;
  let token = null;
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), '.evolver', 'settings.json'), 'utf8'));
    if (settings?.proxy?.url) url = String(settings.proxy.url).replace(/\/+$/, '');
    if (settings?.proxy?.token) token = String(settings.proxy.token);
  } catch {
    // not running or unreadable
  }
  return { url: url ?? `http://127.0.0.1:${port}`, token };
}

const START_HINT =
  'Start it by running `evolver` once inside a git repo (the CLI launches the Proxy). ' +
  'Set EVOMAP_PROXY_PORT if you use a non-default port.';

function httpErrorHint(status, base, token) {
  if (status === 401 || status === 403) {
    return token
      ? ` The Proxy token in ~/.evolver/settings.json looks stale (the Proxy mints a fresh one on restart); restart this dsh session so the plugin re-reads it.`
      : ` No Proxy token found in ~/.evolver/settings.json and the request was rejected — another process may be using ${base}. ${START_HINT}`;
  }
  if (status === 404) return ` Endpoint not found at ${base} — it may not be the Evolver Proxy.`;
  return '';
}

export function createProxyClient({ port = process.env.EVOMAP_PROXY_PORT || DEFAULT_PORT } = {}) {
  return async function proxyFetch(method, path, body) {
    const { url: base, token } = readProxySettings(port);
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;

    let response;
    try {
      response = await fetch(base + path, {
        method,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
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
