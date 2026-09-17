// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

export function sessionKeyOf(subject, projectDir) {
  if (typeof subject === 'string' && subject.length > 0) return subject;
  const identity = subject?.session?.id ?? subject?.id;
  if (identity !== null && identity !== undefined && String(identity).length > 0) return String(identity);
  return projectDir ? `workspace:${projectDir}` : null;
}
