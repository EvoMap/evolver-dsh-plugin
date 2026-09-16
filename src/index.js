// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';

import { captureOutcome } from './capture.js';
import { evolverCommands } from './commands.js';
import { EDIT_TOOL_NAMES, editedContent, editedPath } from './edited-content.js';
import { recallText } from './recall.js';
import { evolverSkillProvider } from './skill.js';
import { detectSignals } from './signals.js';
import { createProxyClient } from './proxy.js';
import { evolverTools } from './tools.js';
import { isGitWorkspace, resolveProjectDir } from './workspace.js';

export const name = 'evolver';

// Cordis v4 `inject` is a plain service list; `skills` and `commands` are
// optional, so they are awaited through ctx.inject() inside apply() instead.
export const inject = ['tools'];

const NONGIT_NOTICE =
  '[Evolver] This folder is not a git repository, so evolution memory is inactive ' +
  '(outcomes are derived from git diffs). Run `git init` here, or open a git project, ' +
  'to enable recall and recording.';

function pluginMessage(text, formed) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'evolver', ...formed },
  });
}

// dsh renamed the per-agent startup seam: 0.1.5 fires 'agent/session-start',
// 0.1.6 folds it into 'agent/created'. Subscribing to both keeps one build
// working across the rc and alpha lines; a runtime carrying both must still
// seed only once.
const STARTUP_EVENTS = ['agent/created', 'agent/session-start'];

function seedRecall(ctx, projectDir) {
  const seeded = new WeakSet();

  const seed = ({ agent }) => {
    if (seeded.has(agent)) return;
    seeded.add(agent);

    const parts = [];
    if (!isGitWorkspace(projectDir)) parts.push(NONGIT_NOTICE);

    const memory = recallText(projectDir);
    if (memory) parts.push(memory);

    if (parts.length > 0) agent.inject(pluginMessage(parts.join('\n\n'), { form: 'recall' }));
  };

  for (const event of STARTUP_EVENTS) ctx.on(event, seed);
}

function nudgeOnSignals(ctx, editToolNames) {
  ctx.on('tools/result', (exec) => {
    if (!exec.agent || !editToolNames.includes(exec.name)) return;

    const signals = detectSignals(editedContent(exec.arguments));
    if (signals.length === 0) return;

    const where = editedPath(exec.arguments) || 'edited file';
    exec.agent.inject(
      pluginMessage(
        `[Evolution Signal] Detected: [${signals.join(', ')}] in ${where}. Consider recording this outcome.`,
        { form: 'notice', summary: boundContextSummary(`Evolution signal: ${signals.join(', ')}`) },
      ),
    );
  });
}

function captureOnTurnEnd(ctx, projectDir) {
  ctx.on('session/event', (_session, event) => {
    if (event.type !== 'turn/end' || event.data.reason.kind !== 'completed') return;
    // Fire and forget: a turn boundary must not wait on git or the Hub.
    captureOutcome(projectDir).catch(() => {});
  });
}

export function apply(ctx, config = {}) {
  const projectDir = config.projectDir ?? resolveProjectDir();
  const proxyFetch = createProxyClient({ port: config.proxyPort });

  for (const tool of evolverTools(proxyFetch)) ctx.tools.register(tool);

  ctx.inject(['skills'], (scoped) => {
    scoped.skills.registerProvider(() => evolverSkillProvider);
  });

  ctx.inject(['commands'], (scoped) => {
    for (const command of evolverCommands()) scoped.commands.register(command);
  });

  seedRecall(ctx, projectDir);
  nudgeOnSignals(ctx, config.editToolNames ?? EDIT_TOOL_NAMES);
  captureOnTurnEnd(ctx, projectDir);
}
