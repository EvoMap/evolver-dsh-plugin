import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import semver from 'semver';

const { peerDependencies } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const DSH_PACKAGES = ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-tools'];

// npm and pnpm check peers without includePrerelease, so a prerelease only
// matches a comparator on its own major.minor.patch: every dsh line needs a branch.
const accepts = (version, range) => semver.satisfies(version, range);

test('dsh peers accept every dsh line the plugin runs on, prereleases included', () => {
  for (const version of ['0.1.5-rc.3', '0.1.5', '0.2.0-rc.2', '0.2.0', '0.2.1-alpha.5', '0.2.1-rc.2', '0.2.1']) {
    for (const name of DSH_PACKAGES) assert.equal(accepts(version, peerDependencies[name]), true, `${name}@${version}`);
  }
});

test('dsh peers still refuse lines older than 0.1.5', () => {
  for (const version of ['0.1.1-rc.2', '0.1.4']) {
    for (const name of DSH_PACKAGES) assert.equal(accepts(version, peerDependencies[name]), false, `${name}@${version}`);
  }
});

test('the cordis peer accepts the cordis each dsh line pins', () => {
  for (const version of ['4.0.1-rc.4', '4.0.4', '4.0.5-alpha.2', '4.0.5']) {
    assert.equal(accepts(version, peerDependencies['@deepseek-ai/cordis']), true, version);
  }
});
