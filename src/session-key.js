// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

export function sessionKeyOf(subject) {
  const identity = subject?.session?.id ?? subject?.id;
  return identity !== null && identity !== undefined && String(identity).length > 0 ? String(identity) : null;
}
