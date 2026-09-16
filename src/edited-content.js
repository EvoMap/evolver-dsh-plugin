// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

export const EDIT_TOOL_NAMES = ['write', 'edit', 'str_replace_editor'];

const CONTENT_KEYS = ['content', 'new_string', 'new_str', 'file_text', 'text'];
const PATH_KEYS = ['path', 'file_path'];

function firstString(args, keys) {
  for (const key of keys) {
    if (typeof args?.[key] === 'string' && args[key].length > 0) return args[key];
  }
  return '';
}

export function editedContent(args) {
  return firstString(args, CONTENT_KEYS);
}

export function editedPath(args) {
  return firstString(args, PATH_KEYS);
}
