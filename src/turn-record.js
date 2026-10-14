// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import path from 'node:path';

import { editedContent, editedPath } from './edited-content.js';
import { contentHashOf } from './retention-pending.js';
import { checkCommandOf, verificationFailed } from './verification.js';

const TURN_EDITED_MAX_CHARS = 200_000;
const CHECK_COMMAND_MAX_CHARS = 200;
const PATH_KEYS = ['path', 'file_path'];

function freshTurnRecord() {
  return { notices: new Set(), checks: [], commands: [], paths: [], edits: [], editedChars: 0, editedBefore: new Map(), answer: '' };
}

export function createTurnRecords() {
  const records = new Map();
  return {
    of(sessionKey) {
      let record = records.get(sessionKey);
      if (!record) {
        record = freshTurnRecord();
        records.set(sessionKey, record);
      }
      return record;
    },
    take(sessionKey) {
      const record = records.get(sessionKey) ?? freshTurnRecord();
      records.delete(sessionKey);
      return record;
    },
    forget(sessionKey) {
      records.delete(sessionKey);
    },
  };
}

export function noteFileBeforeEdit(record, projectDir, args) {
  const edited = editedPath(args);
  if (!edited) return;
  const file = path.resolve(projectDir, edited);
  if (!record.editedBefore.has(file)) record.editedBefore.set(file, contentHashOf(file));
}

function noteEditedContent(record, args) {
  const kept = editedContent(args).slice(0, TURN_EDITED_MAX_CHARS - record.editedChars);
  if (!kept) return;
  record.edits.push(kept);
  record.editedChars += kept.length;
}

export function noteToolResult(record, exec, result, { isEdit }) {
  const args = exec.arguments ?? {};
  if (typeof args.command === 'string') record.commands.push(args.command);
  for (const key of PATH_KEYS) if (typeof args[key] === 'string') record.paths.push(args[key]);
  const check = checkCommandOf(exec);
  if (check) record.checks.push({ command: check.slice(0, CHECK_COMMAND_MAX_CHARS), failed: verificationFailed(result) });
  if (isEdit && !result?.isError) noteEditedContent(record, args);
}

export function noteAnswer(record, message) {
  const text = (message?.content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
  if (text) record.answer = text;
}
